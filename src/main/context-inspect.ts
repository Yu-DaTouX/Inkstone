/** 保存 / 读取 context-inspect 薄层上报的快照（每会话一份，覆盖写）。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseContextInspectSnapshot, type ContextInspectSnapshot } from '../shared/context-inspect'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

function inspectFile(dataDir: string, sessionId: string): string {
  return join(dataDir, 'context-inspect', `${sessionId}.json`)
}

/** 写入失败不影响对话：这是诊断读数。 */
export function saveContextInspect(sessionId: unknown, raw: unknown, dataDir: string = YAN_DIR): boolean {
  const snapshot = parseContextInspectSnapshot(raw)
  if (!snapshot || !isSafeSessionId(sessionId)) return false
  try {
    mkdirSync(join(dataDir, 'context-inspect'), { recursive: true })
    writeFileSync(inspectFile(dataDir, sessionId), JSON.stringify(snapshot), 'utf8')
    return true
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
