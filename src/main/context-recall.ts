/**
 * 归档上下文的宿主侧回读（实施-01 / 06 收口）。
 *
 * `context.js` 仍负责把大工具结果替换为墓碑、在下一用户回合清理临时正文；
 * 但模型不再通过一个 pi 注册工具取得正文。模型只能经受认证的
 * `yan context recall` 请求当前宿主，由这里从当前会话的原始 JSONL 找回。
 *
 * 这层刻意不 import pi 扩展：原始会话、归档元数据、预算账本和结果文件都在
 * 宿主侧，因此没有理由让主进程依赖扩展的运行时私有实现。
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { CAPABILITY_RESULT_MAX_BYTES } from './capability-server'
import { contextStateDir, isSafeSessionId, loadArchive } from './context-state-store'

const REF_RE = /^ctx:\/\/(tool|file|diff|episode)\/[A-Za-z0-9._~%:-]{1,200}$/
const RECALL_PREFIX = '[Recalled context]'

interface RecallPolicy {
  maxTokensPerCall: number
  maxActiveRecallTokens: number
  maxEntriesPerCall: number
  ttl: 'turn' | 'episode'
}

const DEFAULT_RECALL_POLICY: RecallPolicy = {
  maxTokensPerCall: 20_000,
  maxActiveRecallTokens: 40_000,
  maxEntriesPerCall: 3,
  ttl: 'turn'
} as const

export interface ContextRecallRequest {
  /** 宿主从当前 pi state 取得，绝不采纳模型传来的会话身份。 */
  sessionId: string
  /** 同上：当前会话的真实 JSONL 路径。 */
  sessionFile: string
  /** CLI 参数（只允许一个受 schema 约束的 ctx:// 引用）。 */
  ref: unknown
  reason?: unknown
  /** 测试隔离入口；生产态省略并使用 YAN_DATA_DIR/context-state。 */
  stateDir?: string
  now?: number
}

export interface ContextRecallResult {
  /** 逐字落到受管 .txt 文件，随后由 native read 按需读出。 */
  resultText: string
  summary: {
    kind: 'context'
    action: 'recall'
    ref: string
    tokens: number
    turn: number
  }
}

/** 业务错误码由 agent 映射为 CapabilityCommandError；永远不携带原文。 */
export class ContextRecallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ContextRecallError'
  }
}

type RecallLedger = { turn: number; activeTokens: number }

const queues = new Map<string, Promise<void>>()

/**
 * 同一会话的读-预算判断-账本写入必须串行。否则两个并发 CLI 调用都能看见旧
 * activeTokens，从而一起越过累计额度。进程内能力端点由一个 AgentController
 * 持有，这个轻量队列足够覆盖实际竞争面。
 */
async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  queues.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await run()
  } finally {
    release()
    if (queues.get(key) === current) queues.delete(key)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 与 context-transform.js 完全同口径：宽字符保守地按一个 token 计。 */
export function estimateContextRecallTokens(text: string): number {
  if (!text) return 0
  let wide = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3ffff)
    ) {
      wide += ch.length
    }
  }
  return Math.ceil(wide + (text.length - wide) / 4)
}

function recallPolicyFromEnv(): RecallPolicy {
  const raw = process.env.YAN_CONTEXT_POLICY?.trim()
  if (!raw) return { ...DEFAULT_RECALL_POLICY }
  try {
    const parsed = record(JSON.parse(raw))
    const recall = record(parsed?.recall)
    if (!recall) return { ...DEFAULT_RECALL_POLICY }
    const out = { ...DEFAULT_RECALL_POLICY }
    for (const key of ['maxTokensPerCall', 'maxActiveRecallTokens', 'maxEntriesPerCall'] as const) {
      const value = recall[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value
    }
    if (recall.ttl === 'turn' || recall.ttl === 'episode') out.ttl = recall.ttl
    return out
  } catch {
    return { ...DEFAULT_RECALL_POLICY }
  }
}

function budgetDecision(policy: RecallPolicy, tokens: number, activeTokens: number) {
  if (1 > policy.maxEntriesPerCall) return { ok: false as const, reason: 'too-many-entries' as const, limit: policy.maxEntriesPerCall }
  if (tokens > policy.maxTokensPerCall) return { ok: false as const, reason: 'too-large' as const, limit: policy.maxTokensPerCall }
  if (activeTokens + tokens > policy.maxActiveRecallTokens) {
    return { ok: false as const, reason: 'active-budget' as const, limit: policy.maxActiveRecallTokens, active: activeTokens }
  }
  return { ok: true as const }
}

function ledgerPath(sessionId: string, stateDir: string): string {
  return join(stateDir, `${sessionId}.recall.json`)
}

function auditPath(sessionId: string, stateDir: string): string {
  return join(stateDir, `${sessionId}.recall.jsonl`)
}

async function loadLedger(sessionId: string, stateDir: string): Promise<{ ledger: RecallLedger; exists: boolean }> {
  try {
    const parsed = record(JSON.parse(await readFile(ledgerPath(sessionId, stateDir), 'utf8')))
    const turn = parsed?.turn
    const activeTokens = parsed?.activeTokens
    if (
      typeof turn === 'number' &&
      Number.isFinite(turn) &&
      turn >= 0 &&
      typeof activeTokens === 'number' &&
      Number.isFinite(activeTokens) &&
      activeTokens >= 0
    ) {
      return { ledger: { turn: Math.floor(turn), activeTokens: Math.floor(activeTokens) }, exists: true }
    }
  } catch {
    /* 账本是派生物；坏了按空账本重算，不能把原始历史读路径拖死。 */
  }
  return { ledger: { turn: 0, activeTokens: 0 }, exists: false }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function saveLedger(sessionId: string, stateDir: string, ledger: RecallLedger): Promise<void> {
  try {
    await writeJsonAtomic(ledgerPath(sessionId, stateDir), ledger)
  } catch {
    throw new ContextRecallError('context_ledger_failed', '召回账本无法安全落盘；原文没有返回给模型')
  }
}

async function audit(
  sessionId: string,
  stateDir: string,
  recordValue: Record<string, unknown>
): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true })
    await appendFile(auditPath(sessionId, stateDir), `${JSON.stringify(recordValue)}\n`, 'utf8')
  } catch {
    /* 与旧扩展一致：审计失败可观测但不阻断已经安全保留账本的召回。 */
  }
}

function messageText(message: unknown): string {
  const value = record(message)
  if (!value) return ''
  if (typeof value.summary === 'string') return value.summary
  if (typeof value.content === 'string') return value.content
  if (!Array.isArray(value.content)) return ''
  const parts: string[] = []
  for (const block of value.content) {
    const item = record(block)
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

function entryText(entry: Record<string, unknown>): string | null {
  if (entry.type === 'message') return messageText(entry.message) || null
  if (typeof entry.summary === 'string') return entry.summary
  if (typeof entry.content === 'string') return entry.content
  return null
}

/**
 * 从当前 JSONL 流式找回目标 entry；不使用 session-reader，因为它会为 UI 正常化/
 * 截断消息，不能作为“逐字回读原文”的事实源。
 */
async function readRawEntry(sessionFile: string, sessionId: string, entryId: string): Promise<{ raw: string; userTurns: number }> {
  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(sessionFile, { encoding: 'utf8' })
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
  } catch {
    throw new ContextRecallError('context_session_unreadable', '当前会话原始记录不可读取，未返回归档正文')
  }

  let raw: string | null = null
  let userTurns = 0
  let headerId: string | null = null
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (!trimmed.endsWith('}')) continue // 进程中断留下的半行，和水位读取层一样不采纳。
      let entry: Record<string, unknown> | null
      try {
        entry = record(JSON.parse(trimmed))
      } catch {
        throw new ContextRecallError('context_session_unreadable', '当前会话原始记录损坏，未返回归档正文')
      }
      if (!entry) continue
      if (entry.type === 'session') {
        if (typeof entry.id === 'string' && !headerId) headerId = entry.id
        continue
      }
      if (entry.type === 'message' && record(entry.message)?.role === 'user') userTurns += 1
      if (entry.id === entryId) raw = entryText(entry)
    }
  } catch (error) {
    if (error instanceof ContextRecallError) throw error
    throw new ContextRecallError('context_session_unreadable', '当前会话原始记录读取失败，未返回归档正文')
  } finally {
    rl.close()
    stream.destroy()
  }

  if (headerId && headerId !== sessionId) {
    throw new ContextRecallError('context_session_mismatch', '当前会话记录身份不匹配，未返回归档正文')
  }
  if (raw === null) {
    throw new ContextRecallError('context_entry_missing', '原始会话里已经找不到这条归档内容，未返回半份正文')
  }
  return { raw, userTurns }
}

function limitedReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text.slice(0, 1000) : null
}

/**
 * 只接受当前 AgentController 已绑定的会话与文件；模型可选择 ref，但不能选择
 * session、路径、归档目录或结果落点。
 */
export async function recallArchivedContext(request: ContextRecallRequest): Promise<ContextRecallResult> {
  const ref = typeof request.ref === 'string' ? request.ref.trim() : ''
  if (!REF_RE.test(ref)) {
    throw new ContextRecallError('context_recall_invalid_ref', 'context recall 只接受合法的 ctx:// 引用')
  }
  if (!isSafeSessionId(request.sessionId)) {
    throw new ContextRecallError('context_session_unavailable', '当前还没有可安全回读的会话')
  }
  if (typeof request.sessionFile !== 'string' || !request.sessionFile.trim()) {
    throw new ContextRecallError('context_session_unavailable', '当前会话原始记录尚未就绪')
  }

  const stateDir = request.stateDir ?? contextStateDir()
  const now = Number.isFinite(request.now) ? (request.now as number) : Date.now()
  return serialized(request.sessionId, async () => {
    const loaded = await loadArchive(request.sessionId, { dir: stateDir })
    if (loaded.status === 'missing') {
      throw new ContextRecallError('context_archive_missing', '没有可用的归档元数据；未返回正文')
    }
    if (loaded.status !== 'ok') {
      throw new ContextRecallError('context_archive_unavailable', '归档元数据不可用或已被安全丢弃；未返回正文')
    }

    const entry = loaded.archive.entries.find((item) => item.ref === ref)
    if (!entry) {
      throw new ContextRecallError('context_recall_missing', '归档元数据中没有这条引用；未返回正文')
    }
    if (entry.recallable !== 'agent') {
      throw new ContextRecallError('context_recall_forbidden', '这条归档内容不允许模型自行回读')
    }
    if (Number.isFinite(entry.expiresAt) && (entry.expiresAt as number) <= now) {
      throw new ContextRecallError('context_recall_expired', '这条归档内容已经过期；未返回正文')
    }

    const entryId = ref.slice(ref.lastIndexOf('/') + 1)
    const source = await readRawEntry(request.sessionFile, request.sessionId, entryId)
    const tokens = estimateContextRecallTokens(source.raw)
    const resultTextPrefix = `${RECALL_PREFIX} turn=`
    /* 先检查正文 + 包装会不会超过能力文件上限，再碰账本；不能预扣却写不出。 */
    const ledgerState = await loadLedger(request.sessionId, stateDir)
    const turn = ledgerState.exists ? ledgerState.ledger.turn : source.userTurns
    const resultText = `${resultTextPrefix}${turn} ref=${ref}\n${source.raw}`
    if (Buffer.byteLength(resultText) > CAPABILITY_RESULT_MAX_BYTES) {
      throw new ContextRecallError(
        'context_recall_result_too_large',
        `归档正文超过可安全交付的 ${CAPABILITY_RESULT_MAX_BYTES} 字节上限，未返回半份内容`
      )
    }

    const policy = recallPolicyFromEnv()
    const decision = budgetDecision(policy, tokens, ledgerState.ledger.activeTokens)
    if (!decision.ok) {
      await audit(request.sessionId, stateDir, {
        ts: now,
        kind: 'recall',
        ref,
        tokens,
        by: 'agent',
        result: 'rejected',
        reason: decision.reason
      })
      const message =
        decision.reason === 'too-large'
          ? `这次召回约 ${tokens} token，超过单次上限 ${decision.limit}`
          : decision.reason === 'active-budget'
            ? `当前已召回约 ${decision.active} token，再加本次 ${tokens} 会超过上限 ${decision.limit}`
            : `一次最多召回 ${decision.limit} 条`
      throw new ContextRecallError('context_recall_rejected', `召回被拒绝：${message}；未返回半份正文`)
    }

    await saveLedger(request.sessionId, stateDir, {
      turn,
      activeTokens: ledgerState.ledger.activeTokens + tokens
    })
    await audit(request.sessionId, stateDir, {
      ts: now,
      kind: 'recall',
      ref,
      tokens,
      by: 'agent',
      result: 'ok',
      reason: limitedReason(request.reason)
    })
    return {
      resultText,
      summary: { kind: 'context', action: 'recall', ref, tokens, turn }
    }
  })
}
