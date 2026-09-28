/**
 * 后台调用用量账（扩展侧写入）。
 *
 * 为什么由扩展写：整理摘要 / 深度归纳 / 任务状态生成 / 交接归纳都走
 * `ctx.modelRegistry.complete()`，请求绕开会话循环，宿主看不见返回值里的 usage。
 * 扩展是唯一拿到那份 `AssistantMessage` 的地方，所以由它把用量落到
 * `<YAN_DATA_DIR>/context-background-usage/<sessionId>.jsonl`，宿主只读不猜。
 *
 * 与 `context-actions` 的分工：
 *   · context-actions     记「这一轮改没改上下文、省了多少**估算** token」
 *   · 本文件               记「这一步真的花了多少**供应商口径** token」
 * 两者都不复述消息正文 —— 账本是读数，不是第二份转录。
 *
 * `kind` 白名单与 `src/shared/context-background-usage.ts` 的
 * `CONTEXT_BACKGROUND_CALL_KINDS` **必须一致**：宿主按它解析，写进去但不认识的
 * 类型会被静默丢掉（与 `DEFAULT_KINDS` / `shared/context-policy.ts` 同一条约定）。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 与宿主的 `isSafeSessionId` 同一条判据（它会直接进文件名） */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

/** 有界：账本是读数，不是无限增长的历史（与 context-actions 同一组阈值） */
const LOG_MAX_LINES = 500
const LOG_KEEP_LINES = 300

const lineCounts = new Map()

function dataDir() {
  const dir = process.env.YAN_DATA_DIR?.trim()
  return dir || join(homedir(), '.pi', 'agent', 'yan')
}

export function backgroundUsageFile(sessionId) {
  return join(dataDir(), 'context-background-usage', `${sessionId}.jsonl`)
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 从 `registry.complete()` 的返回里取**供应商口径**的用量。
 *
 * 认不出（provider 没报）返回 `null` —— 这与「报了但全是 0」是两件事，
 * 账本必须能分开，否则界面会把「没有数据」画成「没有花费」。
 * 字段名以 pi 的助手消息为准（`src/main/normalize.ts` 是同一套字段）。
 */
export function usageOfCompletion(result) {
  const raw = result && typeof result === 'object'
    ? (result.usage ?? result.message?.usage ?? null)
    : null
  if (!raw || typeof raw !== 'object') return null
  const reported = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'promptTokens', 'completionTokens']
    .some((key) => typeof raw[key] === 'number')
  if (!reported) return null
  const input = finite(raw.input) ?? finite(raw.promptTokens) ?? 0
  const output = finite(raw.output) ?? finite(raw.completionTokens) ?? 0
  const cacheRead = finite(raw.cacheRead) ?? 0
  const cacheWrite = finite(raw.cacheWrite) ?? 0
  const totalTokens = finite(raw.totalTokens) ?? input + output + cacheRead + cacheWrite
  const cost = finite(raw.cost?.total) ?? finite(raw.cost) ?? 0
  return { input, output, cacheRead, cacheWrite, totalTokens, cost }
}

/**
 * 记一条后台调用。
 *
 * `record.kind` 用 `requestKind`（`summary` / `deep` / `state` / `handoff`）；
 * `ok: false` 表示这次调用**没有**正常完成（被预算挡下、provider 报错、超时），
 * 这时通常没有 usage，`usageReported` 为 false。
 */
export function recordBackgroundUsage(sessionId, record) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return
  const usage = record?.usage ?? null
  try {
    const file = backgroundUsageFile(sessionId)
    mkdirSync(dirname(file), { recursive: true })
    const row = {
      at: Date.now(),
      kind: typeof record?.kind === 'string' && record.kind ? record.kind : 'unknown',
      ok: record?.ok !== false,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: usage?.cost ?? 0,
      usageReported: !!usage
    }
    if (finite(record?.estimatedInput) !== null) row.estimatedInput = record.estimatedInput
    if (finite(record?.durationMs) !== null) row.durationMs = record.durationMs
    if (typeof record?.model === 'string' && record.model) row.model = record.model.slice(0, 200)
    if (typeof record?.error === 'string' && record.error) row.error = record.error.slice(0, 300)
    appendFileSync(file, JSON.stringify(row) + '\n')
    const known = lineCounts.get(file)
    const count = typeof known === 'number' ? known + 1 : readFileSync(file, 'utf8').split('\n').filter(Boolean).length
    lineCounts.set(file, count)
    if (count > LOG_MAX_LINES) {
      const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP_LINES)
      writeFileSync(file, kept.join('\n') + '\n')
      lineCounts.set(file, kept.length)
    }
  } catch {
    /* 账本写不进去不影响这次调用本身 —— 它是读数，不是执行路径 */
  }
}
