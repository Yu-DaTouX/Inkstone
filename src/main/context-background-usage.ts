/** Reads historical host-context usage and records current title generation. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** 有界：保留旧账本的行数边界，避免标题记录无限增长 */
const LOG_MAX_LINES = 500
const LOG_KEEP_LINES = 300

export function contextBackgroundUsageDir(dataDir: string): string {
  return join(dataDir, 'context-background-usage')
}

export function contextBackgroundUsageFile(dataDir: string, sessionId: string): string {
  return join(contextBackgroundUsageDir(dataDir), `${sessionId}.jsonl`)
}

/**
 * 读并聚合当前会话的后台调用用量。
 *
 * 读不到（文件不存在 / 权限 / 非法 sessionId）都返回**空统计**：
 * 这是诊断读数，读不到不该让任何调用方失败。
 */
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

/**
 * 主进程写一条后台调用（目前只有标题生成）。
 *
 * 写失败一律静默：账本是读数，不能让它影响标题本身。
 */
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
      writeFileSync(file, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n')
    }
  } catch {
    /* 账本写不进去不影响标题生成 */
  }
}
