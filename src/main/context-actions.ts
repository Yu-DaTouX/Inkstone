import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseActionLines,
  summarizeActions,
  type ContextActionSummary
} from '../shared/context-actions'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

export function contextActionsDir(dataDir: string): string {
  return join(dataDir, 'context-actions')
}

export function contextActionsFile(dataDir: string, sessionId: string): string {
  return join(contextActionsDir(dataDir), `${sessionId}.jsonl`)
}

const EMPTY: ContextActionSummary = summarizeActions([])

export async function readContextActions(
  sessionId: string | undefined | null,
  options: { dataDir?: string; limit?: number } = {}
): Promise<ContextActionSummary> {
  if (!isSafeSessionId(sessionId)) return EMPTY
  const dataDir = options.dataDir ?? YAN_DIR
  let text = ''
  try {
    text = await readFile(contextActionsFile(dataDir, sessionId as string), 'utf8')
  } catch {
    return EMPTY
  }
  return summarizeActions(parseActionLines(text, options.limit ?? 300))
}
