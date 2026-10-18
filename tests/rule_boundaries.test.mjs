import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { _test } from "../octobus-services/demo__alert-platform/src/alert-platform.js";

const alerts = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/alerts.json", import.meta.url)));
const evidence = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/evidence.json", import.meta.url)));
const copy = (value) => JSON.parse(JSON.stringify(value));
const sample = (id) => ({ alert: copy(alerts.find((item) => item.alert_id === id)), evidence: copy(evidence.filter((item) => item.alert_id === id)) });

test("expired evidence cannot still trigger real-attack classification", () => {
  const f = sample("ALT-001");
  const result = _test.evaluateFinding(f.alert, f.evidence, { now: Date.parse("2026-10-19T03:00:00Z") });
  assert.equal(result.recommended_classification, "INSUFFICIENT_EVIDENCE");
  assert.ok(result.rule_hits.includes("R006"));
});

test("a correlation label cannot replace actual ten-minute timestamp computation", () => {
  const f = sample("ALT-001");
  f.evidence.find((item) => item.kind === "db_anomaly").observed_at = "2026-10-18T03:13:00Z";
  const result = _test.evaluateFinding(f.alert, f.evidence, { now: Date.parse("2026-10-18T04:00:00Z") });
  assert.equal(result.recommended_classification, "INSUFFICIENT_EVIDENCE");
});

test("an unknown signature cannot become false positive merely by saying allowlisted", () => {
  const f = sample("ALT-002"); f.alert.signature = "unknown-signature";
  const result = _test.evaluateFinding(f.alert, f.evidence, { now: Date.parse("2026-10-18T04:00:00Z") });
  assert.equal(result.recommended_classification, "INSUFFICIENT_EVIDENCE");
});

test("R002 does not group only two events", () => {
  const base = { asset_id: "asset-a", signature: "signature-a", source_class: "EXTERNAL", subject: "198.51.100.1", severity: "low" };
  const result = _test.dedupeAlerts([ { ...base, alert_id: "a", first_seen: "2026-10-18T01:00:00Z", last_seen: "2026-10-18T01:01:00Z" },
    { ...base, alert_id: "b", first_seen: "2026-10-18T01:02:00Z", last_seen: "2026-10-18T01:03:00Z" } ]);
  assert.equal(result.length, 2);
});
