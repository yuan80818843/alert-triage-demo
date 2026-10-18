import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ReportStore } from "../app/models/report_store.mjs";
import { receiverConfig } from "../app/config.mjs";
import { collectAgent, collectScheduler, collectPending, safeReason } from "../app/services/report_collector.mjs";

const innerId = "a".repeat(64), outerId = "b".repeat(64), sandboxId = "c".repeat(64);
const now = Date.parse("2026-10-18T12:00:04Z");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "triage-receiver-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = { run_id: innerId, alert_id: "ALT-001", classification: "REAL_ATTACK", confidence: 0.9,
    evidence_chain: [{ evidence_id: "EV-001", source: "mock-db", method: "QueryEvidence", observed_at: "2026-10-18T12:00:00Z", fact: "export exceeded threshold" }],
    missing_evidence: [], next_actions: ["Escalate to human"], rule_hits: ["R004"], human_review_required: true,
    proposed_disposition: "ESCALATE_FOR_HUMAN_REVIEW", similar_case_ids: ["CASE-001"] };
  const run = { id: innerId, sandbox_id: sandboxId, agent_name: "triage", status: "succeeded",
    started_at: "2026-10-18T12:00:01Z", completed_at: "2026-10-18T12:00:02Z", output: "private trace not for export" };
  const outer = { run_id: outerId, status: "succeeded", started_at: "2026-10-18T12:00:00Z", completed_at: "2026-10-18T12:00:03Z", trigger_source: "interval:60000" };
  const sync = () => {
    run.result_json = JSON.stringify({ finalText: JSON.stringify(report) });
    outer.result_json = JSON.stringify({ finalText: JSON.stringify(report), sandboxId, success: true });
  };
  sync();
  const calls = [];
  const client = {
    inspect: async () => run,
    list: async () => [outer],
    rpc: async (method) => {
      calls.push(method);
      if (method === "GetAlertDetail") return { alert: { alertId: "ALT-001" } };
      if (method === "SearchSimilarCases") return { cases: [{ caseId: "CASE-001" }] };
      return { recommendedClassification: "REAL_ATTACK", confidenceCeiling: 0.94, humanReviewRequired: true, ruleHits: ["R004"], evidence: [
        { evidenceId: "EV-001", alertId: "ALT-001", sourceService: "mock-db", method: "QueryEvidence", observedAt: "2026-10-18T12:00:00Z", fact: "export exceeded threshold" },
      ] };
    },
    audit: async () => ["GetAlertDetail", "QueryEvidence", "SearchSimilarCases"].map((method) =>
      ({ protocol: "grpc", grpc_code: "OK", ts: "2026-10-18T12:00:01.500Z", method: "alert_triage.v1.AlertPlatformService/" + method })),
  };
  return { report, run, outer, sync, calls, directory, client, store: new ReportStore(directory) };
}

test("automatic acceptance uses independent evidence and is idempotent after receiver restart", async (t) => {
  const f = fixture(t);
  const result = await collectScheduler(f.outer, f);
  assert.equal(result.accepted, true);
  assert.equal(result.trigger_source, "interval:60000");
  assert.equal(f.store.get(innerId).accepted, true);
  assert.deepEqual(f.calls, ["GetAlertDetail", "QueryEvidence", "SearchSimilarCases"]);
  assert.equal(await collectScheduler(f.outer, { ...f, store: new ReportStore(f.directory) }), null);
  assert.equal(f.calls.length, 3);
  const serialized = fs.readFileSync(f.store.location(innerId), "utf8");
  assert.ok(!serialized.includes(f.run.output));
});

test("a later scheduler run with the same alert and evidence is rejected as a duplicate", async (t) => {
  const f = fixture(t);
  assert.equal((await collectScheduler(f.outer, f)).accepted, true);
  const secondInner = "d".repeat(64), secondOuter = "e".repeat(64);
  f.report.run_id = secondInner;
  f.run.id = secondInner;
  f.outer.run_id = secondOuter;
  f.sync();
  const result = await collectScheduler(f.outer, f);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "DUPLICATE_EVIDENCE_RUN");
  assert.equal(f.store.get(secondInner).validation.errors[0], "DUPLICATE_EVIDENCE_RUN");
});

test("report store cannot clobber committed results or escape the report directory", (t) => {
  const f = fixture(t);
  f.store.put(innerId, { accepted: true });
  assert.equal(f.store.put(innerId, { accepted: false }).created, false);
  assert.equal(f.store.get(innerId).accepted, true);
  assert.throws(() => f.store.get("../private"));
  assert.equal(fs.readdirSync(f.directory).filter((name) => name.endsWith(".pending")).length, 0);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.store.location(innerId)).mode & 0o777, 0o600);
});

test("evidence lock serializes independent node processes", async (t) => {
  const f = fixture(t);
  const moduleUrl = pathToFileURL(path.resolve("app/models/report_store.mjs")).href;
  const childSource = `import { ReportStore } from ${JSON.stringify(moduleUrl)};
const store = new ReportStore(process.argv[1]);
await store.withEvidenceLock("ALT-LOCK", ["EV-LOCK"], async () => {
  process.stdout.write("locked\\n");
  await new Promise((resolve) => setTimeout(resolve, 180));
});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, f.directory], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child lock acquisition timeout")), 2000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", () => {});
  });
  const started = Date.now();
  const result = await f.store.withEvidenceLock("ALT-LOCK", ["EV-LOCK"], async () => "second", { timeoutMs: 2000, retryMs: 5 });
  assert.equal(result, "second");
  assert.ok(Date.now() - started >= 100);
  await new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("child exited " + code))));
  assert.equal(fs.existsSync(f.store.evidenceLockLocation("ALT-LOCK", ["EV-LOCK"])), false);
});

test("stale evidence lock is recovered and a failed callback releases it", async (t) => {
  const f = fixture(t);
  const lockDirectory = f.store.evidenceLockLocation("ALT-STALE", ["EV-STALE"]);
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.writeFileSync(path.join(lockDirectory, "owner.json"), JSON.stringify({ pid: 1, token: "stale" }));
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(lockDirectory, old, old);
  assert.equal(await f.store.withEvidenceLock("ALT-STALE", ["EV-STALE"], async () => "recovered", { staleMs: 100 }), "recovered");
  assert.equal(fs.existsSync(lockDirectory), false);
  await assert.rejects(() => f.store.withEvidenceLock("ALT-FAIL", ["EV-FAIL"], async () => { throw new Error("callback failed"); }));
  assert.equal(fs.existsSync(f.store.evidenceLockLocation("ALT-FAIL", ["EV-FAIL"])), false);
  assert.equal(await f.store.withEvidenceLock("ALT-FAIL", ["EV-FAIL"], async () => "retry"), "retry");
});

test("scheduler link rejects another sandbox, mismatched final text, time or platform identity", async (t) => {
  for (const mutate of [
    (f) => { f.run.sandbox_id = "d".repeat(64); },
    (f) => { f.run.result_json = JSON.stringify({ finalText: "{}" }); },
    (f) => { f.run.started_at = "2026-10-18T11:59:59Z"; },
    (f) => { f.run.completed_at = "2026-10-18T12:00:05Z"; },
    (f) => { f.run.id = "d".repeat(64); },
    (f) => { f.run.agent_name = "unrelated-agent"; },
  ]) {
    const f = fixture(t); mutate(f);
    const result = await collectScheduler(f.outer, f);
    assert.equal(result.accepted, false);
    assert.equal(f.store.get(innerId), null);
    assert.equal(f.calls.length, 0);
  }
});

test("invalid JSON cannot be guessed from raw transcript", async (t) => {
  const f = fixture(t);
  f.run.result_json = JSON.stringify({ finalText: "```json\n{}\n```" });
  f.run.output = JSON.stringify(f.report);
  const result = await collectAgent(innerId, f);
  assert.deepEqual(result.validation.errors, ["FINAL_JSON_INVALID"]);
  assert.equal("report" in result, false);
});

test("outer invalid JSON is recorded without copying any model text", async (t) => {
  const f = fixture(t);
  f.outer.result_json = JSON.stringify({ finalText: "private malformed content" });
  const result = await collectScheduler(f.outer, f);
  assert.equal(result.reason, "FINAL_JSON_INVALID");
  assert.equal(JSON.stringify(result).includes("private malformed"), false);
});

test("fabricated evidence is rejected without storing model-provided validation strings", async (t) => {
  const f = fixture(t);
  f.report.evidence_chain[0].evidence_id = "untrusted-private-content"; f.sync();
  const result = await collectScheduler(f.outer, f);
  assert.equal(result.reason, "REPORT_VALIDATION_FAILED");
  const artifact = f.store.get(innerId);
  assert.equal("report" in artifact, false);
  assert.equal(JSON.stringify(artifact).includes("untrusted-private-content"), false);
});

test("credential-like runtime output causes rejection without exporting the fake value", async (t) => {
  const f = fixture(t);
  const fake = "FAKE_TEST_VALUE_NOT_A_SECRET";
  f.run.output = "CAP_TOKEN=" + fake;
  const result = await collectScheduler(f.outer, f);
  assert.equal(result.reason, "RUNTIME_CREDENTIAL_OUTPUT");
  assert.equal(JSON.stringify(f.store.get(innerId)).includes(fake), false);
  assert.equal(f.calls.length, 0);
});

test("temporary OctoBus outage leaves no terminal marker and can be retried", async (t) => {
  const f = fixture(t);
  const rpc = f.client.rpc;
  f.client.rpc = async () => { throw new Error("private upstream diagnostic"); };
  const first = await collectPending(f, { lookbackMs: 600000 }, now);
  assert.equal(first[0].retry, true);
  assert.equal(JSON.stringify(first).includes("private upstream"), false);
  assert.equal(f.store.get(innerId), null);
  assert.equal(f.store.get(outerId, true), null);
  f.client.rpc = rpc;
  assert.equal((await collectPending(f, { lookbackMs: 600000 }, now))[0].accepted, true);
});

test("missing, failed or out-of-window capability audit cannot produce accepted reports", async (t) => {
  for (const audit of [[], [{ protocol: "grpc", grpc_code: "INTERNAL", ts: "2026-10-18T12:00:01.500Z", method: "/alert_triage.v1.AlertPlatformService/QueryEvidence" }]]) {
    const f = fixture(t); f.client.audit = async () => audit;
    const result = await collectScheduler(f.outer, f);
    assert.equal(result.reason, "READ_AUDIT_MISSING");
  }
  const f = fixture(t); const read = f.client.audit;
  f.client.audit = async () => (await read()).map((entry) => ({ ...entry, ts: "2026-10-18T11:59:59Z" }));
  assert.equal((await collectScheduler(f.outer, f)).accepted, false);
});

test("audit accepts normalized leading slash and rejects unrelated services", async (t) => {
  const f = fixture(t); const read = f.client.audit;
  f.client.audit = async () => (await read()).map((entry) => ({ ...entry, method: "/" + entry.method }));
  assert.equal((await collectScheduler(f.outer, f)).accepted, true);
  const g = fixture(t); const other = g.client.audit;
  g.client.audit = async () => (await other()).map((entry) => ({ ...entry, method: entry.method.replace("alert_triage.v1", "unrelated.v1") }));
  assert.equal((await collectScheduler(g.outer, g)).reason, "READ_AUDIT_MISSING");
});

test("one inaccessible run does not prevent independent terminal run recording", async (t) => {
  const f = fixture(t);
  const otherId = "d".repeat(64);
  f.client.inspect = async () => { throw new Error("private platform diagnostic"); };
  f.client.list = async () => [f.outer, { ...f.outer, run_id: otherId, status: "failed" }];
  const events = await collectPending(f, { lookbackMs: 600000 }, now);
  assert.equal(events.length, 2);
  assert.equal(events[0].retry, true);
  assert.equal(events[1].reason, "SCHEDULER_FAILED");
  assert.equal(f.store.get(otherId, true).accepted, false);
});

test("failed, canceled and skipped scheduler runs are recorded but never accepted", async (t) => {
  for (const status of ["failed", "canceled", "skipped"]) {
    const f = fixture(t); f.outer.status = status;
    const result = await collectScheduler(f.outer, f);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "SCHEDULER_" + status.toUpperCase());
    assert.equal(f.calls.length, 0);
  }
});

test("observer ignores in-progress, stale and future runs", async (t) => {
  const f = fixture(t);
  f.client.list = async () => [{ ...f.outer, status: "running" },
    { ...f.outer, completed_at: "2026-10-17T00:00:00Z" }, { ...f.outer, completed_at: "2026-10-19T00:00:00Z" }];
  assert.deepEqual(await collectPending(f, { lookbackMs: 600000 }, now), []);
});

test("receiver configuration rejects public endpoints, credentials and invalid bounds", () => {
  for (const env of [{ OCTOBUS_SMOKE_URL: "http://example.com" }, { OCTOBUS_SMOKE_URL: "http://user:password@localhost" },
    { TRIAGE_COLLECT_INTERVAL_MS: "0" }, { TRIAGE_COLLECT_BATCH_LIMIT: "1000" }]) assert.throws(() => receiverConfig(env));
  assert.equal(receiverConfig({}).intervalMs, 15000);
  assert.equal(safeReason({ accepted: false, validation: { errors: ["private legacy diagnostic"] } }), "REPORT_VALIDATION_FAILED");
});
