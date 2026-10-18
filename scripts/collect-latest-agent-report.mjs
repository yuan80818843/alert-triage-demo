// One-shot manual receiver for interview demos; it never creates a task or writes a disposition.
import { receiverConfig } from "../app/config.mjs";
import { ReportStore, validRunId } from "../app/models/report_store.mjs";
import { createPlatformClient } from "../app/services/platform_client.mjs";
import { collectScheduler } from "../app/services/report_collector.mjs";

function output(event, fields = {}) { console.log(JSON.stringify({ event, ...fields })); }

async function main() {
  const config = receiverConfig();
  const store = new ReportStore(config.reportDirectory);
  const client = createPlatformClient(config);
  const now = Date.now();
  const rows = await client.list();
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => {
    const completed = Date.parse(row.completed_at || row.started_at);
    return validRunId(row.run_id) && row.status === "succeeded" && Number.isFinite(completed) && completed <= now && completed >= now - config.lookbackMs;
  }).sort((a, b) => Date.parse(b.completed_at || b.started_at) - Date.parse(a.completed_at || a.started_at));
  if (!candidates.length) { output("no_succeeded_run", { lookback_ms: config.lookbackMs }); return; }
  const latest = candidates[0];
  const existing = store.get(latest.run_id, true);
  if (existing) {
    output("report_already_recorded", { scheduler_run_id: latest.run_id, run_id: existing.run_id || null, accepted: existing.accepted === true, reason: existing.reason || null });
    return;
  }
  const artifact = await collectScheduler(latest, { client, store });
  output("report_processed", { scheduler_run_id: latest.run_id, run_id: artifact && artifact.run_id || null, accepted: artifact && artifact.accepted === true, reason: artifact && artifact.reason || null });
  if (!artifact || !artifact.accepted) process.exitCode = 1;
}

main().catch(() => {
  output("receiver_unavailable", { retry: true });
  process.exitCode = 2;
});
