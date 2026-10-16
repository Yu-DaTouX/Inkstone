import { mkdir, rename, writeFile } from 'node:fs/promises'
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
