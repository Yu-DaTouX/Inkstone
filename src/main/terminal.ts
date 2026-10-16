import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import { PROGRAM_STATUS_REPLY, TerminalProgramStatusTracker } from './terminal-status'
import type { TerminalProgramStatus } from '../shared/ipc'

const requireNative = createRequire(import.meta.url)

export const BUFFER_LIMIT = 200_000
const BUFFER_KEEP = 120_000

export function safeTerminalCut(buffer: string, desired: number): number {
  let cut = Math.max(0, desired)
  const newline = buffer.indexOf('\n', cut)
  if (newline >= 0 && newline - cut < 4096) cut = newline + 1
  const esc = buffer.lastIndexOf('\x1b', cut)
  if (esc >= 0) {
    const sequence = buffer.slice(esc + 1, cut)
    const complete = sequence.startsWith('[')
      ? /[\x40-\x7e]$/.test(sequence.slice(1))
      : sequence.startsWith(']')
        ? /\x07$|\x1b\\$/.test(sequence.slice(1))
        : sequence.length >= 1
    if (!complete) cut = esc
  }
  const code = buffer.charCodeAt(cut)
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1
  return cut
}

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
let spawnError: string | null = null
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
  return loadError ?? spawnError
}

const sessions = new Map<string, TerminalEntry>()
let sink: TerminalSink | null = null

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
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.round(n)))
}

function titleOf(shell: string, cwd: string): string {
  const shellName = basename(shell.replace(/\.exe$/i, '')) || shell
  const dirName = basename(cwd) || cwd
  return `${shellName} · ${dirName}`
}

function snapshotOf(entry: TerminalEntry): TerminalSnapshot {
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

  let child: IPty
  try {
    child = pty.spawn(shell, resolved.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: terminalEnvironment({ ...process.env, ...options.env })
    })
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error)
    return null
  }
  spawnError = null

  const info: TerminalSessionInfo = {
    id,
    title: titleOf(shell, cwd),
    shell,
    cwd,
    cols,
    rows,
    alive: true,
    exitCode: null
  }
  const entry: TerminalEntry = { info, pty: child, buffer: '', seq: 0, tracker: new TerminalProgramStatusTracker() }
  sessions.set(id, entry)

  child.onData((data) => {
    const current = sessions.get(id)
    if (!current) return
    applyStatusChunk(current, data, id)
    current.buffer += data
    current.seq += 1
    if (current.buffer.length > BUFFER_LIMIT) {
      const cut = safeTerminalCut(current.buffer, current.buffer.length - BUFFER_KEEP)
      current.buffer = current.buffer.slice(cut)
    }
    sink?.({ kind: 'data', id, data, seq: current.seq })
  })
  child.onExit(({ exitCode }) => {
    const current = sessions.get(id)
    if (!current) return
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
  try {
    entry.pty.kill()
  } catch {
  }
  sessions.delete(id)
  if (entry.info.status) sink?.({ kind: 'status', id, status: undefined })
  return true
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

export function disposeTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
