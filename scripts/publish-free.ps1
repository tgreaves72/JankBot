param([ValidateRange(1024,65535)][int]$Port = 3000)
$ErrorActionPreference = "Stop"
$tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
$tailscaleExe = if ($tailscaleCommand) { $tailscaleCommand.Source } else { Join-Path $env:ProgramFiles "Tailscale/tailscale.exe" }
if (-not (Test-Path -LiteralPath $tailscaleExe)) {
  throw "Install the free Tailscale client from https://tailscale.com/download/windows and sign into its Personal plan before publishing."
}
$tailnet = (& $tailscaleExe status --json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $tailnet.BackendState -ne "Running") { throw "Sign into Tailscale and connect before publishing." }
$project = Split-Path -Parent $PSScriptRoot
$control = Get-Content -LiteralPath (Join-Path $project ".runtime/host-control.json") -Raw | ConvertFrom-Json
$headers = @{Authorization="Bearer $($control.token)"}
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -Headers $headers -TimeoutSec 10
if ($health.capabilities.maintenance) { throw "Start JankBot with npm run start:public before exposing it to visitors." }
if (-not $health.capabilities.employerDemo -or -not $health.deployment.accessRequired) { throw "Refusing to publish without employer access controls." }
if (-not $health.capabilities.oneClickDemo) { throw "Restart the demo with a valid one-click invitation before publishing." }
$managed = Get-Content -LiteralPath (Join-Path $env:ProgramData "JankBotEmployerDemo/managed.json") -Raw | ConvertFrom-Json
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen
if ($listener.LocalAddress -ne "127.0.0.1") { throw "The demo must bind only to loopback." }
$runtimeProcess = Get-Process -Id $listener.OwningProcess -IncludeUserName
if ($runtimeProcess.UserName -ne "$env:COMPUTERNAME\$($managed.UserName)") { throw "Refusing to publish a demo running under another Windows account." }
$dnsName = $tailnet.Self.DNSName.TrimEnd('.')
if ($health.deployment.publicOrigin -ne "https://$dnsName") {
  throw "Restart the public-mode server now that Tailscale is connected. Its public origin must match https://$dnsName before publishing."
}
$readiness = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ready" -Headers $headers -TimeoutSec 10
if (-not $readiness.ready) { throw "Run npm run setup first. Card data and Ollama must be ready." }
& $tailscaleExe funnel --bg "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { throw "Funnel setup did not complete. Follow Tailscale's HTTPS/Funnel enablement instructions and rerun." }
Write-Output "Live site: https://$dnsName/"
Write-Output "Only JankBot's web port is published. Ollama remains private."
Write-Output "Stop public access with: tailscale funnel reset"
