// Package only this demo's own knowledge, never upstream platform source.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "octobus-services/demo__alert-platform/knowledge");
fs.mkdirSync(target, { recursive: true });
for (const name of ["rules.yaml", "probe-allowlist.yaml", "maintenance-windows.yaml", "severity-mapping.yaml"]) {
  const source = path.join(root, "knowledge", name);
  JSON.parse(fs.readFileSync(source, "utf8"));
  fs.copyFileSync(source, path.join(target, name));
}
console.log("Packaged demo-owned executable knowledge (4 files)");
