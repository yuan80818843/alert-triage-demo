import { createHash } from "node:crypto";
import { knowledge } from "./knowledge.js";
import { isoMillis } from "./input.js";

export function fingerprint(alert) {
  // Delimiter joining and lowercasing can conflate distinct subjects/asset IDs.
  return createHash("sha256").update(JSON.stringify([alert.asset_id || "", alert.signature || "", alert.source_class || "", alert.subject || ""])).digest("hex");
}

function safe(alert) {
  const flags = knowledge.rules.R002.exceptions.filter((key) => !key.includes(" "));
  return ["asset_id", "signature", "source_class", "subject", "alert_id"].every((key) => typeof alert[key] === "string" && alert[key].trim()) &&
    knowledge.severity.priority_order.includes(alert.severity) && flags.every((key) => alert.facts?.[key] === false);
}

function result(items, grouped) {
  const order = knowledge.severity.priority_order;
  const representative = grouped ? [...items].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.alert_id.localeCompare(b.alert_id))[0] : items[0];
  return { ...representative, fingerprint: fingerprint(representative), duplicate_count: items.length,
    group_member_ids: items.map((item) => item.alert_id).sort(),
    ...(grouped ? { first_seen: new Date(Math.min(...items.map((item) => isoMillis(item.first_seen)))).toISOString(),
      last_seen: new Date(Math.max(...items.map((item) => isoMillis(item.last_seen)))).toISOString() } : {}) };
}

function cluster(items) {
  const output = [];
  let pending = [], anchor = 0;
  const flush = () => {
    const grouped = pending.length >= knowledge.rules.R002.min_count && pending.every(safe) && new Set(pending.map((item) => item.alert_id)).size === pending.length;
    output.push(...(grouped ? [result(pending, true)] : pending.map((item) => result([item], false))));
    pending = [];
  };
  for (const item of [...items].sort((a, b) => isoMillis(a.first_seen) - isoMillis(b.first_seen))) {
    const first = isoMillis(item.first_seen), last = isoMillis(item.last_seen);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first > last || last - first > knowledge.rules.R002.window_minutes * 60000) {
      flush(); output.push(result([item], false)); continue;
    }
    if (pending.length && last - anchor > knowledge.rules.R002.window_minutes * 60000) flush();
    if (!pending.length) anchor = first;
    pending.push(item);
  }
  flush();
  return output;
}

export function dedupeAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    const key = fingerprint(alert);
    groups.set(key, (groups.get(key) || []).concat(alert));
  }
  return [...groups.values()].flatMap(cluster);
}
