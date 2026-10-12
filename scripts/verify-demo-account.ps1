param([Parameter(Mandatory=$true)][string]$OwnerFile, [Parameter(Mandatory=$true)][string]$PrivateFile, [Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = "Stop"
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Runtime account unexpectedly has administrator rights." }
foreach ($file in @($OwnerFile, $PrivateFile)) {
  $denied = $false
  try { $null = [IO.File]::ReadAllText($file) }
  catch [UnauthorizedAccessException] { $denied = $true }
  if (-not $denied) { throw "Runtime account can read an owner-private file." }
}
$probe = Join-Path $Root "app/.write-denial-probe"
$denied = $false
try { [IO.File]::WriteAllText($probe, "probe") }
catch [UnauthorizedAccessException] { $denied = $true }
if (-not $denied) { throw "Runtime account can modify deployed application files." }
if (-not [IO.File]::ReadAllText((Join-Path $Root "app/package.json"))) { throw "Runtime account cannot read its deployed application." }
Write-Output "PASS: non-administrator runtime; owner document and private credentials denied; deployed application read-only."
