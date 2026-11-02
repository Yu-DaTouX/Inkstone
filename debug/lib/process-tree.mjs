import { execFileSync } from 'node:child_process'

const QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress'

function kindOf(process, root) {
  if (process === root) return 'main'
  const command = process.CommandLine ?? ''
  const name = (process.Name ?? '').toLowerCase()
  if (/--type=renderer/.test(command)) return 'renderer'
  if (/--type=gpu/.test(command)) return 'gpu'
  if (/--type=utility/.test(command)) return 'utility'
  if (/--type=/.test(command)) return 'chromium'
  if (name === 'electron.exe' || name === 'node.exe') return 'pi'
  return 'tools'
}

export function sampleProcessTree(marker) {
  let all
  try {
    all = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', QUERY], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true }))
  } catch (error) {
    return { at: Date.now(), error: String(error?.message ?? error).slice(0, 200), processes: [] }
  }
  const byId = new Map(all.map((p) => [p.ProcessId, p]))
  const seed = all.find((p) => (p.CommandLine ?? '').includes(marker))
  if (!seed) return { at: Date.now(), error: 'no process matched', processes: [] }
  let root = seed
  while (byId.get(root.ParentProcessId)?.Name?.toLowerCase() === 'electron.exe') root = byId.get(root.ParentProcessId)
  const tree = [root]
  const visit = (pid) => {
    for (const p of all) if (p.ParentProcessId === pid && !tree.includes(p)) { tree.push(p); visit(p.ProcessId) }
  }
  visit(root.ProcessId)
  return {
    at: Date.now(),
    processes: tree.map((p) => ({
      pid: p.ProcessId,
      kind: kindOf(p, root),
      workingSetMB: Math.round(Number(p.WorkingSetSize ?? 0) / 1048576),
      privateMB: Math.round(Number(p.PrivatePageCount ?? 0) / 1048576),
      cpuMs: (Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0)) / 10000
    }))
  }
}

export function memoryByKind(sample) {
  const out = {}
  for (const p of sample.processes) {
    const slot = out[p.kind] ??= { count: 0, workingSetMB: 0, privateMB: 0 }
    slot.count++
    slot.workingSetMB += p.workingSetMB
    slot.privateMB += p.privateMB
  }
  out.total = sample.processes.reduce((a, p) => ({ count: a.count + 1, workingSetMB: a.workingSetMB + p.workingSetMB, privateMB: a.privateMB + p.privateMB }), { count: 0, workingSetMB: 0, privateMB: 0 })
  if (sample.error) out.error = sample.error
  return out
}

export function cpuByKind(before, after) {
  const wall = Math.max(1, after.at - before.at)
  const start = new Map(before.processes.map((p) => [p.pid, p.cpuMs]))
  const out = {}
  for (const p of after.processes) {
    const used = p.cpuMs - (start.get(p.pid) ?? 0)
    out[p.kind] = (out[p.kind] ?? 0) + used
  }
  return Object.fromEntries(Object.entries(out).map(([kind, ms]) => [kind, Math.round((ms / wall) * 100)]))
}
