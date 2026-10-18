$ErrorActionPreference = "Stop"
$service = "alert-platform"
$instance = "alert-platform-demo"
$methods = @(
  "/alert_triage.v1.AlertPlatformService/ListAlerts",
  "/alert_triage.v1.AlertPlatformService/GetAlertDetail",
  "/alert_triage.v1.AlertPlatformService/QueryEvidence",
  "/alert_triage.v1.AlertPlatformService/SearchSimilarCases",
)

docker compose exec octobus octobus capset create triage-read --name "Alert Triage Read"
docker compose exec octobus octobus capset add-instance triage-read $instance --no-all-methods
foreach ($method in $methods) { docker compose exec octobus octobus capset select-method triage-read $instance $method }

docker compose exec octobus octobus capset create triage-human-write --name "Alert Triage Human Write"
docker compose exec octobus octobus capset add-instance triage-human-write $instance --no-all-methods
docker compose exec octobus octobus capset select-method triage-human-write $instance "/alert_triage.v1.AlertPlatformService/CreateDisposition"

docker compose exec octobus octobus catalog triage-read --all --json
docker compose exec octobus octobus catalog triage-human-write --all --json
Write-Host "Read and human-write capsets configured. Agent receives only triage-read."

