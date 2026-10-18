import { knowledge } from "./knowledge.js";
import { checkEvidence } from "./evidence-quality.js";
import { isoMillis } from "./input.js";

export function evidenceCompleteness(evidence) {
  const kinds = new Set(evidence.map((entry) => entry.kind));
  const missing = knowledge.rules.R001.required_evidence.filter((kind) => !kinds.has(kind));
  return { complete: missing.length === 0, missing };
}

const isCritical = (alert) => Number(alert.asset_criticality) >= knowledge.rules.R005.criticality_min && alert.environment === "production";

function attackConfirmed(alert, entries) {
  if (alert.source_class !== "EXTERNAL" || !entries.some((entry) => entry.kind === "source_classification" && entry.facts?.source_class === "EXTERNAL")) return false;
  const auth = entries.filter((entry) => entry.kind === "behavior_log" && entry.source_service === "mock-auth" && entry.subject === alert.subject && entry.facts?.successful_auth === true);
  const anomalies = entries.filter((entry) => entry.kind === "db_anomaly" && entry.subject === alert.asset_id && entry.facts?.database_anomaly === true &&
    (entry.facts.privilege_change === true || (entry.facts.database_export === true && entry.facts.export_bytes > knowledge.rules.R004.min_export_bytes)));
  const correlations = entries.filter((entry) => entry.kind === "time_correlation" && entry.subject === alert.correlation_id);
  return auth.some((login) => anomalies.some((anomaly) => correlations.some((correlation) => {
    const start = isoMillis(login.observed_at), end = isoMillis(anomaly.observed_at), linked = isoMillis(correlation.observed_at);
    return login.correlation_id === anomaly.correlation_id && anomaly.correlation_id === correlation.correlation_id &&
      start <= end && end <= linked && linked - start <= knowledge.rules.R004.window_minutes * 60000;
  })));
}

function probeConfirmed(alert, entries) {
  if (alert.source_class !== "INTERNAL_PROBE" || isCritical(alert)) return false;
  const probe = knowledge.probes.find((item) => item.probe_id === alert.probe_id && item.signature === alert.signature && item.environments.includes(alert.environment));
  if (!probe || !entries.some((entry) => entry.kind === "source_classification" && entry.source_service === "mock-probe" &&
    entry.source_instance === alert.probe_id && entry.facts?.source_class === "INTERNAL_PROBE" && entry.facts?.probe_id === alert.probe_id && entry.facts?.signature === alert.signature)) return false;
  const adverse = entries.some((entry) => entry.kind === "db_anomaly" || entry.facts?.successful_auth === true || entry.facts?.database_anomaly === true || entry.facts?.database_export === true || entry.facts?.privilege_change === true);
  if (adverse) return false;
  const times = [alert.first_seen, alert.last_seen, ...entries.map((entry) => entry.observed_at)].map(isoMillis);
  if (times.some((time) => !Number.isFinite(time))) return false;
  const covers = (entry) => isoMillis(entry.facts?.observation_start) <= Math.min(...times) && isoMillis(entry.facts?.observation_end) >= Math.max(...times);
  const noAuth = entries.some((entry) => entry.kind === "behavior_log" && entry.source_service === "mock-auth" && entry.subject === alert.subject && entry.facts?.auth_observation_complete === true && entry.facts?.successful_auth === false && covers(entry));
  const noDb = entries.some((entry) => entry.kind === "behavior_log" && entry.source_service === "mock-db" && entry.subject === alert.asset_id && entry.facts?.db_observation_complete === true && entry.facts?.database_anomaly === false && covers(entry));
  if (!noAuth || !noDb) return false;
  return knowledge.windows.some((window) => window.asset_id === alert.asset_id && window.purpose === "scheduled_internal_probe" &&
    Math.min(...times) >= isoMillis(window.start) && Math.max(...times) <= isoMillis(window.end) &&
    entries.some((entry) => entry.kind === "behavior_log" && entry.source_service === "mock-change" && entry.facts?.maintenance_approved === true && entry.facts?.ticket_id === window.ticket_id));
}

export function evaluateFinding(alert, evidence, { now = Date.now(), scopeComplete = true } = {}) {
  const quality = checkEvidence(alert, evidence, now);
  const completeness = evidenceCompleteness(quality.active);
  const hits = [], missing = [...completeness.missing, ...quality.errors];
  if (!scopeComplete) missing.push("evidence_scope_incomplete");
  if (!quality.active.some((entry) => entry.kind === "asset_identity" && entry.facts?.asset_id && entry.facts.asset_id === alert.asset_id && Number.isInteger(entry.facts.asset_criticality) && entry.facts.environment === alert.environment)) missing.push("asset_identity_confirmation");
  if (!quality.active.some((entry) => entry.kind === "source_classification" && entry.facts?.source_class === alert.source_class)) missing.push("source_classification_confirmation");
  if (!completeness.complete || !scopeComplete || missing.some((item) => item.endsWith("_confirmation"))) hits.push("R001");
  if (quality.errors.length) hits.push("R006");
  const critical = isCritical(alert);
  const result = (classification, ceiling, ruleHits, absent) => ({ recommended_classification: classification,
    recommended_severity: classification === "REAL_ATTACK" ? "critical" : classification === "SUSPECTED_FALSE_POSITIVE" ? "low" : (alert.severity || "unknown"),
    confidence_ceiling: ceiling, rule_hits: [...new Set([...ruleHits, ...(critical ? ["R005"] : [])])],
    human_review_required: true, auto_close_allowed: false, missing: [...new Set(absent)].sort() });
  if (missing.length) return result("INSUFFICIENT_EVIDENCE", knowledge.rules.R001.confidence_ceiling, hits, missing);
  if (attackConfirmed(alert, quality.active)) return result("REAL_ATTACK", knowledge.rules.R004.confidence_ceiling, ["R004"], []);
  if (probeConfirmed(alert, quality.active)) return result("SUSPECTED_FALSE_POSITIVE", knowledge.rules.R003.confidence_ceiling, ["R003"], []);
  return result("INSUFFICIENT_EVIDENCE", knowledge.rules.R001.confidence_ceiling, ["R001"], ["rule_specific_confirmation"]);
}
