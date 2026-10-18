import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOutput, validateAgainstEvidence } from "../agent/output-validator.mjs";

test("output validator rejects untraceable evidence", () => {
  const result = validateOutput({
    run_id: "run-1",
    alert_id: "ALT-003",
    classification: "INSUFFICIENT_EVIDENCE",
    confidence: 0.4,
    evidence_chain: [{ evidence_id: "EV-unknown", source: "x", method: "y", observed_at: "2026-01-01T00:00:00Z", fact: "z" }],
    missing_evidence: ["asset_identity"],
    next_actions: ["request asset"],
    rule_hits: ["R001"],
    human_review_required: true,
    proposed_disposition: "REQUEST_MORE_EVIDENCE"
  }, new Set(["EV-201"]), new Set(["CASE-004"]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.includes("unknown evidence_id")));
});

const report = () => ({ run_id: "run-1", alert_id: "ALT-001", classification: "REAL_ATTACK", confidence: 0.9,
  evidence_chain: [{ evidence_id: "EV-001", source: "mock-db", method: "QueryEvidence", observed_at: "2026-10-18T02:00:00Z", fact: "export exceeded threshold" }],
  missing_evidence: [], next_actions: ["Escalate to human"], rule_hits: ["R004"], human_review_required: true, proposed_disposition: "ESCALATE", similar_case_ids: ["CASE-001"] });
const snapshot = () => ({ detail: { alert: { alertId: "ALT-001" } },
  evaluation: { recommendedClassification: "REAL_ATTACK", confidenceCeiling: 0.94, humanReviewRequired: true, ruleHits: ["R004"],
    evidence: [{ evidenceId: "EV-001", alertId: "ALT-001", sourceService: "mock-db", method: "QueryEvidence", observedAt: "2026-10-18T02:00:00Z", fact: "export exceeded threshold" }] }, cases: { cases: [{ caseId: "CASE-001" }] } });

test("full JSON Schema rejects wrong arrays, invalid nested fields and nonfinite confidence", () => {
  for (const mutate of [
    (value) => { value.evidence_chain = "not-an-array"; },
    (value) => { value.evidence_chain[0].fact = 123; },
    (value) => { value.evidence_chain[0].observed_at = "not-a-time"; },
    (value) => { value.confidence = NaN; },
    (value) => { value.evidence_chain[0].extra = true; },
  ]) {
    const value = report(); mutate(value);
    assert.equal(validateOutput(value, new Set(["EV-001"]), new Set(["CASE-001"])).valid, false);
  }
});

test("independent evidence gate accepts exact provenance and rejects model changes", () => {
  assert.equal(validateAgainstEvidence(report(), snapshot(), "run-1").valid, true);
  for (const mutate of [
    (value) => { value.evidence_chain[0].fact = "invented success"; },
    (value) => { value.run_id = "invented-run"; },
    (value) => { value.confidence = 0.99; },
    (value) => { value.human_review_required = false; },
    (value) => { value.classification = "SUSPECTED_FALSE_POSITIVE"; },
    (value) => { value.rule_hits = ["invented-rule"]; },
    (value) => { value.missing_evidence = ["invented-missing"]; },
  ]) {
    const value = report(); mutate(value);
    assert.equal(validateAgainstEvidence(value, snapshot(), "run-1").valid, false);
  }
});

test("read-only and insufficient-evidence reports cannot hide a closure", () => {
  for (const disposition of ["CLOSE", "AUTO_CLOSE", "SUPPRESS", "suppress_pending_review"]) {
    const value = report(); value.proposed_disposition = disposition;
    assert.equal(validateOutput(value, new Set(["EV-001"]), new Set(["CASE-001"])).valid, false);
  }
  const value = report(); value.classification = "INSUFFICIENT_EVIDENCE"; value.human_review_required = false;
  assert.equal(validateOutput(value, new Set(["EV-001"]), new Set(["CASE-001"])).valid, false);
});

