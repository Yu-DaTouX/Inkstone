import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  emptyBackgroundUsage,
  parseBackgroundUsageLines,
  summarizeBackgroundUsage,
  type ContextBackgroundUsageSummary
} from '../shared/context-background-usage'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

const LOG_MAX_LINES = 500
const LOG_KEEP_LINES = 300

export function contextBackgroundUsageDir(dataDir: string): string {
  return join(dataDir, 'context-background-usage')
}

export function contextBackgroundUsageFile(dataDir: string, sessionId: string): string {
  return join(contextBackgroundUsageDir(dataDir), `${sessionId}.jsonl`)
}

export async function readContextBackgroundUsage(
  sessionId: string | undefined | null,
  options: { dataDir?: string; limit?: number } = {}
): Promise<ContextBackgroundUsageSummary> {
  if (!isSafeSessionId(sessionId)) return emptyBackgroundUsage()
  const dataDir = options.dataDir ?? YAN_DIR
  let text = ''
  try {
    text = await readFile(contextBackgroundUsageFile(dataDir, sessionId as string), 'utf8')
  } catch {
    return emptyBackgroundUsage()
  }
  return summarizeBackgroundUsage(parseBackgroundUsageLines(text, options.limit ?? 500))
}

export function appendContextBackgroundUsage(
  sessionId: string,
  record: {
    kind: string
    ok: boolean
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: number } | null
    estimatedInput?: number
    durationMs?: number
    model?: string
    error?: string
  },
  options: { dataDir?: string } = {}
): void {
  if (!isSafeSessionId(sessionId)) return
  const dataDir = options.dataDir ?? YAN_DIR
  const usage = record.usage ?? null
  try {
    const file = contextBackgroundUsageFile(dataDir, sessionId)
    mkdirSync(contextBackgroundUsageDir(dataDir), { recursive: true })
    const row = {
      at: Date.now(),
      kind: record.kind,
      ok: record.ok === true,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: usage?.cost ?? 0,
      usageReported: !!usage,
      ...(typeof record.estimatedInput === 'number' && Number.isFinite(record.estimatedInput) && record.estimatedInput >= 0
        ? { estimatedInput: record.estimatedInput }
        : {}),
      ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
        ? { durationMs: record.durationMs }
        : {}),
      ...(record.model ? { model: record.model.slice(0, 200) } : {}),
      ...(record.error ? { error: record.error.slice(0, 300) } : {})
    }
    appendFileSync(file, JSON.stringify(row) + '\n')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > LOG_MAX_LINES) {
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n')
        renameSync(temp, file)
      } catch {
        rmSync(temp, { force: true })
        throw new Error('context background usage rotation failed')
      }
    }
  } catch {
  }
}
