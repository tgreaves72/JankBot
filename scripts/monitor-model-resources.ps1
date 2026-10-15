param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -eq 5) { $env:PSModulePath = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/Modules" }
$managed = Get-Content -LiteralPath (Join-Path $Root "managed.json") -Raw | ConvertFrom-Json
$pidValue = [int](Get-Content -LiteralPath (Join-Path $Root "state/ollama.pid") -Raw)
$listener = @(Get-NetTCPConnection -LocalPort 11435 -State Listen)
if ($listener.Count -ne 1 -or $listener[0].LocalAddress -ne "127.0.0.1" -or $listener[0].OwningProcess -ne $pidValue) { throw "The benchmark requires the existing loopback-only managed Ollama instance." }
$running = Get-Process -Id $pidValue -IncludeUserName
if ($running.UserName -ne "$env:COMPUTERNAME\$($managed.UserName)") { throw "The model server is not running under the restricted account." }
$guardPath = Join-Path $Root "app/scripts/resource-guard.ps1"
$guard = Get-Content -LiteralPath $guardPath -Raw
foreach ($required in @('[DemoJob]::Create(2048, 25, 4)', '$env:OLLAMA_NO_CLOUD = "1"', '$env:OLLAMA_NUM_PARALLEL = "1"', '$env:OLLAMA_MAX_LOADED_MODELS = "1"', '$env:OLLAMA_MAX_QUEUE = "1"')) {
  if (-not $guard.Contains($required)) { throw "The deployed model guard differs from the required security profile." }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BenchmarkJobCheck {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
}
'@
$inJob = $false
if (-not [BenchmarkJobCheck]::IsProcessInJob($running.Handle, [IntPtr]::Zero, [ref]$inJob) -or -not $inJob) { throw "Ollama is not assigned to a Windows Job Object." }
[pscustomobject]@{kind="preflight";guardSha256=(Get-FileHash -LiteralPath $guardPath -Algorithm SHA256).Hash.ToLowerInvariant();memoryLimitMiB=2048;cpuPercent=25;processLimit=4;restrictedAccount=$true;jobAssigned=$true;loopbackOnly=$true} | ConvertTo-Json -Compress
while ($true) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $ids.Add($pidValue) | Out-Null
  do {
    $changed = $false
    foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } }
  } while ($changed)
  $privateBytes = [long]0; $workingBytes = [long]0; $count = 0
  foreach ($number in $ids) {
    $process = Get-Process -Id $number -ErrorAction SilentlyContinue
    if ($process) { $privateBytes += $process.PrivateMemorySize64; $workingBytes += $process.WorkingSet64; $count++ }
  }
  if ($count -eq 0) { throw "The managed Ollama process exited during benchmarking." }
  if ($count -gt 4 -or $privateBytes -gt 2147483648) { throw "Observed model processes exceeded the benchmark resource gate." }
  [pscustomobject]@{kind="sample";at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();privateBytes=$privateBytes;workingSetBytes=$workingBytes;processes=$count} | ConvertTo-Json -Compress
  Start-Sleep -Seconds 2
}
