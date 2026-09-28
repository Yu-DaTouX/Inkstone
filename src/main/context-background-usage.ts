/**
 * 后台调用用量账的宿主侧读写。
 *
 * 账本由两方写进**同一个文件**：
 *   · 扩展（`resources/pi-extensions/context-background-usage.js`）写整理摘要、
 *     深度归纳、任务状态生成、交接归纳；
 *   · 主进程写标题生成 —— 它跑在独立的 pi 进程里，扩展看不到那次请求。
 * 宿主只负责读与聚合，不猜、不补。文件不存在 = 本会话还没有后台调用（不是错误）。
 *
 * 安全：sessionId 直接进文件名，复用 `context-state-store` 的路径穿越判据。
 */
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

/** 有界：与扩展侧同一组阈值，保证两边交替写也不会让文件无限长 */
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
