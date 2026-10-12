$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
$path = Join-Path $project ".runtime/demo-processes.json"
if (-not (Test-Path -LiteralPath $path)) { throw "No managed demo process record found." }
$record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
foreach ($identity in $record.Supervisors) {
  $process = Get-Process -Id $identity.Id -IncludeUserName -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  if ($process.ProcessName -ne "powershell" -or $process.UserName -ne $identity.UserName -or $process.StartTime.ToUniversalTime().ToString('o') -ne $identity.Started) {
    throw "PID $($identity.Id) belongs to another process. Refusing to stop it."
  }
  & taskkill /PID $identity.Id /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not stop the managed supervisor." }
}
Write-Output "Managed demo processes stopped. The Ollama instance on port 11434 was not changed."
