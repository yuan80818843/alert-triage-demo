param(
  [switch]$Reimport,
  [string]$UpstreamBaseUrl = $(if ($env:OCTOBUS_UPSTREAM_URL) { $env:OCTOBUS_UPSTREAM_URL } else { "http://mock-upstream:8080" })
)
$ErrorActionPreference = "Stop"
node (Join-Path $PSScriptRoot "prepare-service.mjs")
if ($LASTEXITCODE -ne 0) { throw "Knowledge packaging failed" }

docker compose up -d mock-upstream octobus
if ($LASTEXITCODE -ne 0) { throw "Docker startup failed" }
docker compose exec octobus octobus service import alert-platform /opt/alert-triage/services/demo__alert-platform
if ($LASTEXITCODE -ne 0) { throw "Service import failed" }
if ($Reimport) { Write-Host "Service reimported; existing instances are restarted by OctoBus."; return }
$configJson = @{ upstreamBaseUrl = $UpstreamBaseUrl; timeoutMs = 3000; maxPageSize = 100; evaluationTime = "2026-10-18T04:00:00Z" } | ConvertTo-Json -Compress
docker compose exec octobus octobus instance create alert-platform-demo --service alert-platform --config-json $configJson
if ($LASTEXITCODE -ne 0) { throw "Instance creation failed (check whether it already exists)" }
Write-Host "OctoBus service and instance are ready. Run configure-capsets.ps1 next."

