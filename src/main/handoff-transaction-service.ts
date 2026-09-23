/**
 * 交接事务日志的存储（实施-05 S5b-3a）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * §8 第 6 条要求「每一步写可恢复日志」，第 7 条要求「失败保留源会话」。
 * 这两条都只有在**日志本身先落盘**时才有意义：
 *
 *   · 顺序永远是「先写日志，再动外部状态」（建会话 / 切活动段 / 发消息）。
 *     反过来的话，崩溃一次就会出现「动作做了但没人知道」——
 *     而交接的动作连接着两个会话，没有任何一侧能自己发现这件事。
 *   · 幂等：`begin` 按 `handoffId` 去重（同一份交接重放不会建第二条事务）；
 *     `update` 在读-改-写队列里做，落盘失败**必须抛**并把内存态退回磁盘上的样子
 *     （与 goals / handoffs / auto-continue 同一套做法）。
 *
 * ⚠️ 这一层**不建会话、不切活动段、不发消息** —— 那是接线（S5b-3b）的活。
 * 这里只把「事务此刻走到哪一步」变成可读、可恢复、可单测的事实。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import { sanitizeHandoffPackage, type HandoffPackage } from '../shared/handoff'
import { normalizeChainKey } from '../shared/session-chain'
import {
  advance,
  attachDestination,
  attachPackage,
  createTransaction,
  handoffStages,
  isTerminalStage,
  recordResumeAttempt,
  recordReceipt,
  type HandoffReceipts,
  type ReceiptKind,
  type HandoffStage,
  type HandoffStep,
  type HandoffTransaction
} from '../shared/handoff-transaction'

export const HANDOFF_TRANSACTION_FILE_NAME = 'handoff-transactions.json'

/** 最多留多少条事务（与其它 store 同量级）。 */
const MAX_TRANSACTIONS = 200

/** 保留多少条步骤日志（诊断够用，不无界增长）。 */
const MAX_STEPS = 40

export interface HandoffTransactionDocument {
  version: 1
  /** 按 `handoffId` 索引（一次交接连着源与目的两个会话，不能用会话键） */
  transactions: Record<string, HandoffTransaction>
  updatedAt: number
}

export function handoffTransactionDocumentPath(root: string = YAN_DIR): string {
  return join(root, HANDOFF_TRANSACTION_FILE_NAME)
}

function safeStage(raw: unknown): HandoffStage {
  const stages = handoffStages()
  return stages.includes(raw as HandoffStage) ? (raw as HandoffStage) : 'pending'
}

/** 回执只收正数时间戳：脏值一律丢掉（宁可显示“没到过”，也不显示一个假时刻）。 */
function sanitizeReceipts(raw: unknown): HandoffReceipts {
  if (!raw || typeof raw !== 'object') return {}
  const item = raw as Partial<HandoffReceipts>
  const at = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  const out: HandoffReceipts = {}
  const sentAt = at(item.sentAt)
  const persistedAt = at(item.persistedAt)
  const startedAt = at(item.startedAt)
  if (sentAt !== undefined) out.sentAt = sentAt
  if (persistedAt !== undefined) out.persistedAt = persistedAt
  if (startedAt !== undefined) out.startedAt = startedAt
  return out
}

function sanitizeStep(raw: unknown): HandoffStep | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<HandoffStep>
  const to = safeStage(item.to)
  if (!item.to) return null
  return {
    at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : 0,
    from: safeStage(item.from),
    to,
    ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail } : {})
  }
}

/**
 * 脏事务降级。
 *
 * 三个身份字段（`handoffId` / `sourceSession` / `resumeId`）缺一个就整条丢掉 ——
 * 没有它们的记录既回不到源会话，也判不了消费证据，留着只会让恢复逻辑乱猜。
 */
export function sanitizeHandoffTransaction(raw: unknown): HandoffTransaction | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<HandoffTransaction>
  const handoffId = typeof item.handoffId === 'string' ? item.handoffId.trim() : ''
  const sourceSession = typeof item.sourceSession === 'string' ? item.sourceSession.trim() : ''
  const resumeId = typeof item.resumeId === 'string' ? item.resumeId.trim() : ''
  if (!handoffId || !sourceSession || !resumeId) return null
  const steps = Array.isArray(item.steps)
    ? item.steps.map(sanitizeStep).filter((step): step is HandoffStep => !!step).slice(-MAX_STEPS)
    : []
  const destinationSession =
    typeof item.destinationSession === 'string' && item.destinationSession.trim() ? item.destinationSession.trim() : null
  const pkg = sanitizeHandoffPackage(item.package, {
    sourceSession,
    sourceHead: (item.package as HandoffPackage | null)?.sourceHead ?? null,
    mode: (item.package as HandoffPackage | null)?.mode ?? 'unknown',
    model: (item.package as HandoffPackage | null)?.model ?? null,
    now: (item.package as HandoffPackage | null)?.generatedAt ?? 0
  })
  const createdAt = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : createdAt
  const resumeAttempts =
    typeof item.resumeAttempts === 'number' && Number.isFinite(item.resumeAttempts)
      ? Math.max(0, Math.floor(item.resumeAttempts))
      : 0
  return {
    handoffId,
    sourceSession,
    destinationSession,
    package: pkg,
    resumeId,
    resumeAttempts,
    receipts: sanitizeReceipts(item.receipts),
    stage: safeStage(item.stage),
    steps,
    error: typeof item.error === 'string' && item.error ? item.error : null,
    createdAt,
    updatedAt
  }
}

export function sanitizeHandoffTransactionDocument(raw: unknown): HandoffTransactionDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, transactions: {}, updatedAt: 0 }
  const doc = raw as Partial<HandoffTransactionDocument>
  const transactions: Record<string, HandoffTransaction> = {}
  for (const value of Object.values(doc.transactions ?? {})) {
    const tx = sanitizeHandoffTransaction(value)
    if (tx) transactions[tx.handoffId] = tx
  }
  const updatedAt = typeof doc.updatedAt === 'number' && Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0
  return { version: 1, transactions, updatedAt }
}

export interface HandoffTransactionStoreOptions {
  root?: string
  now?: () => number
}

export class HandoffTransactionStore {
  private readonly root: string
  private readonly now: () => number
  private doc: HandoffTransactionDocument = { version: 1, transactions: {}, updatedAt: 0 }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: HandoffTransactionStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  /** 读一条事务（不落盘）。 */
  get(handoffId: string): HandoffTransaction | null {
    return this.doc.transactions[handoffId] ?? null
  }

  /** 这个会话上有没有**未终结**的事务（源或目的任一侧都算）。 */
  activeForSession(sessionKey: string): HandoffTransaction | null {
    for (const tx of Object.values(this.doc.transactions)) {
      if (isTerminalStage(tx.stage)) continue
      if (this.touches(tx, sessionKey)) return tx
    }
    return null
  }

  /**
   * 这个会话相关的最新一条事务（含已终结的）。
   *
   * 与 `activeForSession` 分开：恢复与「该不该再交接」关心的是**未终结**，
   * 而界面 / 探针要能看见「上一次交接最后停在哪」（`resumed` 也算结论）。
   */
  latestForSession(sessionKey: string): HandoffTransaction | null {
    let best: HandoffTransaction | null = null
    for (const tx of Object.values(this.doc.transactions)) {
      if (!this.touches(tx, sessionKey)) continue
      if (!best || tx.updatedAt >= best.updatedAt) best = tx
    }
    return best
  }

  /**
   * 这条事务是否涉及该会话。
   *
   * ⚠️ 必须**归一化后**比较：事务里的 `destinationSession` 是 pi 给的原始路径
   *    （Windows 上是反斜杠），而调用方传进来的键来自 `workModeKeyFor`
   *    （已归一化成正斜杠）。直接比字符串会让「刚交接完的会话」查不到自己的事务 ——
   *    表现为界面永远看不到交接进度，重启恢复也认不出它。
   */
  private touches(tx: HandoffTransaction, sessionKey: string): boolean {
    const key = normalizeChainKey(sessionKey)
    if (!key) return false
    return normalizeChainKey(tx.sourceSession) === key || normalizeChainKey(tx.destinationSession) === key
  }

  /** 未终结的事务列表（崩溃恢复时逐个看）。 */
  openTransactions(): HandoffTransaction[] {
    return Object.values(this.doc.transactions).filter((tx) => !isTerminalStage(tx.stage))
  }

  /**
   * 开始一次交接。
   *
   * 幂等：同一个 `handoffId` 已经存在就原样返回（`created:false`）——
   * 「决定交接」这件事可能被重放（state 推送、重试），不能建出两条事务。
   */
  async begin(input: {
    handoffId: string
    sourceSession: string
    resumeId: string
  }): Promise<{ tx: HandoffTransaction; created: boolean }> {
    return this.enqueue(async () => {
      const existing = this.doc.transactions[input.handoffId]
      if (existing) return { tx: existing, created: false }
      const tx = createTransaction({ ...input, at: this.now() })
      this.doc.transactions[tx.handoffId] = tx
      this.doc.updatedAt = tx.updatedAt
      await this.persist()
      return { tx, created: true }
    })
  }

  /** 前进一格（幂等 + 落盘）。跳步 / 倒退返回 `advanced:false`。 */
  async step(
    handoffId: string,
    to: HandoffStage,
    detail?: string
  ): Promise<{ tx: HandoffTransaction | null; advanced: boolean; reason: string }> {
    return this.enqueue(async () => {
      const tx = this.doc.transactions[handoffId]
      if (!tx) return { tx: null, advanced: false, reason: 'no-transaction' }
      const moved = advance(tx, to, { at: this.now(), ...(detail ? { detail } : {}) })
      if (!moved.advanced) return { tx, advanced: false, reason: moved.reason }
      this.doc.transactions[handoffId] = moved.tx
      this.doc.updatedAt = moved.tx.updatedAt
      await this.persist()
      return { tx: moved.tx, advanced: true, reason: moved.reason }
    })
  }

  /** 记下目的会话（建出来之后调）。 */
  async setDestination(
    handoffId: string,
    destinationSession: string
  ): Promise<{ tx: HandoffTransaction | null; ok: boolean; reason: string }> {
    return this.enqueue(async () => {
      const tx = this.doc.transactions[handoffId]
      if (!tx) return { tx: null, ok: false, reason: 'no-transaction' }
      const attached = attachDestination(tx, destinationSession, this.now())
      if (!attached.ok) return { tx, ok: false, reason: attached.reason }
      if (attached.reason === 'unchanged') return { tx, ok: true, reason: 'unchanged' }
      this.doc.transactions[handoffId] = attached.tx
      this.doc.updatedAt = attached.tx.updatedAt
      await this.persist()
      return { tx: attached.tx, ok: true, reason: attached.reason }
    })
  }

  /** 记下交接包（生成完之后调；`snapshot` 阶段会自动前进到 `validated`）。 */
  async setPackage(
    handoffId: string,
    pkg: HandoffPackage
  ): Promise<{ tx: HandoffTransaction | null; ok: boolean; reason: string }> {
    return this.enqueue(async () => {
      const tx = this.doc.transactions[handoffId]
      if (!tx) return { tx: null, ok: false, reason: 'no-transaction' }
      const attached = attachPackage(tx, pkg, this.now())
      if (!attached.ok) return { tx, ok: false, reason: attached.reason }
      this.doc.transactions[handoffId] = attached.tx
      this.doc.updatedAt = attached.tx.updatedAt
      await this.persist()
      return { tx: attached.tx, ok: true, reason: attached.reason }
    })
  }

  /** 记一次 resume 发送尝试（发送**之前**调；`0` 与 `>= 2` 的含义见契约）。 */
  async noteResumeAttempt(handoffId: string): Promise<HandoffTransaction | null> {
    return this.enqueue(async () => {
      const tx = this.doc.transactions[handoffId]
      if (!tx) return null
      const next = recordResumeAttempt(tx, this.now())
      this.doc.transactions[handoffId] = next
      this.doc.updatedAt = next.updatedAt
      await this.persist()
      return next
    })
  }

  /** 记一条回执（A-3）：`sent` / `persisted` / `started`，同一个只记第一次。 */
  async noteReceipt(handoffId: string, kind: ReceiptKind): Promise<HandoffTransaction | null> {
    return this.enqueue(async () => {
      const tx = this.doc.transactions[handoffId]
      if (!tx) return null
      const next = recordReceipt(tx, kind, this.now())
      if (next === tx) return tx
      this.doc.transactions[handoffId] = next
      this.doc.updatedAt = next.updatedAt
      await this.persist()
      return next
    })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(handoffTransactionDocumentPath(this.root), 'utf8')
      this.doc = sanitizeHandoffTransactionDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, transactions: {}, updatedAt: 0 }
    }
  }

  snapshot(): HandoffTransactionDocument {
    return { ...this.doc, transactions: { ...this.doc.transactions } }
  }

  private trim(): void {
    const ids = Object.keys(this.doc.transactions)
    if (ids.length <= MAX_TRANSACTIONS) return
    /*
     * 只丢**已终结**的最旧事务；未终结的一条都不丢 ——
     * 丢掉它们等于把「下次启动该恢复什么」一起丢了。
     */
    const removable = ids
      .filter((id) => isTerminalStage(this.doc.transactions[id].stage))
      .sort((a, b) => this.doc.transactions[a].updatedAt - this.doc.transactions[b].updatedAt)
    for (const id of removable.slice(0, Math.max(0, ids.length - MAX_TRANSACTIONS))) {
      delete this.doc.transactions[id]
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = handoffTransactionDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    this.trim()
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeHandoffTransactionDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, transactions: {}, updatedAt: 0 }
      }
      throw new Error('交接事务日志落盘失败')
    }
  }
}
