// Explicit acceptance entry point; never print platform transcripts or secrets.
import { receiverConfig } from "../app/config.mjs";
import { ReportStore, validRunId } from "../app/models/report_store.mjs";
import { createPlatformClient } from "../app/services/platform_client.mjs";
import { collectAgent, safeReason } from "../app/services/report_collector.mjs";

async function main() {
  const config = receiverConfig();
  const runId = process.argv[2];
  if (!validRunId(runId)) throw new Error("INVALID_PLATFORM_ID");
  const artifact = await collectAgent(runId, { client: createPlatformClient(config), store: new ReportStore(config.reportDirectory) });
  console.log(JSON.stringify({ run_id: runId, accepted: artifact.accepted, reason: safeReason(artifact) }));
  if (!artifact.accepted) process.exitCode = 1;
}

main().catch(() => {
  console.error("Report collection unavailable; no report was accepted. Check platform status and read-capset availability.");
  process.exitCode = 2;
});
