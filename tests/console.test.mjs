import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

const children = [];
const origin = "http://127.0.0.1:18183";
const reportsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "alert-triage-console-reports-"));
const reportId = "a".repeat(64);
fs.writeFileSync(path.join(reportsDirectory, reportId + ".json"), JSON.stringify({
  run_id: reportId, accepted: true, recorded_at: "2026-10-18T04:00:00Z",
  validation: { valid: true, errors: [] },
  report: { run_id: reportId, alert_id: "ALT-001", classification: "REAL_ATTACK", confidence: 0.94, explanation: "verified evidence", evidence_chain: [{ evidence_id: "EV-001", source: "mock-db", method: "QueryEvidence", observed_at: "2026-10-18T03:00:00Z", fact: "export" }], missing_evidence: [], next_actions: ["Escalate"], rule_hits: ["R004"], human_review_required: true, proposed_disposition: "ESCALATE_FOR_HUMAN_REVIEW", similar_case_ids: ["CASE-001"] },
  snapshot: { captured_at: "2026-10-18T04:00:00Z", evaluation: { recommendedClassification: "REAL_ATTACK", confidenceCeiling: 0.94, ruleHits: ["R004"], humanReviewRequired: true, autoCloseAllowed: false }, cases: { cases: [{ caseId: "CASE-001", decision: "REAL_ATTACK", disposition: "ESCALATE", confidence: 0.9 }] } },
  call_audit: [{ method: "QueryEvidence", grpc_code: "OK" }],
}), { mode: 0o600 });
before(async () => {
  children.push(spawn(process.execPath, [new URL("../mock-upstream/server.js", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")], {
    env: { ...process.env, PORT: "18182", BIND_HOST: "127.0.0.1" }, stdio: "ignore"
  }));
  children.push(spawn(process.execPath, [new URL("../scripts/serve-console.mjs", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")], {
    env: { ...process.env, CONSOLE_PORT: "18183", CONSOLE_UPSTREAM_URL: "http://127.0.0.1:18182", TRIAGE_REPORT_DIR: reportsDirectory }, stdio: "ignore"
  }));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(origin + "/api/healthz")).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("console did not start");
});
after(() => { children.forEach((child) => child.kill()); fs.rmSync(reportsDirectory, { recursive: true, force: true }); });

test("cloud console serves static assets and read-only data", async () => {
  assert.equal((await fetch(origin)).status, 200);
  assert.equal((await fetch(origin + "/app.js")).status, 200);
  const alerts = await (await fetch(origin + "/api/alerts")).json();
  assert.equal(alerts.alerts[0].alert_id, "ALT-001");
});
test("cloud console exposes a projected read-only report without raw runtime output", async () => {
  const list = await (await fetch(origin + "/api/reports")).json();
  assert.equal(list.reports[0].run_id, reportId);
  assert.equal(list.reports[0].classification, "REAL_ATTACK");
  const detail = await (await fetch(origin + "/api/reports/" + reportId)).json();
  assert.equal(detail.report.alert_id, "ALT-001");
  assert.equal(detail.similar_cases[0].case_id, "CASE-001");
  assert.equal("output" in detail, false);
});
test("cloud console does not forward writes or arbitrary API paths", async () => {
  assert.equal((await fetch(origin + "/api/dispositions", { method: "POST", body: "{}" })).status, 405);
  assert.equal((await fetch(origin + "/api/audit")).status, 404);
});
