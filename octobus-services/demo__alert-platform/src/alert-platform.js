import { randomUUID } from "node:crypto";
import { value, fail, parseTime, parseRange, pageSize, confidence, assertString, stringArray, isoMillis } from "./input.js";
import { fingerprint, dedupeAlerts } from "./alert-grouping.js";
import { evidenceCompleteness, evaluateFinding } from "./rule-engine.js";
import { knowledge } from "./knowledge.js";

const CLASSIFICATIONS = new Set(["REAL_ATTACK", "SUSPECTED_FALSE_POSITIVE", "INSUFFICIENT_EVIDENCE"]);
const DISPOSITIONS = { REAL_ATTACK: ["ESCALATE", "ESCALATE_FOR_HUMAN_REVIEW"], SUSPECTED_FALSE_POSITIVE: ["HOLD_FOR_REVIEW"], INSUFFICIENT_EVIDENCE: ["REQUEST_MORE_EVIDENCE"] };

function isoNow() {
  return new Date().toISOString();
}

function baseUrl(ctx) {
  const configured = ctx.config?.upstreamBaseUrl || process.env.ALERT_TRIAGE_UPSTREAM_URL || "http://mock-upstream:8080";
  return String(configured).replace(/\/$/, "");
}

async function fetchJson(ctx, path, options = {}) {
  const timeout = Number(ctx.config?.timeoutMs || 3000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${baseUrl(ctx)}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) fail(({ 400: "INVALID_ARGUMENT", 404: "NOT_FOUND", 409: "ALREADY_EXISTS" })[response.status] || "UNAVAILABLE", `upstream returned HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error.code) throw error;
    fail(error.name === "AbortError" ? "DEADLINE_EXCEEDED" : "UNAVAILABLE", "upstream request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllAlertPages(ctx, query, pageSize, maxPages) {
  let pageToken = "";
  const seenTokens = new Set();
  const alerts = [];
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams(query);
    params.set("page_size", String(pageSize));
    if (pageToken) params.set("page_token", pageToken);
    const body = await fetchJson(ctx, `/alerts?${params}`);
    if (Array.isArray(body.alerts)) alerts.push(...body.alerts);
    const next = String(body.next_page_token || "");
    if (!next) return alerts;
    if (seenTokens.has(next)) fail("UNAVAILABLE", "upstream pagination did not advance");
    seenTokens.add(next);
    pageToken = next;
  }
  fail("RESOURCE_EXHAUSTED", "alert grouping scan exceeded configured page limit");
}

async function listAlerts(request, ctx) {
  const query = new URLSearchParams();
  const { start, end } = parseRange(request);
  const token = value(request, "page_token", "pageToken");
  if (token !== undefined && (typeof token !== "string" || !/^offset:(0|[1-9]\d{0,5})$/.test(token))) fail("INVALID_ARGUMENT", "invalid page_token");
  if (start) query.set("start_time", start);
  if (end) query.set("end_time", end);
  for (const field of ["source_class", "sourceClass", "severity", "status", "asset_id", "assetId"]) {
    const item = value(request, field);
    if (item !== undefined) query.set(field.replace(/([A-Z])/g, "_$1").toLowerCase(), String(item));
  }
  const requestedPageSize = pageSize(value(request, "page_size", "pageSize"), Number(ctx.config?.maxPageSize || 100));
  const requestedOffset = token ? Number(token.slice("offset:".length)) : 0;
  const allAlerts = await fetchAllAlertPages(ctx, query, Number(ctx.config?.maxPageSize || 100), Number(ctx.config?.maxGroupingPages || 10));
  const grouped = dedupeAlerts(allAlerts);
  const alerts = grouped.slice(requestedOffset, requestedOffset + requestedPageSize);
  const nextOffset = requestedOffset + alerts.length;
  return { alerts, next_page_token: nextOffset < grouped.length ? `offset:${nextOffset}` : "", query_time: isoNow(), total: grouped.length };
}

async function getAlertDetail(request, ctx) {
  const alertId = assertString(request, "alert_id", "alertId");
  const body = await fetchJson(ctx, `/alerts/${encodeURIComponent(alertId)}`);
  return { alert: body.alert, related_asset_ids: body.related_asset_ids || [] };
}

async function queryEvidence(request, ctx) {
  const alertId = assertString(request, "alert_id", "alertId");
  // Always read the complete bounded upstream set before applying user scope.
  // A partial query must never manufacture a negative/safe conclusion.
  const query = new URLSearchParams({ alert_id: alertId, limit: "100" });
  const correlationId = value(request, "correlation_id", "correlationId");
  const { start, end } = parseRange(request);
  const types = stringArray(value(request, "evidence_types", "evidenceTypes"), "evidence_types");
  if (types.some((type) => !knowledge.trustedSources[type])) fail("INVALID_ARGUMENT", "unsupported evidence type");
  const limit = pageSize(value(request, "limit"), 100);
  const body = await fetchJson(ctx, `/evidence?${query}`);
  const all = Array.isArray(body.evidence) ? body.evidence : [];
  const evidence = all.filter((entry) => (!correlationId || entry.correlation_id === correlationId) &&
    (!start || isoMillis(entry.observed_at) >= Date.parse(start)) && (!end || isoMillis(entry.observed_at) <= Date.parse(end)) &&
    (!types.length || types.includes(entry.kind))).slice(0, limit);
  const detail = await fetchJson(ctx, `/alerts/${encodeURIComponent(alertId)}`);
  const clock = ctx.config?.evaluationTime;
  const evaluatedAt = clock ? parseTime(clock, "evaluationTime") : isoNow();
  const evaluation = evaluateFinding(detail.alert, all, { now: Date.parse(evaluatedAt), scopeComplete: evidence.length === all.length && body.truncated !== true });
  return { evidence, complete: evaluation.missing.length === 0, missing_types: evaluation.missing, evaluated_at: evaluatedAt,
    evaluation_mode: clock ? "synthetic-replay" : "live", knowledge_version: knowledge.version,
    recommended_classification: evaluation.recommended_classification, recommended_severity: evaluation.recommended_severity, confidence_ceiling: evaluation.confidence_ceiling, rule_hits: evaluation.rule_hits,
    human_review_required: evaluation.human_review_required, auto_close_allowed: evaluation.auto_close_allowed };
}

async function searchSimilarCases(request, ctx) {
  const query = new URLSearchParams();
  const alertId = value(request, "alert_id", "alertId");
  if (alertId) query.set("alert_id", String(alertId));
  for (const [field, aliases] of [["source_class", ["source_class", "sourceClass"]], ["signature", ["signature"]], ["environment", ["environment"]]]) {
    const item = value(request, ...aliases);
    if (item) query.set(field, String(item));
  }
  query.set("limit", String(pageSize(value(request, "limit"), 20)));
  const body = await fetchJson(ctx, `/cases?${query}`);
  return { cases: Array.isArray(body.cases) ? body.cases : [] };
}

async function createDisposition(request, ctx) {
  const alertId = assertString(request, "alert_id", "alertId");
  const classification = assertString(request, "classification").toUpperCase();
  if (!CLASSIFICATIONS.has(classification)) fail("INVALID_ARGUMENT", "classification is invalid");
  const requestedConfidence = confidence(value(request, "confidence"));
  const evidenceIds = stringArray(value(request, "evidence_ids", "evidenceIds"), "evidence_ids");
  if (evidenceIds.length === 0) fail("FAILED_PRECONDITION", "at least one evidence_id is required");
  const idempotencyKey = assertString(request, "idempotency_key", "idempotencyKey");
  const approvalId = assertString(request, "human_approval_id", "humanApprovalId");
  const approvedBy = assertString(request, "approved_by", "approvedBy");
  const approvedAt = parseTime(assertString(request, "approved_at", "approvedAt"), "approved_at");
  const proposed = assertString(request, "proposed_disposition", "proposedDisposition");
  if (!DISPOSITIONS[classification].includes(proposed)) fail("FAILED_PRECONDITION", "disposition is not permitted by the classification safety policy");
  const missingEvidence = stringArray(value(request, "missing_evidence", "missingEvidence"), "missing_evidence");
  const nextActions = stringArray(value(request, "next_actions", "nextActions"), "next_actions");
  if (!nextActions.length) fail("INVALID_ARGUMENT", "at least one next_action is required");
  const evidenceResponse = await queryEvidence({ alert_id: alertId, limit: 100 }, ctx);
  const knownEvidence = new Set(evidenceResponse.evidence.map((item) => item.evidence_id));
  const unknown = evidenceIds.filter((id) => !knownEvidence.has(id));
  if (unknown.length) fail("FAILED_PRECONDITION", `unknown evidence_id: ${unknown[0]}`);
  if (classification !== evidenceResponse.recommended_classification) fail("FAILED_PRECONDITION", `classification conflicts with code gate: ${evidenceResponse.recommended_classification}`);
  if (requestedConfidence > evidenceResponse.confidence_ceiling) fail("FAILED_PRECONDITION", "confidence exceeds code gate ceiling");
  if (JSON.stringify([...evidenceResponse.missing_types].sort()) !== JSON.stringify([...missingEvidence].sort())) fail("FAILED_PRECONDITION", "missing_evidence conflicts with code gate");
  const payload = { alert_id: alertId, classification, confidence: requestedConfidence, evidence_ids: evidenceIds, missing_evidence: missingEvidence, next_actions: nextActions, proposed_disposition: proposed, human_approval_id: approvalId, approved_by: approvedBy, approved_at: approvedAt, idempotency_key: idempotencyKey };
  return fetchJson(ctx, "/dispositions", { method: "POST", body: JSON.stringify(payload) });
}

// protobuf-es runtime objects use camelCase properties, including nested DTOs.
// Keep upstream/rule objects snake_case internally; translate only at the RPC
// boundary. Struct payloads are arbitrary data and must retain their keys.
function toProtoObject(input) {
  if (Array.isArray(input)) return input.map(toProtoObject);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [
    key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
    key === "facts" ? item : toProtoObject(item),
  ]));
}

const adapt = (handler) => async (ctx) => toProtoObject(await handler(ctx.request || {}, ctx));

export const handlers = {
  "alert_triage.v1.AlertPlatformService/ListAlerts": adapt(listAlerts),
  "alert_triage.v1.AlertPlatformService/GetAlertDetail": adapt(getAlertDetail),
  "alert_triage.v1.AlertPlatformService/QueryEvidence": adapt(queryEvidence),
  "alert_triage.v1.AlertPlatformService/SearchSimilarCases": adapt(searchSimilarCases),
  "alert_triage.v1.AlertPlatformService/CreateDisposition": adapt(createDisposition),
};

export const _test = { dedupeAlerts, evidenceCompleteness, evaluateFinding, parseTime, pageSize, confidence, fingerprint, createDisposition, randomUUID };

