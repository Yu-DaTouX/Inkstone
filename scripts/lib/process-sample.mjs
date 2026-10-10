import { execFileSync } from 'node:child_process'

/** Windows process-tree metrics; working sets may count shared pages more than once. */
export function sampleProcessTree(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) throw Error('Windows PID required')
  const script = `$all=@(Get-CimInstance Win32_Process); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); $samplerIds=[Collections.Generic.HashSet[int]]::new(); [void]$samplerIds.Add($PID); do { $changed=$false; foreach($p in $all) { if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed=$true }; if($samplerIds.Contains([int]$p.ParentProcessId) -and $samplerIds.Add([int]$p.ProcessId)) { $changed=$true } } } while($changed); @($ids | Where-Object { -not $samplerIds.Contains($_) } | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Select-Object Id,ProcessName,CPU,WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`
  const output = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${script}`],{encoding:'utf8',windowsHide:true,timeout:15000})
  const raw = output.trim() ? JSON.parse(output) : []
  const items=Array.isArray(raw)?raw:raw?[raw]:[]
  return {at:Date.now(),count:items.length,cpuSeconds:items.reduce((n,p)=>n+(p.CPU||0),0),workingSetMiB:items.reduce((n,p)=>n+p.WorkingSet64,0)/1048576,privateMiB:items.reduce((n,p)=>n+p.PrivateMemorySize64,0)/1048576,processSamples:items.map(p=>({name:p.ProcessName,pid:p.Id,workingSetMiB:p.WorkingSet64/1048576,privateMiB:p.PrivateMemorySize64/1048576}))}
}

/** Also check sampled descendants by PID after their original parent has exited. */
export function remainingProcessIds(ids) {
  if(!ids.length)return []
  if(ids.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('Invalid PID')
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:15000})
  const raw=output.trim()?JSON.parse(output):[]
  return Array.isArray(raw)?raw:[raw]
}
