import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const alerts = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/alerts.json", import.meta.url)));
const evidence = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/evidence.json", import.meta.url)));
const cases = JSON.parse(fs.readFileSync(new URL("../mock-upstream/fixtures/cases.json", import.meta.url)));

test("fixtures cover attack, false positive, insufficient evidence and retrospective case", () => {
  assert.ok(alerts.length >= 3);
  assert.ok(cases.some((item) => item.decision === "REAL_ATTACK"));
  assert.ok(cases.some((item) => item.decision === "SUSPECTED_FALSE_POSITIVE"));
  assert.ok(cases.some((item) => item.decision === "INSUFFICIENT_EVIDENCE"));
  for (const alert of alerts) assert.ok(evidence.some((item) => item.alert_id === alert.alert_id));
});

