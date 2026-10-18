import fs from "node:fs";

const read = (name) => JSON.parse(fs.readFileSync(new URL("../knowledge/" + name, import.meta.url), "utf8"));
const policy = read("rules.yaml");
const probes = read("probe-allowlist.yaml");
const windows = read("maintenance-windows.yaml");
const severity = read("severity-mapping.yaml");
if ([probes, windows, severity].some((item) => item.version !== policy.version)) throw new Error("Knowledge version mismatch");
const rules = Object.fromEntries(policy.rules.map((rule) => [rule.id, rule]));
if (["R001", "R002", "R003", "R004", "R005", "R006"].some((id) => !rules[id])) throw new Error("Missing executable rule");

export const knowledge = { version: policy.version, trustedSources: policy.trusted_sources,
  rules, probes: probes.probes, windows: windows.windows, severity };
