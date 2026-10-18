import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { handlers } from "../octobus-services/demo__alert-platform/src/alert-platform.js";

const method = "alert_triage.v1.AlertPlatformService/ListAlerts";

test("ListAlerts groups identical alerts across upstream page boundaries and exposes a stable grouped cursor", async (t) => {
  const base = {
    asset_id: "asset-a", signature: "scan-a", source_class: "EXTERNAL", subject: "198.51.100.9", severity: "low",
    facts: { successful_auth: false, privilege_change: false, new_external_source: false },
  };
  const alerts = [
    { ...base, alert_id: "page-a", first_seen: "2026-10-18T00:00:00Z", last_seen: "2026-10-18T00:00:30Z" },
    { ...base, alert_id: "page-b", first_seen: "2026-10-18T00:03:00Z", last_seen: "2026-10-18T00:03:30Z" },
    { ...base, alert_id: "page-c", severity: "high", first_seen: "2026-10-18T00:09:00Z", last_seen: "2026-10-18T00:09:30Z" },
    { ...base, alert_id: "page-d", signature: "other-scan", first_seen: "2026-10-18T00:20:00Z", last_seen: "2026-10-18T00:20:30Z" },
  ];
  const requestedTokens = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const token = url.searchParams.get("page_token") || "";
    requestedTokens.push(token);
    const offset = token ? Number(token.split(":")[1]) : 0;
    const page = alerts.slice(offset, offset + 2);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ alerts: page, next_page_token: offset + 2 < alerts.length ? `offset:${offset + 2}` : "" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const config = { upstreamBaseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000, maxPageSize: 100, maxGroupingPages: 3 };
  const call = (request) => handlers[method]({ request, config });

  const first = await call({ page_size: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].duplicateCount, 3);
  assert.equal(first.alerts[0].severity, "high");
  assert.deepEqual(first.alerts[0].groupMemberIds, ["page-a", "page-b", "page-c"]);
  assert.equal(first.nextPageToken, "offset:1");

  const second = await call({ page_size: 1, page_token: first.nextPageToken });
  assert.equal(second.total, 2);
  assert.equal(second.alerts[0].alertId, "page-d");
  assert.equal(second.nextPageToken, "");
  assert.deepEqual(requestedTokens, ["", "offset:2", "", "offset:2"]);
  await assert.rejects(() => handlers[method]({ request: {}, config: { ...config, maxGroupingPages: 1 } }),
    (error) => error.code === "RESOURCE_EXHAUSTED");
});
