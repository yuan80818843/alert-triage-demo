import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function integer(env, name, fallback, min, max) {
  const number = Number(env[name] === undefined ? fallback : env[name]);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid receiver configuration: " + name);
  return number;
}

export function receiverConfig(env = process.env) {
  const gateway = new URL(env.OCTOBUS_SMOKE_URL || "http://127.0.0.1:9000");
  if (gateway.protocol !== "http:" || gateway.username || gateway.password || !["localhost", "127.0.0.1", "[::1]"].includes(gateway.hostname)) {
    throw new Error("Receiver requires a credential-free local OctoBus endpoint");
  }
  return {
    projectRoot,
    reportDirectory: path.resolve(env.TRIAGE_REPORT_DIR || path.join(projectRoot, "reports")),
    dockerDirect: env.TRIAGE_DOCKER_DIRECT === "1",
    daemonContainer: "alert-triage-agent-compose",
    octobusContainer: "alert-triage-octobus",
    gateway: gateway.origin,
    capsetToken: String(env.OCTOBUS_TRIAGE_READ_TOKEN || ""),
    scheduler: "triage",
    intervalMs: integer(env, "TRIAGE_COLLECT_INTERVAL_MS", 15000, 1000, 60000),
    lookbackMs: integer(env, "TRIAGE_COLLECT_LOOKBACK_MS", 600000, 60000, 3600000),
    batchLimit: integer(env, "TRIAGE_COLLECT_BATCH_LIMIT", 30, 1, 100),
    auditTail: integer(env, "TRIAGE_COLLECT_AUDIT_TAIL", 1000, 100, 10000),
  };
}
