param(
  [Parameter(Mandatory=$true)][int]$RootPid
)
$ErrorActionPreference = 'Stop'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, UserModeTime, KernelModeTime, WorkingSetSize, PrivatePageCount, PeakWorkingSetSize, PeakPagefileUsage
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add($RootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    $ppid = [int]$p.ParentProcessId
    $pid2 = [int]$p.ProcessId
    if ($ids.Contains($ppid) -and -not $ids.Contains($pid2)) { [void]$ids.Add($pid2); $changed = $true }
  }
}
$cpu = [long]0; $ws = [long]0; $priv = [long]0; $peakWs = [long]0; $peakPriv = [long]0; $n = 0; $pids = @()
$rootCpu = [long]0; $rootWs = [long]0; $rootPriv = [long]0
foreach ($p in $all) {
  if ([int]$p.ProcessId -eq $RootPid) {
    $rootCpu = [long]$p.UserModeTime + [long]$p.KernelModeTime
    $rootWs = [long]$p.WorkingSetSize
    $rootPriv = [long]$p.PrivatePageCount
  }
  if ($ids.Contains([int]$p.ProcessId)) {
    $cpu += [long]$p.UserModeTime + [long]$p.KernelModeTime
    $ws += [long]$p.WorkingSetSize
    $priv += [long]$p.PrivatePageCount
    $peakWs += ([long]$p.PeakWorkingSetSize) * 1024
    $peakPriv += ([long]$p.PeakPagefileUsage) * 1024
    $n += 1
    $pids += [int]$p.ProcessId
  }
}
[pscustomobject]@{
  ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  pids = $pids
  count = $n
  cpuMs = [math]::Round($cpu / 10000.0, 1)
  workingSetBytes = $ws
  privateBytes = $priv
  peakWorkingSetBytes = $peakWs
  peakPrivateBytes = $peakPriv
  rootCpuMs = [math]::Round($rootCpu / 10000.0, 1)
  rootWorkingSetBytes = $rootWs
  rootPrivateBytes = $rootPriv
} | ConvertTo-Json -Compress
