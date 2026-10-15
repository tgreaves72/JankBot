param(
  [Parameter(Mandatory=$true)][ValidateSet("app","ollama")][string]$Kind,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -eq 5) { $env:PSModulePath = Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/Modules" }
. (Join-Path $PSScriptRoot "process-environment.ps1")
Clear-DemoProcessEnvironment
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DemoJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessTime, PerJobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic; public Io Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Cpu { public uint Flags, Rate; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  static void Set<T>(IntPtr job, int kind, T info) where T : struct {
    int size = Marshal.SizeOf(typeof(T)); IntPtr ptr = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(info, ptr, false); if (!SetInformationJobObject(job, kind, ptr, (uint)size)) throw new Win32Exception(); }
    finally { Marshal.FreeHGlobal(ptr); }
  }
  public static IntPtr Create(uint megabytes, uint cpuPercent, uint processCount) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    try {
      var limits = new Extended();
      limits.Basic.Flags = 0x2000 | 0x400 | 0x8; // kill on close, job memory, active processes
      limits.Basic.ActiveProcesses = processCount;
      limits.JobMemory = new UIntPtr((ulong)megabytes * 1024 * 1024);
      Set(job, 9, limits);
      Set(job, 15, new Cpu { Flags = 0x1 | 0x4, Rate = cpuPercent * 100 });
      return job;
    } catch { CloseHandle(job); throw; }
  }
  public static void Attach(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
  }
}
'@
$runtime = Get-Content -LiteralPath (Join-Path $Root "config/runtime.json") -Raw | ConvertFrom-Json
if ($Kind -eq "app") {
  $env:NODE_ENV = "production"
  $env:HOST = "127.0.0.1"
  $env:PORT = [string]$runtime.Port
  $env:PUBLIC_ORIGIN = $runtime.PublicOrigin
  $env:OLLAMA_BASE_URL = "http://127.0.0.1:11435"
  $env:OLLAMA_MODEL = $runtime.Model
  $env:DATA_DIR = Join-Path $Root "data"
  $env:DEMO_CONFIG = Join-Path $Root "config/demo-access.json"
  $env:DEMO_USAGE_PATH = Join-Path $Root "state/demo-usage.json"
  $exe = $runtime.NodeExe
  $source = Join-Path $Root "app"
  $read = @($source, $env:DATA_DIR, $env:DEMO_CONFIG, $env:DEMO_USAGE_PATH, "$($env:DEMO_USAGE_PATH).tmp")
  $write = @($env:DEMO_USAGE_PATH, "$($env:DEMO_USAGE_PATH).tmp")
  $arguments = @("--permission", "--disable-proto=throw", "--max-old-space-size=512")
  foreach ($item in $read) { $arguments += "`"--allow-fs-read=$item`"" }
  foreach ($item in $write) { $arguments += "`"--allow-fs-write=$item`"" }
  $preflight = Start-Process -FilePath $exe -ArgumentList ($arguments + '"scripts/verify-demo-node.js"') -WorkingDirectory $source -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $Root "logs/node-permission-verification.log") -RedirectStandardError (Join-Path $Root "logs/node-permission-verification-error.log")
  if ($preflight.ExitCode -ne 0) { throw "Node permission checks failed. No public server was started." }
  $arguments += '"server.js"'
  $job = [DemoJob]::Create(768, 10, 1)
} else {
  $env:OLLAMA_HOST = "127.0.0.1:11435"
  $env:OLLAMA_MODELS = Join-Path $Root "models"
  $env:OLLAMA_NUM_PARALLEL = "1"
  $env:OLLAMA_MAX_LOADED_MODELS = "1"
  $env:OLLAMA_MAX_QUEUE = "1"
  $env:OLLAMA_NO_CLOUD = "1"
  $exe = $runtime.OllamaExe
  $arguments = @("serve")
  $source = $Root
  $job = [DemoJob]::Create(2048, 25, 4)
}
$child = $null
try {
  $child = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $source -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Root "logs/$Kind.log") -RedirectStandardError (Join-Path $Root "logs/$Kind-error.log")
  [DemoJob]::Attach($job, $child.Handle)
  $child.Id | Set-Content -LiteralPath (Join-Path $Root "state/$Kind.pid")
  $child.WaitForExit()
  exit $child.ExitCode
} finally {
  [DemoJob]::CloseHandle($job) | Out-Null
  if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
}
