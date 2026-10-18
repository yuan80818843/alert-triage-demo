import { validateAgainstEvidence } from "../../agent/output-validator.mjs";
import { validRunId } from "../models/report_store.mjs";
import { ReceiverUnavailable } from "./platform_client.mjs";

const REQUIRED_METHODS = ["GetAlertDetail", "QueryEvidence", "SearchSimilarCases"];
const TERMINAL = new Set(["succeeded", "failed", "canceled", "skipped"]);
const LEAK = /(?:CAP_TOKEN|AGENT_COMPOSE_SANDBOX_TOKEN|LLM_API_KEY|OPENAI_API_KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{12,}|Authorization\s*:\s*Bearer\s+\S+/i;
const REJECTION_CODES = new Set(["RUN_ID_MISMATCH", "AGENT_EXECUTION_FAILED", "SCHEDULER_LINK_MISMATCH", "RUNTIME_CREDENTIAL_OUTPUT", "FINAL_JSON_INVALID", "REPORT_ALERT_ID_INVALID", "REPORT_VALIDATION_FAILED", "READ_AUDIT_MISSING", "DUPLICATE_EVIDENCE_RUN"]);

export function safeReason(result) {
  if (result.accepted) return "REPORT_ACCEPTED";
  const first = result.validation && result.validation.errors && result.validation.errors[0];
  return REJECTION_CODES.has(first) ? first : "REPORT_VALIDATION_FAILED";
}

function object(input) {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EXPECTED_OBJECT");
  return value;
}

function finalReport(run) { return object(object(run.result_json).finalText); }

export function assertSchedulerLink(outer, inner, runId) {
  const result = object(outer.result_json);
  const times = [outer.started_at, inner.started_at, inner.completed_at, outer.completed_at].map((value) => Date.parse(value));
  if (!validRunId(outer.run_id) || !validRunId(runId) || inner.id !== runId || inner.agent_name !== "triage" || inner.status !== "succeeded") throw new Error("LINK_MISMATCH");
  if (!validRunId(result.sandboxId) || result.sandboxId !== inner.sandbox_id || result.success !== true) throw new Error("LINK_MISMATCH");
  if (times.some((value) => !Number.isFinite(value)) || times.some((value, index) => index > 0 && value < times[index - 1])) throw new Error("LINK_MISMATCH");
  if (object(inner.result_json).finalText !== result.finalText) throw new Error("LINK_MISMATCH");
}

function auditForRun(run, entries) {
  const start = Date.parse(run.started_at), end = Date.parse(run.completed_at);
  return entries.filter((entry) => entry.protocol === "grpc" && entry.grpc_code === "OK" &&
    Date.parse(entry.ts) >= start && Date.parse(entry.ts) <= end && typeof entry.method === "string" &&
    REQUIRED_METHODS.some((method) => entry.method.replace(/^\//, "") === "alert_triage.v1.AlertPlatformService/" + method)
  ).map((entry) => ({ at: entry.ts, method: entry.method, grpc_code: "OK" }));
}

function rejection(runId, code) {
  return { run_id: runId, accepted: false, validation: { valid: false, errors: [code] } };
}

export async function collectAgent(runId, dependencies, outer = null) {
  if (!validRunId(runId)) throw new Error("INVALID_PLATFORM_ID");
  const { client, store } = dependencies;
  const run = await client.inspect(runId);
  if (run.id !== runId) return rejection(runId, "RUN_ID_MISMATCH");
  if (!TERMINAL.has(run.status)) throw new ReceiverUnavailable();
  if (run.status !== "succeeded") return rejection(runId, "AGENT_EXECUTION_FAILED");
  if (outer) {
    try { assertSchedulerLink(outer, run, runId); }
    catch (_) { return rejection(runId, "SCHEDULER_LINK_MISMATCH"); }
  }
  const existing = store.get(runId);
  if (existing) return existing;
  const reject = (code) => store.put(runId, rejection(runId, code)).artifact;
  let report;
  try {
    if (LEAK.test(run.output || "") || LEAK.test(object(run.result_json).finalText || "")) return reject("RUNTIME_CREDENTIAL_OUTPUT");
    report = finalReport(run);
  } catch (_) { return reject("FINAL_JSON_INVALID"); }
  if (!/^ALT-[A-Za-z0-9_-]+$/.test(report.alert_id || "")) return reject("REPORT_ALERT_ID_INVALID");
  const request = { alertId: report.alert_id };
  const detail = await client.rpc("GetAlertDetail", request);
  const evaluation = await client.rpc("QueryEvidence", { alertId: report.alert_id, limit: 100 });
  const cases = await client.rpc("SearchSimilarCases", request);
  const snapshot = { detail, evaluation, cases, captured_at: new Date().toISOString(), source: "post-run OctoBus read-only snapshot; immutable synthetic fixtures" };
  let validation;
  try { validation = validateAgainstEvidence(report, snapshot, runId); }
  catch (_) { throw new ReceiverUnavailable(); }
  if (!validation.valid) return reject("REPORT_VALIDATION_FAILED");
  const audit = auditForRun(run, await client.audit());
  if (REQUIRED_METHODS.some((method) => !audit.some((entry) => entry.method.endsWith("/" + method)))) return reject("READ_AUDIT_MISSING");
  try {
    return await store.withEvidenceLock(report.alert_id, report.evidence_chain.map((item) => item.evidence_id), async () => {
      const duplicate = store.findAcceptedByEvidence(report.alert_id, report.evidence_chain.map((item) => item.evidence_id), runId);
      if (duplicate) return reject("DUPLICATE_EVIDENCE_RUN");
      return store.put(runId, { run_id: runId, status: run.status, sandbox_id: run.sandbox_id,
        accepted: true, validation, report, snapshot, call_audit: audit }).artifact;
    });
  } catch (error) {
    if (error.code === "LOCK_TIMEOUT") throw new ReceiverUnavailable();
    throw error;
  }
}

export async function collectScheduler(outer, dependencies) {
  const { store } = dependencies;
  if (!validRunId(outer.run_id) || !TERMINAL.has(outer.status)) return null;
  if (store.get(outer.run_id, true)) return null;
  let artifact = { scheduler_run_id: outer.run_id, trigger_source: /^(manual|interval:\d+)$/.test(outer.trigger_source) ? outer.trigger_source : "other",
    platform_status: outer.status, recorded_at: new Date().toISOString(), accepted: false };
  if (outer.status !== "succeeded") artifact.reason = "SCHEDULER_" + outer.status.toUpperCase();
  else {
    let runId;
    try { runId = finalReport(outer).run_id; }
    catch (_) { artifact.reason = "FINAL_JSON_INVALID"; }
    if (!artifact.reason && !validRunId(runId)) artifact.reason = "REPORT_RUN_ID_INVALID";
    if (!artifact.reason) {
      const result = await collectAgent(runId, dependencies, outer);
      artifact = Object.assign(artifact, { run_id: runId, accepted: result.accepted,
        reason: safeReason(result) });
    }
  }
  const result = store.put(outer.run_id, artifact, true);
  return result.created ? result.artifact : null;
}

export async function collectPending(dependencies, config, now = Date.now()) {
  const rows = await dependencies.client.list();
  if (!Array.isArray(rows)) throw new ReceiverUnavailable();
  const events = [];
  for (const row of rows) {
    if (!validRunId(row.run_id) || !TERMINAL.has(row.status)) continue;
    const time = Date.parse(row.completed_at || row.started_at);
    if (!Number.isFinite(time) || time > now || time < now - config.lookbackMs) continue;
    try {
      const result = await collectScheduler(row, dependencies);
      if (result) events.push(result);
    } catch (_) {
      // A transient failure is not a persisted rejection and must not starve
      // independent completed runs. A later pass can retry within lookback.
      events.push({ scheduler_run_id: row.run_id, accepted: false, reason: "PLATFORM_READ_UNAVAILABLE", retry: true });
    }
  }
  return events;
}
