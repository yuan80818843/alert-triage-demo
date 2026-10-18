import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { handlers } from "../octobus-services/demo__alert-platform/src/alert-platform.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(root, "..", "mock-upstream", "server.js");
const port = 18181;
let child;
const auditPath = path.join(os.tmpdir(), `alert-triage-integration-${process.pid}.log`);
const ctx = { config: { upstreamBaseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000, maxPageSize: 100, evaluationTime: "2026-10-18T04:00:00Z" } };
const call = (name, request) => handlers[name]({ request, config: ctx.config });

before(async () => {
  assert.equal(existsSync(serverFile), true);
  child = spawn(process.execPath, [serverFile], { env: { ...process.env, PORT: String(port), AUDIT_LOG_PATH: auditPath }, stdio: "ignore" });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error("mock upstream did not start");
});

after(() => { child?.kill(); rmSync(auditPath, { force: true }); });

test("handlers expose three deterministic triage outcomes", async () => {
  const method = "alert_triage.v1.AlertPlatformService/QueryEvidence";
  const attack = await call(method, { alert_id: "ALT-001" });
  const noise = await call(method, { alert_id: "ALT-002" });
  const missing = await call(method, { alert_id: "ALT-003" });
  assert.equal(attack.recommendedClassification, "REAL_ATTACK");
  assert.equal(noise.recommendedClassification, "SUSPECTED_FALSE_POSITIVE");
  assert.equal(missing.recommendedClassification, "INSUFFICIENT_EVIDENCE");
});

test("RPC responses retain protobuf camelCase IDs and nested evidence fields", async () => {
  const prefix = "alert_triage.v1.AlertPlatformService/";
  const list = await call(prefix + "ListAlerts", {});
  assert.equal(list.alerts[0].alertId, "ALT-001");
  assert.equal(list.alerts[0].duplicateCount, 1);
  assert.ok(list.queryTime);
  const detail = await call(prefix + "GetAlertDetail", { alertId: "ALT-001" });
  assert.equal(detail.alert.alertId, "ALT-001");
  const result = await call(prefix + "QueryEvidence", { alertId: "ALT-001" });
  assert.equal(result.evidence[0].evidenceId, "EV-001");
  assert.ok(result.evidence[0].observedAt);
  assert.equal(result.humanReviewRequired, true);
  assert.ok(result.confidenceCeiling > 0);
  const cases = await call(prefix + "SearchSimilarCases", { alertId: "ALT-001" });
  assert.ok(cases.cases[0].caseId);
});

test("create disposition requires approval and matching evidence", async () => {
  const request = {
    alert_id: "ALT-001",
    classification: "REAL_ATTACK",
    confidence: 0.9,
    evidence_ids: ["EV-001", "EV-002", "EV-003", "EV-004", "EV-005", "EV-006"],
    proposed_disposition: "ESCALATE",
    next_actions: ["Escalate to the human reviewer"],
    human_approval_id: "APR-001",
    approved_by: "interviewer",
    approved_at: "2026-10-18T04:00:00Z",
    idempotency_key: "demo-alt-001-1"
  };
  const result = await call("alert_triage.v1.AlertPlatformService/CreateDisposition", request);
  const replay = await call("alert_triage.v1.AlertPlatformService/CreateDisposition", request);
  assert.equal(result.status, "RECORDED");
  assert.equal(replay.dispositionId, result.dispositionId);
});

test("input boundaries reject reversed ranges, invalid pages and invalid confidence", async () => {
  await assert.rejects(() => call("alert_triage.v1.AlertPlatformService/ListAlerts", {
    startTime: "2026-10-18T04:00:00Z", endTime: "2026-10-18T03:00:00Z"
  }), (error) => error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => call("alert_triage.v1.AlertPlatformService/ListAlerts", { pageSize: -1 }), (error) => error.code === "INVALID_ARGUMENT");
  await assert.rejects(() => call("alert_triage.v1.AlertPlatformService/CreateDisposition", {
    alertId: "ALT-001", classification: "REAL_ATTACK", confidence: 2
  }), (error) => error.code === "INVALID_ARGUMENT");
});

