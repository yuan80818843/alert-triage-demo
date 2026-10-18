import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(root, "output-schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

export function validateOutput(value, evidenceIds = new Set(), caseIds = new Set()) {
  if (!validateSchema(value)) return { valid: false, errors: validateSchema.errors.map((item) => `${item.instancePath || "/"} ${item.message}`) };
  const errors = [];
  const seen = new Set();
  for (const item of value.evidence_chain) {
    if (!item.evidence_id || !evidenceIds.has(item.evidence_id)) errors.push(`unknown evidence_id ${item.evidence_id || ""}`);
    if (seen.has(item.evidence_id)) errors.push(`duplicate evidence_id ${item.evidence_id}`);
    seen.add(item.evidence_id);
  }
  for (const id of value.similar_case_ids || []) if (!caseIds.has(id)) errors.push(`unknown case_id ${id}`);
  if (/(CLOSE|SUPPRESS)/i.test(value.proposed_disposition)) errors.push("read-only report cannot close or suppress");
  if (value.classification === "INSUFFICIENT_EVIDENCE" && (!value.human_review_required || value.missing_evidence.length === 0)) errors.push("insufficient evidence requires missing evidence and human review");
  return { valid: errors.length === 0, errors };
}

// The caller supplies an independent, read-only OctoBus snapshot, never sets
// assembled from the model's own claims. Do not silently repair bad reports.
export function validateAgainstEvidence(report, snapshot, runId) {
  const evidence = snapshot.evaluation.evidence || [];
  const cases = snapshot.cases.cases || [];
  const result = validateOutput(report, new Set(evidence.map((item) => item.evidenceId)), new Set(cases.map((item) => item.caseId)));
  if (!result.valid) return result;
  const errors = result.errors;
  const gate = snapshot.evaluation;
  const actions = { REAL_ATTACK: ["ESCALATE", "ESCALATE_FOR_HUMAN_REVIEW"], SUSPECTED_FALSE_POSITIVE: ["HOLD_FOR_REVIEW"], INSUFFICIENT_EVIDENCE: ["REQUEST_MORE_EVIDENCE"] };
  if (!actions[report.classification].includes(report.proposed_disposition)) errors.push("proposed disposition conflicts with classification safety policy");
  if (report.run_id !== runId) errors.push("run_id does not match platform run");
  if (report.alert_id !== snapshot.detail.alert.alertId) errors.push("alert_id does not match platform evidence");
  if (report.classification !== gate.recommendedClassification) errors.push("classification conflicts with code gate");
  if (report.confidence > (gate.confidenceCeiling || 0)) errors.push("confidence exceeds code ceiling");
  if (gate.humanReviewRequired && !report.human_review_required) errors.push("human review cannot be removed");
  for (const field of [["missing_evidence", gate.missingTypes || []], ["rule_hits", gate.ruleHits || []]]) {
    if (JSON.stringify([...new Set(report[field[0]])].sort()) !== JSON.stringify([...new Set(field[1])].sort())) errors.push(field[0] + " conflicts with code gate");
  }
  for (const item of report.evidence_chain) {
    const source = evidence.find((entry) => entry.evidenceId === item.evidence_id);
    if (!source) continue;
    if (item.source !== source.sourceService || item.method !== source.method || item.fact !== source.fact || new Date(item.observed_at).getTime() !== new Date(source.observedAt).getTime()) errors.push("evidence provenance mismatch: " + item.evidence_id);
    if (source.alertId !== report.alert_id) errors.push("evidence belongs to a different alert");
  }
  return { valid: errors.length === 0, errors };
}

