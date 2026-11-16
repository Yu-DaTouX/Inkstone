import { existsSync } from 'node:fs'
import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const SAVED_AT_MARKER = '.inkstone-saved-at'
const unstampedOutputs = new Map<string, number>()

interface StampIo {
  utimes: (path: string, atime: Date, mtime: Date) => Promise<void>
  writeFile: (path: string, data: string) => Promise<void>
}

export async function stampSavedOutputs(target: string, at = new Date(), io: StampIo = { utimes, writeFile }): Promise<'utimes' | 'marker' | 'memory'> {
  const key = resolve(target)
  const marker = join(target, SAVED_AT_MARKER)
  const stamp = String(at.getTime())
  if (await io.utimes(target, at, at).then(() => true, () => false)) {
    if (existsSync(marker)) await io.writeFile(marker, stamp).catch(() => rm(marker, { force: true }).catch(() => undefined))
    unstampedOutputs.delete(key)
    return 'utimes'
  }
  if (await io.writeFile(marker, stamp).then(() => true, () => false)) {
    unstampedOutputs.delete(key)
    return 'marker'
  }
  console.warn('[subagent] could not record when saved outputs were saved; treating them as just saved', target)
  unstampedOutputs.set(key, Math.max(unstampedOutputs.get(key) ?? 0, at.getTime()))
  return 'memory'
}

export async function savedOutputsAt(target: string, dirMtimeMs: number): Promise<number> {
  const marked = Number((await readFile(join(target, SAVED_AT_MARKER), 'utf8').catch(() => '')).trim())
  const recorded = Number.isFinite(marked) && marked > 0 ? marked : dirMtimeMs
  return Math.max(recorded, unstampedOutputs.get(resolve(target)) ?? 0)
}
