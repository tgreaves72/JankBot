param([Parameter(Mandatory=$true)][string]$Name, [switch]$Revoke, [switch]$Link, [switch]$RotateLink)
$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:ProgramData "JankBotEmployerDemo"
if (([int]$Revoke.IsPresent + [int]$Link.IsPresent + [int]$RotateLink.IsPresent) -gt 1) { throw "Choose one invitation operation." }
$operation = if ($Revoke) { "revoke" } elseif ($RotateLink) { "rotate-link" } elseif ($Link) { "link" } else { "add" }
$origin = if ($Link -or $RotateLink) { (Get-Content -LiteralPath (Join-Path $root "config/runtime.json") -Raw | ConvertFrom-Json).PublicOrigin } else { "" }
& node (Join-Path $PSScriptRoot "manage-demo.js") $operation $root (Join-Path $project ".runtime") $Name $origin
if ($LASTEXITCODE -ne 0) { throw "Invitation update failed." }
Write-Output "Restart the managed demo to apply invitation changes. Existing sessions end on restart."
