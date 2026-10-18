// Docker-Hub-free, read-only console fallback. Never proxy disposition writes.
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validRunId } from "../app/models/report_store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../frontend");
const upstream = process.env.CONSOLE_UPSTREAM_URL || "http://127.0.0.1:8081";
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = Number(process.env.CONSOLE_PORT || 8080);
const reportsDirectory = path.resolve(process.env.TRIAGE_REPORT_DIR || path.join(process.cwd(), "reports"));
const files = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"] };

function strings(value) { return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 100) : []; }

function firstDefined(value, fallback) { return value === undefined || value === null ? fallback : value; }

function evidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => ({ evidence_id: item && item.evidence_id, source: item && item.source, method: item && item.method, observed_at: item && item.observed_at, fact: item && item.fact }));
}

function projectArtifact(artifact) {
  const value = artifact || {};
  const report = value.report;
  const snapshot = value.snapshot || {};
  const validation = value.validation || {};
  return {
    run_id: value.run_id || null,
    accepted: value.accepted === true,
    recorded_at: value.recorded_at || snapshot.captured_at || null,
    validation: { valid: validation.valid === true, errors: strings(validation.errors) },
    report: report ? {
      run_id: report.run_id, alert_id: report.alert_id, classification: report.classification, confidence: report.confidence,
      explanation: typeof report.explanation === "string" ? report.explanation : "", evidence_chain: evidence(report.evidence_chain),
      missing_evidence: strings(report.missing_evidence), next_actions: strings(report.next_actions), rule_hits: strings(report.rule_hits),
      human_review_required: report.human_review_required === true, proposed_disposition: report.proposed_disposition, similar_case_ids: strings(report.similar_case_ids),
    } : null,
    evaluation: snapshot.evaluation ? {
      recommended_classification: snapshot.evaluation.recommendedClassification || snapshot.evaluation.recommended_classification,
      confidence_ceiling: firstDefined(snapshot.evaluation.confidenceCeiling, snapshot.evaluation.confidence_ceiling),
      rule_hits: strings(snapshot.evaluation.ruleHits || snapshot.evaluation.rule_hits),
      human_review_required: firstDefined(snapshot.evaluation.humanReviewRequired, snapshot.evaluation.human_review_required),
      auto_close_allowed: firstDefined(snapshot.evaluation.autoCloseAllowed, snapshot.evaluation.auto_close_allowed),
    } : null,
    similar_cases: snapshot.cases && Array.isArray(snapshot.cases.cases) ? snapshot.cases.cases.slice(0, 20).map((item) => ({ case_id: item && (item.case_id || item.caseId), decision: item && item.decision, disposition: item && item.disposition, confidence: item && item.confidence })) : [],
    call_audit: Array.isArray(value.call_audit) ? value.call_audit.slice(0, 100) : [],
  };
}

function readArtifacts() {
  let names;
  try { names = fs.readdirSync(reportsDirectory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(reportsDirectory, name), "utf8"))]; } catch (_) { return []; }
  });
}

function reportSummary(artifact) {
  const value = artifact || {};
  const report = value.report || {};
  const validation = value.validation || {};
  return {
    run_id: value.run_id || null, accepted: value.accepted === true,
    recorded_at: value.recorded_at || (value.snapshot && value.snapshot.captured_at) || null, alert_id: report.alert_id || null,
    classification: report.classification || null, confidence: Number.isFinite(report.confidence) ? report.confidence : null,
    human_review_required: report.human_review_required === true, reason: strings(validation.errors)[0] || value.reason || null,
  };
}

function reportApi(url, res) {
  if (url.pathname === "/api/reports") {
    const reports = readArtifacts().map(reportSummary).sort((a, b) => String(b.recorded_at || "").localeCompare(String(a.recorded_at || "")));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({ reports }));
  }
  const match = /^\/api\/reports\/([a-f0-9]{64})$/.exec(url.pathname);
  if (!match || !validRunId(match[1])) { res.writeHead(404); return res.end(); }
  const target = path.join(reportsDirectory, match[1] + ".json");
  try {
    const artifact = JSON.parse(fs.readFileSync(target, "utf8"));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(projectArtifact(artifact)));
  } catch (error) { res.writeHead(error.code === "ENOENT" ? 404 : 500); res.end(); }
}

http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405); return res.end("Read-only console"); }
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && (url.pathname === "/api/reports" || url.pathname.startsWith("/api/reports/"))) return reportApi(url, res);
  if (url.pathname.startsWith("/api/")) {
    const route = url.pathname.slice(4);
    if (!/^\/(alerts|evidence|cases|healthz)$/.test(route)) { res.writeHead(404); return res.end(); }
    const proxy = http.get(new URL(route + url.search, upstream), (response) => {
      res.writeHead(response.statusCode, { "content-type": "application/json", "cache-control": "no-store" });
      response.pipe(res);
    });
    proxy.setTimeout(5000, () => proxy.destroy(new Error("upstream timeout")));
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    return;
  }
  const entry = files[url.pathname];
  if (!entry) { res.writeHead(404); return res.end(); }
  fs.readFile(path.join(root, entry[0]), (error, data) => {
    if (error) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { "content-type": entry[1] + "; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end(data);
  });
}).listen(port, host, () => console.log(JSON.stringify({ event: "console_started", host, port })));
