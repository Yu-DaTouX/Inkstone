import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import { PROGRAM_STATUS_REPLY, TerminalProgramStatusTracker } from './terminal-status'
import { clampRounded } from '../shared/clamp'
import {
  EXITED_REPLAY_CHARS,
  MAX_UNOWNED_TERMINALS,
  OutputBatcher,
  appendReplay,
  normalizeOwner,
  planOwnerSlot
} from './terminal-registry'
import type { TerminalProgramStatus } from '../shared/ipc'

export { safeTerminalCut } from './terminal-registry'

const requireNative = createRequire(import.meta.url)

export interface TerminalSessionInfo {
  id: string
  title: string
  shell: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
  status?: TerminalProgramStatus
  owner?: string
}

export interface TerminalSnapshot extends TerminalSessionInfo {
  buffer: string
  seq: number
}

export interface TerminalStartOptions {
  cwd?: string
  fallbackCwd?: string
  cols?: number
  rows?: number
  executable?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  owner?: string
  title?: string
}

interface TerminalEntry {
  info: TerminalSessionInfo
  pty: IPty
  buffer: string
  seq: number
  tracker: TerminalProgramStatusTracker
}

export type TerminalSink = (event:
  | { kind: 'data'; id: string; data: string; seq: number }
  | { kind: 'status'; id: string; status?: TerminalProgramStatus }
  | { kind: 'exit'; id: string; exitCode: number | null }) => void

let loadError: string | null = null
let ptyModule: typeof import('node-pty') | null = null

function ptyOrNull(): typeof import('node-pty') | null {
  if (ptyModule) return ptyModule
  if (loadError) return null
  try {
    ptyModule = requireNative('node-pty') as typeof import('node-pty')
    return ptyModule
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
    return null
  }
}

export function terminalAvailable(): boolean {
  return ptyOrNull() !== null
}

export function terminalLoadError(): string | null {
  return loadError
}

const sessions = new Map<string, TerminalEntry>()
let sink: TerminalSink | null = null

const batcher = new OutputBatcher((id, data) => {
  const entry = sessions.get(id)
  if (!entry) return
  entry.seq += 1
  sink?.({ kind: 'data', id, data, seq: entry.seq })
})

export function setTerminalSink(next: TerminalSink | null): void {
  sink = next
}

function findExe(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    const pwsh = findExe('pwsh.exe')
    if (pwsh) return { shell: pwsh, args: ['-NoLogo'] }
    const windowsPowerShell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(windowsPowerShell)) return { shell: windowsPowerShell, args: ['-NoLogo'] }
    return { shell: process.env.ComSpec || 'cmd.exe', args: [] }
  }
  return { shell: process.env.SHELL || '/bin/sh', args: [] }
}

function validDir(candidate: string | undefined): string | null {
  if (!candidate) return null
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

function clampDimension(value: number | undefined, fallback: number): number {
  return clampRounded(value, 2, 1000, fallback)
}

function titleOf(shell: string, cwd: string): string {
  const shellName = basename(shell.replace(/\.exe$/i, '')) || shell
  const dirName = basename(cwd) || cwd
  return `${shellName} · ${dirName}`
}

function snapshotOf(entry: TerminalEntry): TerminalSnapshot {
  batcher.flush(entry.info.id)
  return { ...entry.info, buffer: entry.buffer, seq: entry.seq }
}

function setEntryStatus(entry: TerminalEntry, status: TerminalProgramStatus | undefined): void {
  if (status) {
    entry.info = { ...entry.info, status }
    return
  }
  if (!entry.info.status) return
  const next = { ...entry.info }
  delete next.status
  entry.info = next
}

function applyStatusChunk(entry: TerminalEntry, data: string, id: string): void {
  const { queries, changed } = entry.tracker.consume(data)
  for (let i = 0; i < queries; i += 1) {
    try {
      entry.pty.write(PROGRAM_STATUS_REPLY)
    } catch {
    }
  }
  if (!changed) return
  setEntryStatus(entry, entry.tracker.status)
  sink?.({ kind: 'status', id, status: entry.tracker.status })
}

function emitBuffered(id: string): void {
  batcher.flush(id)
  const entry = sessions.get(id)
  if (!entry || !sink) return
  if (entry.buffer) sink({ kind: 'data', id, data: entry.buffer, seq: entry.seq })
  if (entry.info.status) sink({ kind: 'status', id, status: entry.info.status })
  if (!entry.info.alive) sink({ kind: 'exit', id, exitCode: entry.info.exitCode ?? null })
}

export function terminalEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(platform === 'win32' && env.PI_PROGRAM_STATUS === undefined ? { PI_PROGRAM_STATUS: '1' } : {}),
    TERM: 'xterm-256color'
  }
}

export function startTerminal(options: TerminalStartOptions = {}): TerminalSnapshot | null {
  const pty = ptyOrNull()
  if (!pty) return null

  const cwd = validDir(options.cwd) ?? validDir(options.fallbackCwd) ?? process.cwd()
  const cols = clampDimension(options.cols, 80)
  const rows = clampDimension(options.rows, 24)
  const resolved = options.executable ? { shell: options.executable, args: options.args ?? [] } : defaultShell()
  const shell = resolved.shell
  const id = randomUUID()
  const owner = normalizeOwner(options.owner)
  if (owner) {
    const slot = planOwnerSlot([...sessions.values()].map((entry) => entry.info), owner)
    if (!slot.allowed) return null
    for (const evicted of slot.evict) killTerminal(evicted)
  } else if (sessions.size >= MAX_UNOWNED_TERMINALS) {
    return null
  }

  let child: IPty
  try {
    child = pty.spawn(shell, resolved.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: terminalEnvironment({ ...process.env, ...options.env })
    })
  } catch {
    return null
  }

  const info: TerminalSessionInfo = {
    id,
    title: options.title?.trim().slice(0, 60) || titleOf(shell, cwd),
    shell,
    cwd,
    cols,
    rows,
    alive: true,
    exitCode: null,
    ...(owner ? { owner } : {})
  }
  const entry: TerminalEntry = { info, pty: child, buffer: '', seq: 0, tracker: new TerminalProgramStatusTracker() }
  sessions.set(id, entry)

  child.onData((data) => {
    const current = sessions.get(id)
    if (!current) return
    applyStatusChunk(current, data, id)
    current.buffer = appendReplay(current.buffer, data)
    batcher.push(id, data)
  })
  child.onExit(({ exitCode }) => {
    const current = sessions.get(id)
    if (!current) return
    batcher.flush(id)
    current.buffer = appendReplay('', current.buffer, EXITED_REPLAY_CHARS, 0)
    const statusCleared = current.tracker.exit()
    current.info = { ...current.info, alive: false, exitCode: exitCode ?? null }
    if (statusCleared) {
      setEntryStatus(current, undefined)
      sink?.({ kind: 'status', id, status: undefined })
    }
    sink?.({ kind: 'exit', id, exitCode: exitCode ?? null })
  })

  return snapshotOf(entry)
}

export function writeTerminal(id: string, data: string): boolean {
  const entry = sessions.get(id)
  if (!entry || !entry.info.alive) return false
  try {
    entry.pty.write(data)
    return true
  } catch {
    return false
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const entry = sessions.get(id)
  if (!entry || !entry.info.alive) return false
  const nextCols = clampDimension(cols, entry.info.cols)
  const nextRows = clampDimension(rows, entry.info.rows)
  entry.info = { ...entry.info, cols: nextCols, rows: nextRows }
  try {
    entry.pty.resize(nextCols, nextRows)
    return true
  } catch {
    return false
  }
}

export function killTerminal(id: string): boolean {
  const entry = sessions.get(id)
  if (!entry) return false
  batcher.drop(id)
  try {
    entry.pty.kill()
  } catch {
  }
  sessions.delete(id)
  if (entry.info.status) sink?.({ kind: 'status', id, status: undefined })
  return true
}

export function terminalProcessId(id: string): number | null {
  const entry = sessions.get(id)
  if (!entry || !entry.info.alive) return null
  const pid = entry.pty.pid
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export function hasWorkingTerminal(): boolean {
  for (const entry of sessions.values()) {
    if (entry.info.alive && entry.info.status?.state === 'working') return true
  }
  return false
}

export function hasBlockedTerminal(): boolean {
  for (const entry of sessions.values()) {
    if (entry.info.alive && entry.info.status?.state === 'blocked') return true
  }
  return false
}

export function listTerminals(): TerminalSnapshot[] {
  return [...sessions.values()].map(snapshotOf)
}

export function readTerminal(id: string): TerminalSnapshot | null {
  const entry = sessions.get(id)
  return entry ? snapshotOf(entry) : null
}

export function attachTerminal(id: string): TerminalSnapshot | null {
  const entry = sessions.get(id)
  if (!entry) return null
  emitBuffered(id)
  return snapshotOf(entry)
}

export function clearTerminal(id: string): boolean {
  const entry = sessions.get(id)
  if (!entry) return false
  batcher.drop(id)
  entry.buffer = ''
  return true
}

function sameOwnerKey(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

export function closeTerminalsForOwner(owner: string): number {
  const key = normalizeOwner(owner)
  if (!key) return 0
  let closed = 0
  for (const [id, entry] of [...sessions]) {
    const entryOwner = entry.info.owner
    if (!entryOwner || !sameOwnerKey(entryOwner, key)) continue
    if (killTerminal(id)) closed += 1
  }
  return closed
}

export function disposeTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
