// Real Connect RPC regression against a deployed OctoBus. No successful writes.
// Node 12-compatible so the cloud host needs no additional test dependencies.
import http from "http";
import assert from "assert";

const base = process.env.OCTOBUS_SMOKE_URL || "http://127.0.0.1:9000";
function rpc(method, request = {}, capset = "triage-read") {
  const url = new URL(`/capsets/${capset}/connect/alert-platform-demo/alert_triage.v1.AlertPlatformService/${method}`, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { data += part; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error("RPC timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(request));
  });
}

async function main() {
  const list = await rpc("ListAlerts", { pageSize: 20 });
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.alerts.every((item) => item.alertId && item.duplicateCount >= 1));
  assert.ok(list.body.queryTime);
  const expected = { "ALT-001": "REAL_ATTACK", "ALT-002": "SUSPECTED_FALSE_POSITIVE", "ALT-003": "INSUFFICIENT_EVIDENCE" };
  for (const [id, classification] of Object.entries(expected)) {
    const detail = await rpc("GetAlertDetail", { alertId: id });
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.alert.alertId, id);
    const evidence = await rpc("QueryEvidence", { alertId: id, limit: 100 });
    assert.strictEqual(evidence.status, 200);
    assert.strictEqual(evidence.body.recommendedClassification, classification);
    assert.ok(evidence.body.evidence.every((item) => item.evidenceId && item.observedAt));
    assert.notStrictEqual(evidence.body.autoCloseAllowed, true);
    const cases = await rpc("SearchSimilarCases", { alertId: id });
    assert.strictEqual(cases.status, 200);
    assert.ok((cases.body.cases || []).every((item) => item.caseId));
    if (id === "ALT-003") {
      assert.strictEqual(evidence.body.humanReviewRequired, true);
      assert.ok(evidence.body.confidenceCeiling <= 0.59);
      assert.ok(evidence.body.missingTypes.length > 0);
    }
    console.log(JSON.stringify({ test: id, status: "PASS", classification, evidence: evidence.body.evidence.length }));
  }
  const denied = await rpc("CreateDisposition", {});
  assert.ok([403, 404].includes(denied.status), `read-capset write was not denied: HTTP ${denied.status}`);
  console.log(JSON.stringify({ test: "read-capset-denies-write", status: "PASS", http: denied.status }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
