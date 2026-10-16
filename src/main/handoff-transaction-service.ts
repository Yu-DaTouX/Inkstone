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

const MAX_TRANSACTIONS = 200

const MAX_STEPS = 40

export interface HandoffTransactionDocument {
  version: 1
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

  get(handoffId: string): HandoffTransaction | null {
    return this.doc.transactions[handoffId] ?? null
  }

  activeForSession(sessionKey: string): HandoffTransaction | null {
    for (const tx of Object.values(this.doc.transactions)) {
      if (isTerminalStage(tx.stage)) continue
      if (this.touches(tx, sessionKey)) return tx
    }
    return null
  }

  latestForSession(sessionKey: string): HandoffTransaction | null {
    let best: HandoffTransaction | null = null
    for (const tx of Object.values(this.doc.transactions)) {
      if (!this.touches(tx, sessionKey)) continue
      if (!best || tx.updatedAt >= best.updatedAt) best = tx
    }
    return best
  }

  private touches(tx: HandoffTransaction, sessionKey: string): boolean {
    const key = normalizeChainKey(sessionKey)
    if (!key) return false
    return normalizeChainKey(tx.sourceSession) === key || normalizeChainKey(tx.destinationSession) === key
  }

  openTransactions(): HandoffTransaction[] {
    return Object.values(this.doc.transactions).filter((tx) => !isTerminalStage(tx.stage))
  }

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
