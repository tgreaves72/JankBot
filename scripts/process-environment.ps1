function Clear-DemoProcessEnvironment {
  $allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in @("SystemRoot","WINDIR","SystemDrive","TEMP","TMP","USERPROFILE","USERNAME","USERDOMAIN","LOCALAPPDATA","APPDATA","PATH","PATHEXT","COMPUTERNAME","PROGRAMDATA","PROGRAMFILES","PROGRAMFILES(X86)","ProgramW6432","CommonProgramFiles","CommonProgramFiles(X86)","ALLUSERSPROFILE","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS","OS","PSModulePath","OLLAMA_MODELS")) {
    $allowed.Add($name) | Out-Null
  }
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    if (-not $allowed.Contains([string]$name)) { Remove-Item -LiteralPath ("Env:" + [string]$name) -ErrorAction Stop }
  }
}
