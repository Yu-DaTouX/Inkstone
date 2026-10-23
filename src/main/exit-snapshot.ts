import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerStatus } from '../shared/ipc'
import { YAN_DIR } from './paths'

export const EXIT_SNAPSHOT_FILE = join(YAN_DIR, 'exit-snapshot.json')

export type ExitSnapshotMode = 'save' | 'interrupt'

export interface ExitSnapshot {
  version: 1
  at: number
  mode: ExitSnapshotMode
  runners: Array<Pick<RunnerStatus,
    | 'id'
    | 'runId'
    | 'sessionFile'
    | 'sessionId'
    | 'projectId'
    | 'generation'
    | 'cwd'
    | 'running'
    | 'waiting'
    | 'failed'
    | 'conn'
    | 'createdAt'
    | 'lastActiveAt'>>
}

export async function writeExitSnapshot(mode: ExitSnapshotMode, statuses: RunnerStatus[]): Promise<ExitSnapshot> {
  const snapshot: ExitSnapshot = {
    version: 1,
    at: Date.now(),
    mode,
    runners: statuses.map((status) => ({
      id: status.id,
      runId: status.runId,
      ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
      ...(status.sessionId ? { sessionId: status.sessionId } : {}),
      ...(status.projectId ? { projectId: status.projectId } : {}),
      generation: status.generation,
      cwd: status.cwd,
      running: status.running,
      waiting: status.waiting,
      failed: status.failed,
      conn: status.conn,
      createdAt: status.createdAt,
      lastActiveAt: status.lastActiveAt
    }))
  }

  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${EXIT_SNAPSHOT_FILE}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  await rename(temp, EXIT_SNAPSHOT_FILE)
  return snapshot
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function flag(value: unknown): boolean {
  return value === true
}

function restoreRunner(value: unknown): ExitSnapshot['runners'][number] | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const id = text(source.id)
  const cwd = text(source.cwd)
  if (!id || !cwd) return null
  const sessionFile = text(source.sessionFile)
  const sessionId = text(source.sessionId)
  const projectId = text(source.projectId)
  return {
    id,
    runId: text(source.runId) ?? id,
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(projectId ? { projectId } : {}),
    generation: count(source.generation, 1),
    cwd,
    running: flag(source.running),
    waiting: flag(source.waiting),
    failed: flag(source.failed),
    conn: source.conn === 'ready' || source.conn === 'starting' || source.conn === 'error' ? source.conn : 'exited',
    createdAt: count(source.createdAt, 0),
    lastActiveAt: count(source.lastActiveAt, 0)
  }
}

export async function readExitSnapshot(): Promise<ExitSnapshot | null> {
  let raw: string
  try {
    raw = await readFile(EXIT_SNAPSHOT_FILE, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const source = parsed as { version?: unknown; at?: unknown; mode?: unknown; runners?: unknown } | null
  if (!source || typeof source !== 'object' || source.version !== 1) return null
  if (source.mode !== 'save' && source.mode !== 'interrupt') return null
  if (!Array.isArray(source.runners)) return null
  const runners = source.runners.map(restoreRunner).filter((runner): runner is ExitSnapshot['runners'][number] => !!runner)
  return { version: 1, at: count(source.at, 0), mode: source.mode, runners }
}

export async function clearExitSnapshot(): Promise<void> {
  await rm(EXIT_SNAPSHOT_FILE, { force: true })
}

export function pickRestoreRunner(snapshot: ExitSnapshot): ExitSnapshot['runners'][number] | undefined {
  const usable = snapshot.runners.filter((runner) => runner.sessionFile)
  if (!usable.length) return undefined
  const interrupted = usable.filter((runner) => runner.running)
  if (interrupted.length) return interrupted.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  return [...usable].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
}
