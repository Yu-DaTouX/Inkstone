import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextInspectSnapshot, type ContextInspectSnapshot } from '../shared/context-inspect'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

function inspectFile(dataDir: string, sessionId: string): string {
  return join(dataDir, 'context-inspect', `${sessionId}.json`)
}

export function saveContextInspect(sessionId: unknown, raw: unknown, dataDir: string = YAN_DIR): boolean {
  const snapshot = parseContextInspectSnapshot(raw)
  if (!snapshot || !isSafeSessionId(sessionId)) return false
  try {
    mkdirSync(join(dataDir, 'context-inspect'), { recursive: true })
    const target = inspectFile(dataDir, sessionId)
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(snapshot), 'utf8')
      renameSync(temp, target)
      return true
    } catch {
      rmSync(temp, { force: true })
      throw new Error('context-inspect atomic write failed')
    }
  } catch {
    return false
  }
}

export async function readContextInspect(sessionId: unknown, dataDir: string = YAN_DIR): Promise<ContextInspectSnapshot | null> {
  if (!isSafeSessionId(sessionId)) return null
  try {
    return parseContextInspectSnapshot(JSON.parse(await readFile(inspectFile(dataDir, sessionId), 'utf8')))
  } catch {
    return null
  }
}
