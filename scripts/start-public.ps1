param([ValidateRange(1024,65535)][int]$Port = 3000, [string]$PublicOrigin = "")
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -eq 5) { $env:PSModulePath = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/Modules" }
. (Join-Path $PSScriptRoot "process-environment.ps1")
Clear-DemoProcessEnvironment
$project = Split-Path -Parent $PSScriptRoot
$root = Join-Path $env:ProgramData "JankBotEmployerDemo"
$private = Join-Path $project ".runtime"
if (-not $PublicOrigin) {
  $tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
  $exe = if ($tailscaleCommand) { $tailscaleCommand.Source } else { Join-Path $env:ProgramFiles "Tailscale/tailscale.exe" }
  $status = (& $exe status --json | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $status.BackendState -ne "Running" -or -not $status.Self.DNSName) { throw "Connect Tailscale before starting the employer demo." }
  $PublicOrigin = "https://$($status.Self.DNSName.TrimEnd('.'))"
}
foreach ($number in @($Port,11435)) {
  if (Get-NetTCPConnection -LocalPort $number -State Listen -ErrorAction SilentlyContinue) { throw "Port $number is occupied. Stop the existing demo before starting it again." }
}
& (Join-Path $PSScriptRoot "provision-demo.ps1") -Port $Port -PublicOrigin $PublicOrigin
$credential = Import-Clixml -LiteralPath (Join-Path $private "demo-account.xml")
$control = Get-Content -LiteralPath (Join-Path $private "host-control.json") -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($control.token)" }
$powershell = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/powershell.exe"
$guard = Join-Path $root "app/scripts/resource-guard.ps1"
$verifyScript = Join-Path $root "app/scripts/verify-demo-account.ps1"
$verifyArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$verifyScript`"", "-OwnerFile", "`"$project/README.md`"", "-PrivateFile", "`"$private/host-control.json`"", "-Root", "`"$root`"")
$verification = Start-Process -FilePath $powershell -ArgumentList $verifyArgs -Credential $credential -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root "logs/account-verification.log") -RedirectStandardError (Join-Path $root "logs/account-verification-error.log") -Wait
if ($verification.ExitCode -ne 0) { throw "Restricted account access checks failed. Inspect the account-verification logs." }
$supervisors = @()
try {
  foreach ($kind in @("ollama", "app")) {
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$guard`"", "-Kind", $kind, "-Root", "`"$root`"")
    $supervisor = Start-Process -FilePath $powershell -ArgumentList $arguments -Credential $credential -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root "logs/$kind-supervisor.log") -RedirectStandardError (Join-Path $root "logs/$kind-supervisor-error.log")
    $supervisors += $supervisor
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      if ($supervisor.HasExited) { throw "$kind supervisor exited. Inspect $root/logs/$kind-supervisor-error.log." }
      try {
        if ($kind -eq "ollama") { $null = Invoke-RestMethod "http://127.0.0.1:11435/api/tags" -TimeoutSec 3 }
        else {
          $ready = Invoke-RestMethod "http://127.0.0.1:$Port/api/ready" -Headers $headers -TimeoutSec 3
          if (-not $ready.ready) { throw "Demo not ready." }
        }
        $healthy = $true
        break
      } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $healthy) { throw "$kind failed its readiness check." }
  }
  $identities = @($supervisors | ForEach-Object {
    $running = Get-Process -Id $_.Id -IncludeUserName
    [pscustomobject]@{Id=$running.Id;UserName=$running.UserName;Started=$running.StartTime.ToUniversalTime().ToString('o')}
  })
  [pscustomobject]@{Root=$root;Port=$Port;Supervisors=$identities} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $private "demo-processes.json")
  Write-Output "Employer demo started as a non-administrator account with enforced resource limits."
  Write-Output "Public origin: $PublicOrigin"
  Write-Output "Resume and portfolio hyperlink: $private/jankbot-link.txt"
  Write-Output "Publish with npm run publish:free. Stop with npm run stop:public."
} catch {
  $launchFailure = $_
  foreach ($process in $supervisors) {
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { & taskkill /PID $process.Id /T /F | Out-Null }
  }
  throw $launchFailure
}
