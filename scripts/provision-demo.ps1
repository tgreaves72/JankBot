param(
  [ValidateRange(1024,65535)][int]$Port = 3000,
  [Parameter(Mandatory=$true)][string]$PublicOrigin
)
$ErrorActionPreference = "Stop"
$principal = [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run the employer demo provisioning command from an Administrator PowerShell. It creates a non-administrator service account." }
if (-not $PublicOrigin.StartsWith("https://")) { throw "An HTTPS public origin is required." }
$project = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:ProgramData "JankBotEmployerDemo"
$private = Join-Path $project ".runtime"
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$marker = Join-Path $root "managed.json"
if ((Test-Path -LiteralPath $root) -and -not (Test-Path -LiteralPath $marker)) {
  if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-ChildItem -LiteralPath $root -Force)) {
    throw "Deployment directory exists without a JankBot ownership marker. Refusing to modify it."
  }
}
if (Test-Path -LiteralPath $marker) {
  $managed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($managed.OwnerSid -ne $owner.Value) { throw "This demo belongs to another Windows account." }
  if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Deployment directory cannot be a linked path." }
}
New-Item -ItemType Directory -Path $root,$private -Force | Out-Null
if (-not (Test-Path -LiteralPath $marker)) { [pscustomobject]@{OwnerSid=$owner.Value} | ConvertTo-Json | Set-Content -LiteralPath $marker }
$credentialPath = Join-Path $private "demo-account.xml"
if (-not (Test-Path -LiteralPath $credentialPath)) {
  $managed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($managed.RuntimeSid) { throw "The encrypted service credential is missing. Provisioning cannot recover it automatically." }
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $username = "JankBot_" + [Guid]::NewGuid().ToString('N').Substring(0,8)
  $password = ConvertTo-SecureString ([Convert]::ToBase64String($bytes) + "aA1!") -AsPlainText -Force
  $account = New-LocalUser -Name $username -Password $password -PasswordNeverExpires -UserMayNotChangePassword -Description "Restricted JankBot employer demo runtime"
  Add-LocalGroupMember -SID ([System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-545")) -Member $account
  $credential = [pscredential]::new("$env:COMPUTERNAME\$username", $password)
  $credential | Export-Clixml -LiteralPath $credentialPath
  [pscustomobject]@{OwnerSid=$owner.Value;RuntimeSid=$account.SID.Value;UserName=$username} | ConvertTo-Json | Set-Content -LiteralPath $marker
} else {
  $credential = Import-Clixml -LiteralPath $credentialPath
  $managed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  $account = Get-LocalUser -Name $managed.UserName
  if ($account.SID.Value -ne $managed.RuntimeSid) { throw "Service account identity changed." }
}
if (Get-LocalGroupMember -SID ([System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")) | Where-Object SID -eq $account.SID) { throw "Demo account must not be an administrator." }

function Set-PrivateAcl([string]$Path, [bool]$RuntimeWrite = $false, [bool]$RuntimeRead = $true) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($owner.Value, "S-1-5-18", "S-1-5-32-544")) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid), "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))
  }
  if ($RuntimeRead) {
    $rights = if ($RuntimeWrite) { "Modify" } else { "ReadAndExecute" }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($account.SID, $rights, "ContainerInherit,ObjectInherit", "None", "Allow"))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
Set-PrivateAcl $private $false $false
& icacls $project /deny "*$($account.SID.Value):(OI)(CI)F" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not deny the runtime account access to the original workspace." }
Set-PrivateAcl $root
foreach ($directory in @("app", "app/src", "app/public", "app/scripts", "data", "config", "state", "logs", "models")) {
  $path = Join-Path $root $directory
  New-Item -ItemType Directory -Path $path -Force | Out-Null
}
Set-PrivateAcl (Join-Path $root "state") $true
Set-PrivateAcl (Join-Path $root "logs") $true
Set-PrivateAcl (Join-Path $root "models") $true
foreach ($file in @("server.js", "package.json", "package-lock.json")) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination (Join-Path $root "app/$file") -Force }
$fuseDestination = Join-Path $root "app/node_modules/fuse.js/dist"
New-Item -ItemType Directory -Path $fuseDestination -Force | Out-Null
foreach ($file in @("package.json", "LICENSE")) { Copy-Item -LiteralPath (Join-Path $project "node_modules/fuse.js/$file") -Destination (Join-Path $root "app/node_modules/fuse.js/$file") -Force }
Copy-Item -LiteralPath (Join-Path $project "node_modules/fuse.js/dist/fuse.cjs") -Destination (Join-Path $fuseDestination "fuse.cjs") -Force
foreach ($directory in @("src", "public")) {
  Get-ChildItem -LiteralPath (Join-Path $project $directory) -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $root "app/$directory/$($_.Name)") -Force }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "resource-guard.ps1") -Destination (Join-Path $root "app/scripts/resource-guard.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "verify-demo-account.ps1") -Destination (Join-Path $root "app/scripts/verify-demo-account.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "verify-demo-node.js") -Destination (Join-Path $root "app/scripts/verify-demo-node.js") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "process-environment.ps1") -Destination (Join-Path $root "app/scripts/process-environment.ps1") -Force
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot "prepare-snapshot.js") (Join-Path $project "data/oracle-cards.compact.json") (Join-Path $root "data/oracle-cards.compact.jsonl")
if ($LASTEXITCODE -ne 0) { throw "Read-only card snapshot creation failed." }
Copy-Item -LiteralPath (Join-Path $project "data/metadata.json") -Destination (Join-Path $root "data/metadata.json") -Force
Copy-Item -LiteralPath (Join-Path $project "data/combos.jsonl") -Destination (Join-Path $root "data/combos.jsonl") -Force
$modelRoot = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $env:USERPROFILE ".ollama/models" }
$manifestRelative = "manifests/registry.ollama.ai/library/qwen2.5/0.5b"
$manifest = Get-Content -LiteralPath (Join-Path $modelRoot $manifestRelative) -Raw | ConvertFrom-Json
$destination = Join-Path $root "models/$manifestRelative"
New-Item -ItemType Directory -Path (Split-Path -Parent $destination),(Join-Path $root "models/blobs") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $modelRoot $manifestRelative) -Destination $destination -Force
foreach ($layer in @($manifest.config) + @($manifest.layers)) {
  if ($layer.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw "Invalid model blob digest." }
  $blob = $layer.digest.Replace(':','-')
  $target = Join-Path $root "models/blobs/$blob"
  if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath (Join-Path $modelRoot "blobs/$blob") -Destination $target }
}
$node = (Get-Command node -ErrorAction Stop).Source
$ollama = Join-Path $env:LOCALAPPDATA "Programs/Ollama/ollama.exe"
if (-not (Test-Path -LiteralPath $ollama)) { throw "Ollama executable not found." }
# Grant only the Ollama installation directory, never the user's profile or model directory.
$ollamaDir = Split-Path -Parent $ollama
& icacls $ollamaDir /grant "*$($account.SID.Value):(OI)(CI)RX" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not grant read access to the Ollama installation." }
[pscustomobject]@{Port=$Port;PublicOrigin=$PublicOrigin;NodeExe=$node;OllamaExe=$ollama} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root "config/runtime.json")
& $node (Join-Path $PSScriptRoot "manage-demo.js") create $root $private
if ($LASTEXITCODE -ne 0) { throw "Employer access provisioning failed." }
& $node (Join-Path $PSScriptRoot "manage-demo.js") link $root $private "Resume and portfolio" $PublicOrigin
if ($LASTEXITCODE -ne 0) { throw "One-click demo link provisioning failed." }
Write-Output "Restricted demo account and deployment prepared. One-click link: $private/jankbot-link.txt"
