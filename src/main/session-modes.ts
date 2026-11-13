import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { SESSION_MODE_FILE, type StoredSessionMode } from '../shared/session-mode'

export function createSessionModes(file: string) {
  const modes = new Map<string, StoredSessionMode>()
  let cleared = false
  const clearStale = (): void => {
    if (cleared) return
    cleared = true
    rmSync(file, { force: true })
  }
  const write = (): void => {
    if (!modes.size) {
      rmSync(file, { force: true })
      return
    }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(modes)), 'utf8')
    renameSync(tmp, file)
  }
  return {
    clearStale,
    get(sessionId: string | undefined): StoredSessionMode | undefined {
      return sessionId ? modes.get(sessionId) : undefined
    },
    set(sessionId: string, mode: StoredSessionMode | undefined): void {
      clearStale()
      const previous = modes.get(sessionId)
      if (mode) modes.set(sessionId, mode)
      else modes.delete(sessionId)
      try {
        write()
      } catch (error) {
        if (previous) modes.set(sessionId, previous)
        else modes.delete(sessionId)
        throw error
      }
    }
  }
}

export const sessionModes = createSessionModes(join(YAN_DIR, SESSION_MODE_FILE))
