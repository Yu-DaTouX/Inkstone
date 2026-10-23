import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isolatedSessionCwd, isolationCwdKey, type AutoIsolationRecord } from './session-isolation'

export const UNUSED_ISOLATION_GRACE_MS = 60_000

export interface IsolationRunnerView {
  id: string
  cwd: string
  isActive: boolean
  busy: boolean
  messageCount: number
}

export interface IsolationCleanupPort {
  records: () => Promise<AutoIsolationRecord[]>
  runners: () => IsolationRunnerView[]
  stopRunner: (id: string) => Promise<unknown>
  hasSavedSession: (record: AutoIsolationRecord) => Promise<boolean>
  discard: (record: AutoIsolationRecord) => Promise<boolean>
  forget: (record: AutoIsolationRecord) => Promise<void>
  now?: () => number
}

export async function hasSavedSessionUnder(sessionsDir: string, record: AutoIsolationRecord): Promise<boolean> {
  const marker = basename(record.worktree).toLowerCase()
  if (!marker) return true
  let dirs: string[]
  try {
    dirs = await readdir(sessionsDir)
  } catch {
    return true
  }
  for (const dir of dirs) {
    if (!dir.toLowerCase().includes(marker)) continue
    const files = await readdir(join(sessionsDir, dir)).catch(() => null)
    if (!files || files.some((name) => name.endsWith('.jsonl'))) return true
  }
  return false
}

export async function discardIdleEmptyIsolations(port: IsolationCleanupPort): Promise<AutoIsolationRecord[]> {
  const now = (port.now ?? Date.now)()
  const discarded: AutoIsolationRecord[] = []
  for (const record of await port.records()) {
    if (now - record.createdAt < UNUSED_ISOLATION_GRACE_MS) continue
    const key = isolationCwdKey(isolatedSessionCwd(record))
    const holders = port.runners().filter((runner) => isolationCwdKey(runner.cwd) === key)
    if (holders.some((runner) => runner.isActive || runner.busy || runner.messageCount > 0)) continue
    if (await port.hasSavedSession(record)) continue
    for (const runner of holders) await port.stopRunner(runner.id)
    if (port.runners().some((runner) => isolationCwdKey(runner.cwd) === key)) continue
    if (!(await port.discard(record))) continue
    await port.forget(record)
    discarded.push(record)
  }
  return discarded
}
