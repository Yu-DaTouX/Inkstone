import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { TerminalProcessEntry, TerminalProcessList } from '../shared/ipc'

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
}

const LIST_TIMEOUT_MS = 4000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_LISTED = 40
const WINDOWS_HELPERS = new Set(['conhost.exe', 'openconsole.exe'])

export function parseWindowsProcessCsv(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^"(\d+)","(\d+)","(.*)"$/.exec(raw.trim())
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3].replace(/""/g, '"') })
  }
  return rows
}

export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(raw)
    if (!match) continue
    const command = match[3]
    const name = command.split('/').pop() || command
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name })
  }
  return rows
}

export function descendantProcesses(rows: readonly ProcessRow[], rootPid: number, platform: NodeJS.Platform = process.platform): TerminalProcessEntry[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid)
    if (list) list.push(row)
    else children.set(row.ppid, [row])
  }
  const result: TerminalProcessEntry[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      queue.push(child.pid)
      if (platform === 'win32' && WINDOWS_HELPERS.has(child.name.toLowerCase())) continue
      result.push({ pid: child.pid, name: child.name })
    }
  }
  return result
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

async function readProcessTable(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  if (platform === 'win32') {
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const output = await run(shell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation'
    ])
    return parseWindowsProcessCsv(output)
  }
  return parsePsOutput(await run('ps', ['-A', '-o', 'pid=,ppid=,comm=']))
}

export async function listProcessTree(rootPid: number | null, platform: NodeJS.Platform = process.platform): Promise<TerminalProcessList> {
  if (!rootPid) return { ok: true, processes: [] }
  try {
    const rows = await readProcessTable(platform)
    const processes = descendantProcesses(rows, rootPid, platform)
    return { ok: true, processes: processes.slice(0, MAX_LISTED), ...(processes.length > MAX_LISTED ? { more: processes.length - MAX_LISTED } : {}) }
  } catch {
    return { ok: false, processes: [] }
  }
}
