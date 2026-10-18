import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const randomUUID = () => crypto.randomBytes(16).toString("hex");

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
// Host execution defaults to loopback so the demo does not require a
// Windows Firewall rule. Docker overrides this to 0.0.0.0 in compose.
const host = process.env.BIND_HOST || "127.0.0.1";
const auditPath = process.env.AUDIT_LOG_PATH || "/app/data/audit.log";
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, "fixtures", name), "utf8"));
const alerts = read("alerts.json");
const evidence = read("evidence.json");
const cases = read("cases.json");
const dispositions = new Map();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function audit(event) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

function body(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; if (text.length > 1024 * 1024) reject(new Error("body too large")); });
    request.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error("invalid json")); } });
    request.on("error", reject);
  });
}

function filterAlerts(url) {
  return alerts.filter((item) => {
    if (url.searchParams.get("source_class") && item.source_class !== url.searchParams.get("source_class")) return false;
    if (url.searchParams.get("severity") && item.severity !== url.searchParams.get("severity")) return false;
    if (url.searchParams.get("status") && item.status !== url.searchParams.get("status")) return false;
    if (url.searchParams.get("asset_id") && item.asset_id !== url.searchParams.get("asset_id")) return false;
    if (url.searchParams.get("start_time") && Date.parse(item.last_seen) < Date.parse(url.searchParams.get("start_time"))) return false;
    if (url.searchParams.get("end_time") && Date.parse(item.first_seen) > Date.parse(url.searchParams.get("end_time"))) return false;
    return true;
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") return json(response, 204, {});
  try {
    if (request.method === "GET" && url.pathname === "/healthz") return json(response, 200, { ok: true, service: "mock-upstream" });
    if (request.method === "GET" && url.pathname === "/alerts") {
      const items = filterAlerts(url);
      const limit = Math.min(Number(url.searchParams.get("page_size") || 20), 100);
      const offset = Number((url.searchParams.get("page_token") || "offset:0").split(":")[1]);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) return json(response, 400, { error: "invalid pagination" });
      return json(response, 200, { alerts: items.slice(offset, offset + limit), next_page_token: offset + limit < items.length ? "offset:" + (offset + limit) : "", total: items.length });
    }
    if (request.method === "GET" && url.pathname.startsWith("/alerts/")) {
      const id = decodeURIComponent(url.pathname.slice("/alerts/".length));
      const item = alerts.find((candidate) => candidate.alert_id === id);
      if (!item) return json(response, 404, { error: "alert not found" });
      return json(response, 200, { alert: item, related_asset_ids: [item.asset_id].filter(Boolean) });
    }
    if (request.method === "GET" && url.pathname === "/evidence") {
      const alertId = url.searchParams.get("alert_id");
      const items = evidence.filter((item) => !alertId || item.alert_id === alertId);
      const limit = Math.min(Number(url.searchParams.get("limit") || 100), 100);
      return json(response, 200, { evidence: items.slice(0, limit), truncated: items.length > limit });
    }
    if (request.method === "GET" && url.pathname === "/cases") {
      const alertId = url.searchParams.get("alert_id");
      const sourceClass = url.searchParams.get("source_class");
      const signature = url.searchParams.get("signature");
      const matches = cases.filter((item) => {
        if (alertId && Array.isArray(item.alert_ids) && !item.alert_ids.includes(alertId)) return false;
        if (sourceClass && item.source_class && item.source_class !== sourceClass) return false;
        if (signature && item.signature && item.signature !== signature) return false;
        return true;
      });
      return json(response, 200, { cases: matches.slice(0, Math.min(Number(url.searchParams.get("limit") || 20), 20)) });
    }
    if (request.method === "POST" && url.pathname === "/dispositions") {
      const payload = await body(request);
      if (dispositions.has(payload.idempotency_key)) return json(response, 200, dispositions.get(payload.idempotency_key));
      const result = { disposition_id: `DISP-${randomUUID()}`, status: "RECORDED", recorded_at: new Date().toISOString(), audit_ref: `audit-${randomUUID()}` };
      dispositions.set(payload.idempotency_key, result);
      audit({ action: "CreateDisposition", alert_id: payload.alert_id, disposition_id: result.disposition_id, classification: payload.classification, evidence_ids: payload.evidence_ids, approved_by: payload.approved_by, human_approval_id: payload.human_approval_id });
      return json(response, 201, result);
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      const text = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8") : "";
      return json(response, 200, { lines: text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [] });
    }
    return json(response, 404, { error: "route not found" });
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
});

server.listen(port, host, () => console.log(JSON.stringify({ event: "mock_upstream_started", host, port })));

