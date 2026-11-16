import { lstat, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const TARGET = String.raw`.+\.[A-Za-z0-9]{1,8}`
const PID_TMP = new RegExp(String.raw`^${TARGET}\.(\d{1,10})(?:\.(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{12,}))?\.tmp$`)
const TMP_PID = new RegExp(String.raw`^${TARGET}\.tmp-(\d{1,10})$`)

export function tempOwnerPid(name: string): number | null {
  const match = PID_TMP.exec(name) ?? TMP_PID.exec(name)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export interface StaleTempSweepOptions {
  dirs: readonly string[]
  now?: number
  maxAgeMs?: number
  isAlive?: (pid: number) => boolean
}

export async function sweepStaleTemps(options: StaleTempSweepOptions): Promise<string[]> {
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? DAY_MS
  const isAlive = options.isAlive ?? processAlive
  const removed: string[] = []
  for (const dir of new Set(options.dirs.map((item) => resolve(item)))) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const pid = tempOwnerPid(name)
      if (pid === null || pid === process.pid) continue
      const file = join(dir, name)
      try {
        const info = await lstat(file)
        if (!info.isFile() || now - info.mtimeMs < maxAge || isAlive(pid)) continue
        await rm(file, { force: true })
        removed.push(file)
      } catch {
      }
    }
  }
  return removed
}
