// Observes official scheduler history only. Never creates Agent tasks or writes dispositions.
import { receiverConfig } from "../app/config.mjs";
import { ReportStore } from "../app/models/report_store.mjs";
import { createPlatformClient } from "../app/services/platform_client.mjs";
import { collectPending } from "../app/services/report_collector.mjs";

const config = receiverConfig();
const dependencies = { client: createPlatformClient(config), store: new ReportStore(config.reportDirectory) };
let stopping = false;
let timer;
const log = (event, fields = {}) => console.log(JSON.stringify(Object.assign({ at: new Date().toISOString(), event }, fields)));

function stop() { stopping = true; if (timer) clearTimeout(timer); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function tick() {
  try {
    const events = await collectPending(dependencies, config);
    for (const entry of events) log("report_processed", entry);
  } catch (_) { log("receiver_unavailable", { retry: true }); }
  if (!stopping) timer = setTimeout(tick, config.intervalMs);
}

log("receiver_started", { interval_ms: config.intervalMs, lookback_ms: config.lookbackMs, batch_limit: config.batchLimit });
tick();
