import { knowledge } from "./knowledge.js";
import { isoMillis } from "./input.js";

export const trusted = (entry) => (knowledge.trustedSources[entry.kind] || []).includes(entry.source_service);
const booleanFacts = ["successful_auth", "auth_observation_complete", "database_anomaly", "db_observation_complete", "database_export", "privilege_change", "maintenance_approved"];
const assertionFacts = [...booleanFacts, "source_class", "asset_id", "asset_criticality", "environment", "probe_id", "signature", "export_bytes"];

function fresh(entry, now) {
  const time = isoMillis(entry.observed_at);
  return Number.isFinite(time) && time <= now && now - time <= knowledge.rules.R006.max_age_hours * 3600000;
}

function replacements(entries, now) {
  return new Set(entries.filter((old) => entries.some((next) => next !== old &&
    next.facts?.replaces_evidence_id === old.evidence_id && next.integrity === "verified" && trusted(next) && fresh(next, now) &&
    isoMillis(next.observed_at) > isoMillis(old.observed_at) && next.source_service === old.source_service && next.source_instance === old.source_instance &&
    next.kind === old.kind && next.subject === old.subject && next.facts?.assertion_id && next.facts.assertion_id === old.facts?.assertion_id
  )).map((entry) => entry.evidence_id));
}

function conflicts(entries, alert) {
  const assertions = new Map();
  for (const entry of entries) {
    const facts = entry.facts || {};
    if (entry.kind === "source_classification" && facts.source_class && facts.source_class !== alert.source_class) return true;
    if (entry.kind === "asset_identity" && ["asset_id", "asset_criticality", "environment"].some((key) => facts[key] !== undefined && facts[key] !== alert[key])) return true;
    if (!facts.assertion_id) continue;
    const scope = JSON.stringify([entry.kind, entry.subject, facts.assertion_id]);
    const prior = assertions.get(scope) || {};
    for (const key of assertionFacts) {
      if (facts[key] === undefined) continue;
      if (prior[key] !== undefined && prior[key] !== facts[key]) return true;
      prior[key] = facts[key];
    }
    assertions.set(scope, prior);
  }
  return false;
}

export function checkEvidence(alert, entries, now) {
  const errors = new Set();
  const seen = new Map();
  if (!Array.isArray(entries)) { errors.add("evidence_shape"); entries = []; }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { errors.add("evidence_shape"); continue; }
    if (seen.has(entry.evidence_id) && JSON.stringify(seen.get(entry.evidence_id)) !== JSON.stringify(entry)) errors.add("evidence_id_conflict");
    seen.set(entry.evidence_id, entry);
  }
  const unique = [...seen.values()];
  const replaced = replacements(unique, now);
  const active = unique.filter((entry) => !replaced.has(entry.evidence_id));
  for (const entry of active) {
    if (["evidence_id", "source_service", "source_instance", "method", "subject", "fact"].some((key) => typeof entry[key] !== "string" || !entry[key].trim())) errors.add("evidence_provenance");
    if (entry.alert_id !== alert.alert_id || !alert.correlation_id || entry.correlation_id !== alert.correlation_id) errors.add("evidence_scope");
    if (entry.integrity !== "verified") errors.add("evidence_integrity");
    if (!trusted(entry)) errors.add("untrusted_source");
    if (!Number.isFinite(isoMillis(entry.observed_at)) || isoMillis(entry.observed_at) > now) errors.add("evidence_time");
    else if (!fresh(entry, now)) errors.add("stale_evidence");
    const facts = entry.facts || {};
    if (typeof facts !== "object" || Array.isArray(facts) || booleanFacts.some((key) => facts[key] !== undefined && typeof facts[key] !== "boolean")) errors.add("invalid_structured_facts");
    if (facts.export_bytes !== undefined && (!Number.isSafeInteger(facts.export_bytes) || facts.export_bytes < 0)) errors.add("invalid_structured_facts");
    if (facts.observation_start !== undefined || facts.observation_end !== undefined) {
      const first = isoMillis(facts.observation_start), last = isoMillis(facts.observation_end);
      if (!Number.isFinite(first) || !Number.isFinite(last) || first > last || last > isoMillis(entry.observed_at)) errors.add("invalid_observation_range");
    }
  }
  if (conflicts(active.filter((entry) => entry.integrity === "verified" && trusted(entry)), alert)) errors.add("evidence_conflict");
  return { active, errors: [...errors].sort() };
}
