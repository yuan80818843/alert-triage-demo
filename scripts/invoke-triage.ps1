param(
  [switch]$Trigger,
  [switch]$ShowLogs
)

$ErrorActionPreference = "Stop"
$mockPort = if ($env:MOCK_UPSTREAM_PORT) { $env:MOCK_UPSTREAM_PORT } else { "8081" }

Write-Host "Checking mock upstream..."
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$mockPort/healthz"
if (-not $health.ok) { throw "mock upstream health check failed" }
$alerts = Invoke-RestMethod -Uri "http://127.0.0.1:$mockPort/alerts?page_size=100"
$evidence = Invoke-RestMethod -Uri "http://127.0.0.1:$mockPort/evidence?limit=100"
$cases = Invoke-RestMethod -Uri "http://127.0.0.1:$mockPort/cases?limit=100"
Write-Host ("Fixtures: {0} alerts, {1} evidence records, {2} similar cases." -f $alerts.total, $evidence.evidence.Count, $cases.cases.Count)

Write-Host "Checking OctoBus read capset catalog..."
docker compose exec octobus octobus catalog triage-read --all --json

if ($Trigger) {
  Write-Host "Triggering the configured scheduler job..."
  docker compose exec agent-compose agent-compose scheduler trigger triage alert-poll --detach
}

if ($ShowLogs) {
  Write-Host "Recent scheduler logs..."
  docker compose exec agent-compose agent-compose scheduler logs --scheduler triage --tail 50
}

Write-Host "Smoke check completed. CreateDisposition remains human-write only and is not triggered by this script."

