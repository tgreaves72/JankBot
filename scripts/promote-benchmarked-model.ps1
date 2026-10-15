param()
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -eq 5) { $env:PSModulePath = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/Modules" }
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run model promotion as the deployment owner in Administrator PowerShell." }
$project = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:ProgramData "JankBotEmployerDemo"
$managed = Get-Content -LiteralPath (Join-Path $root "managed.json") -Raw | ConvertFrom-Json
if ($managed.OwnerSid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw "The deployment belongs to another owner." }
$profile = Get-Content -LiteralPath (Join-Path $project "model-profile.json") -Raw | ConvertFrom-Json
if ($profile.model -cnotmatch '^[a-z0-9][a-z0-9.-]*:[a-zA-Z0-9_.-]+$' -or $profile.digest -cnotmatch '^[a-f0-9]{64}$') { throw "Invalid model profile." }
$report = Get-Content -LiteralPath (Join-Path $project ".runtime/benchmarks/full.json") -Raw | ConvertFrom-Json
$clientHash = (Get-FileHash -LiteralPath (Join-Path $project "src/ollama.js") -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $report.finishedAt -or $report.phase -ne "full" -or $report.clientSha256 -cne $clientHash) { throw "A completed confirmation run against the current client is required." }
$selected = @($report.results | Where-Object { $_.model -ceq $profile.model -and $_.digest -ceq $profile.digest -and $_.qualified -eq $true })
if ($selected.Count -ne 1) { throw "The pinned model did not qualify in the confirmation benchmark." }
if ($selected[0].think -cne $profile.think) { throw "The pinned thinking policy differs from the measured policy." }
$parts = $profile.model.Split(':')
$relative = "manifests/registry.ollama.ai/library/$($parts[0])/$($parts[1])"
$sourceRoot = Join-Path $root "models"
$targetRoot = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $env:USERPROFILE ".ollama/models" }
$manifestPath = Join-Path $sourceRoot $relative
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $profile.digest) { throw "Benchmarked manifest no longer matches." }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($layer in @($manifest.config) + @($manifest.layers)) {
  if ($layer.digest -cnotmatch '^sha256:[a-f0-9]{64}$') { throw "Invalid model layer digest." }
  $blob = "blobs/" + $layer.digest.Replace(':','-')
  $source = Join-Path $sourceRoot $blob
  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $layer.digest.Substring(7)) { throw "Benchmarked model layer no longer matches." }
  $target = Join-Path $targetRoot $blob
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}
$targetManifest = Join-Path $targetRoot $relative
New-Item -ItemType Directory -Path (Split-Path -Parent $targetManifest) -Force | Out-Null
Copy-Item -LiteralPath $manifestPath -Destination $targetManifest -Force
Write-Output "The qualifying digest-pinned model is installed in the owner's normal Ollama model store. Runtime permissions and limits did not change."
