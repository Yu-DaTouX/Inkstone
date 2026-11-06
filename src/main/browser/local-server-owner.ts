import { execFile } from 'node:child_process'
import type { LocalServerInfo, LocalServerStopResult } from '../../shared/local-servers'
import { readProcessTable, type ProcessRow } from '../terminal-processes'
import { refreshLocalServers, setLocalServerDecorator } from './local-servers'

const NEGATIVE_VERDICT_MS = 30_000
const STOP_WAIT_MS = 2500
const STOP_POLL_MS = 250
const KILL_TIMEOUT_MS = 5000

export function agentOwnedPids(rows: readonly ProcessRow[], roots: readonly number[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid)
    if (list) list.push(row.pid)
    else children.set(row.ppid, [row.pid])
  }
  const owned = new Set<number>()
  const queue = roots.filter((pid) => Number.isInteger(pid) && pid > 0)
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of children.get(parent) ?? []) {
      if (owned.has(child) || roots.includes(child)) continue
      owned.add(child)
      queue.push(child)
    }
  }
  return owned
}

export interface AgentServerTrackerOptions {
  roots: () => number[]
  readRows?: () => Promise<ProcessRow[]>
  now?: () => number
}

export class AgentServerTracker {
  private readonly owned = new Set<number>()
  private readonly notOwnedAt = new Map<number, number>()

  constructor(private readonly options: AgentServerTrackerOptions) {}

  async mark(servers: LocalServerInfo[]): Promise<LocalServerInfo[]> {
    const now = (this.options.now ?? Date.now)()
    const listening = new Set(servers.map((server) => server.pid).filter((pid): pid is number => pid !== undefined))
    for (const pid of this.owned) if (!listening.has(pid)) this.owned.delete(pid)
    for (const pid of this.notOwnedAt.keys()) if (!listening.has(pid)) this.notOwnedAt.delete(pid)
    const roots = this.options.roots()
    const pending = servers.filter((server) => {
      const pid = server.pid
      if (pid === undefined || this.owned.has(pid)) return false
      const checked = this.notOwnedAt.get(pid)
      return checked === undefined || now - checked >= NEGATIVE_VERDICT_MS
    })
    if (roots.length > 0 && pending.length > 0) {
      const rows = await (this.options.readRows ?? (() => readProcessTable(process.platform)))().catch(() => null)
      if (rows) {
        const descendants = agentOwnedPids(rows, roots)
        for (const server of pending) {
          if (server.pid === undefined) continue
          if (descendants.has(server.pid)) {
            this.owned.add(server.pid)
            this.notOwnedAt.delete(server.pid)
          } else this.notOwnedAt.set(server.pid, now)
        }
      }
    }
    return servers.map((server) => (server.pid !== undefined && this.owned.has(server.pid) ? { ...server, agentStarted: true } : server))
  }

  owns(pid: number | undefined): boolean {
    return pid !== undefined && this.owned.has(pid)
  }
}

function killTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: KILL_TIMEOUT_MS, windowsHide: true }, (error) => resolve(!error))
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
      resolve(true)
    } catch {
      resolve(false)
    }
  })
}

export interface LocalServerControl {
  stop(port: number): Promise<LocalServerStopResult>
}

export function installLocalServerControl(roots: () => number[]): LocalServerControl {
  const tracker = new AgentServerTracker({ roots })
  setLocalServerDecorator((servers) => tracker.mark(servers))
  return {
    async stop(port) {
      const server = (await refreshLocalServers()).find((candidate) => candidate.port === port)
      if (!server) return { ok: false, code: 'gone' }
      const pid = server.pid
      if (pid === undefined || pid === process.pid || roots().includes(pid) || !tracker.owns(pid)) return { ok: false, code: 'not-agent' }
      if (!(await killTree(pid))) return { ok: false, code: 'failed' }
      const deadline = Date.now() + STOP_WAIT_MS
      while (Date.now() < deadline) {
        if (!(await refreshLocalServers()).some((candidate) => candidate.port === port && candidate.pid === pid)) return { ok: true }
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
      }
      return { ok: false, code: 'failed' }
    }
  }
}
