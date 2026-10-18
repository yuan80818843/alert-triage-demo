import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { _test } from "../octobus-services/demo__alert-platform/src/alert-platform.js";

test("dedupe groups at least three safe alerts and keeps the highest severity", () => {
  const base = { asset_id: "x", signature: "s", source_class: "EXTERNAL", subject: "198.51.100.2", severity: "low", facts: { successful_auth: false, privilege_change: false, new_external_source: false } };
  const result = _test.dedupeAlerts([0, 1, 2].map((index) => ({ ...base, alert_id: String(index), severity: index === 1 ? "high" : "low", first_seen: `2026-01-01T00:0${index}:00Z`, last_seen: `2026-01-01T00:0${index}:30Z` })));
  assert.equal(result.length, 1);
  assert.equal(result[0].duplicate_count, 3);
  assert.equal(result[0].severity, "high");
  assert.deepEqual(result[0].group_member_ids, ["0", "1", "2"]);
});

test("incomplete evidence cannot be auto-closed", () => {
  const evaluation = _test.evaluateFinding({ source_class: "UNKNOWN" }, [{ kind: "alert_detail", integrity: "verified" }]);
  assert.equal(evaluation.recommended_classification, "INSUFFICIENT_EVIDENCE");
  assert.equal(evaluation.auto_close_allowed, false);
  assert.ok(evaluation.rule_hits.includes("R001"));
});

test("external database anomaly is escalated", () => {
  const alert = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/alerts.json", import.meta.url))).find((item) => item.alert_id === "ALT-001");
  const evidence = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/evidence.json", import.meta.url))).filter((item) => item.alert_id === "ALT-001");
  const evaluation = _test.evaluateFinding(alert, evidence, { now: Date.parse("2026-10-18T04:00:00Z") });
  assert.equal(evaluation.recommended_classification, "REAL_ATTACK");
  assert.ok(evaluation.rule_hits.includes("R004"));
  assert.equal(evaluation.human_review_required, true);
});

