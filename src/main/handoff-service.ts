import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  applyCompactionTally,
  emptyTally,
  handoffFileKey,
  resetTallyForNewSegment,
  sanitizeHandoffPackage,
  sanitizeHandoffRequest,
  sanitizeHandoffResult,
  HANDOFF_PACKAGE_MAX_TOKENS,
  HANDOFF_PACKAGE_MAX_TOKENS_ESCALATED,
  HANDOFF_SYSTEM_PROMPT,
  type HandoffPackage,
  type HandoffRequest,
  type HandoffResult,
  type HandoffTally
} from '../shared/handoff'
import type { CompactionRun } from '../shared/ipc'
import { normalizeSessionFileKey } from './work-mode-service'

export const HANDOFF_FILE_NAME = 'handoffs.json'

const MAX_ENTRIES = 2000

export interface HandoffEntry {
  tally: HandoffTally
  package: HandoffPackage | null
  updatedAt: number
}

export interface HandoffDocument {
  version: 1
  entries: Record<string, HandoffEntry>
}

export function handoffDocumentPath(root: string = YAN_DIR): string {
  return join(root, HANDOFF_FILE_NAME)
}

function emptyEntry(): HandoffEntry {
  return { tally: emptyTally(), package: null, updatedAt: 0 }
}

function sanitizeTally(raw: unknown): HandoffTally {
  if (!raw || typeof raw !== 'object') return emptyTally()
  const item = raw as Partial<HandoffTally>
  const count = typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 0
  const keys = Array.isArray(item.keys) ? item.keys.filter((k): k is string => typeof k === 'string' && !!k).slice(-50) : []
  return {
    segmentId: typeof item.segmentId === 'string' && item.segmentId.trim() ? item.segmentId.trim() : 'initial',
    count,
    keys,
    updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
  }
}

export function sanitizeHandoffDocument(raw: unknown): HandoffDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, entries: {} }
  const doc = raw as Partial<HandoffDocument>
  const entries: Record<string, HandoffEntry> = {}
  for (const [key, value] of Object.entries(doc.entries ?? {})) {
    const id = normalizeSessionFileKey(key)
    if (!id) continue
    const item = (value ?? {}) as Partial<HandoffEntry>
    entries[id] = {
      tally: sanitizeTally(item.tally),
      package: sanitizeHandoffPackage(item.package, {
        sourceSession: id,
        sourceHead: item.package?.sourceHead ?? null,
        mode: item.package?.mode ?? 'standard',
        model: item.package?.model ?? null,
        now: item.package?.generatedAt ?? 0
      }),
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0
    }
  }
  return { version: 1, entries }
}

export interface HandoffStoreOptions {
  root?: string
  now?: () => number
}

export class HandoffStore {
  private readonly root: string
  private readonly now: () => number
  private doc: HandoffDocument = { version: 1, entries: {} }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: HandoffStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  state(sessionKey: string): HandoffEntry {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return emptyEntry()
    return this.doc.entries[key] ?? emptyEntry()
  }

  async recordCompaction(
    sessionKey: string,
    run: CompactionRun | null | undefined
  ): Promise<{ counted: boolean; reason: string; tally: HandoffTally }> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return { counted: false, reason: 'bad_session', tally: emptyTally(this.now()) }
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const at = this.now()
      const applied = applyCompactionTally(entry.tally, run, at)
      if (!applied.counted) return applied
      entry.tally = applied.tally
      entry.updatedAt = at
      await this.persist()
      return applied
    })
  }

  async setPackage(sessionKey: string, pkg: HandoffPackage): Promise<void> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return
      const entry = (this.doc.entries[key] ??= emptyEntry())
      entry.package = pkg
      entry.updatedAt = this.now()
      await this.persist()
    })
  }

  async startNewSegment(sessionKey: string, segmentId: string): Promise<HandoffTally> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return emptyTally(this.now())
      const entry = (this.doc.entries[key] ??= emptyEntry())
      const at = this.now()
      entry.tally = resetTallyForNewSegment(segmentId, at)
      entry.updatedAt = at
      await this.persist()
      return entry.tally
    })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(handoffDocumentPath(this.root), 'utf8')
      this.doc = sanitizeHandoffDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, entries: {} }
    }
  }

  snapshot(): HandoffDocument {
    return { ...this.doc, entries: { ...this.doc.entries } }
  }

  private trim(): void {
    const ids = Object.keys(this.doc.entries)
    if (ids.length <= MAX_ENTRIES) return
    ids
      .sort((a, b) => this.doc.entries[a].updatedAt - this.doc.entries[b].updatedAt)
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((key) => delete this.doc.entries[key])
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = handoffDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    this.trim()
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeHandoffDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, entries: {} }
      }
      throw new Error('交接计数落盘失败')
    }
  }
}

export const HANDOFF_REQUEST_DIR = 'handoff-request'
export const HANDOFF_RESULT_DIR = 'handoff-result'

export function handoffRequestPath(runnerId: string, root: string = YAN_DIR): string {
  return join(root, HANDOFF_REQUEST_DIR, `${handoffFileKey(runnerId)}.json`)
}

export function handoffResultPath(runnerId: string, root: string = YAN_DIR): string {
  return join(root, HANDOFF_RESULT_DIR, `${handoffFileKey(runnerId)}.json`)
}

export function buildHandoffRequest(input: {
  handoffId: string
  operationId: string
  sessionKey: string
  prompt: string
  sourceHead: string | null
  mode: string
  model: string | null
  now?: number
}): HandoffRequest {
  return {
    handoffId: input.handoffId,
    operationId: input.operationId,
    sessionKey: input.sessionKey,
    prompt: input.prompt,
    systemPrompt: HANDOFF_SYSTEM_PROMPT,
    maxTokens: HANDOFF_PACKAGE_MAX_TOKENS,
    maxAttempts: 2,
    retryPrompt: '上次交接输出不完整或格式不合格。重新依据原始材料输出完整 JSON；必须包含全部列表，remaining 与 nextActions 不为空，不猜测事实。',
    escalatedMaxTokens: HANDOFF_PACKAGE_MAX_TOKENS_ESCALATED,
    retryPromptTruncated:
      '上次输出在写到一半时被长度限制切断了（不是格式问题）。这次预算已经扩大，但仍然要在完整的前提下避免冗余：不要重复粘贴原文、不要逐条抄长代码。若仍然很长，按这个优先级保底：goal 与 deliverable 先写完整，然后是 remaining、nextActions、constraints、acceptance。',
    sourceHead: input.sourceHead ?? null,
    mode: input.mode,
    model: input.model ?? null,
    createdAt: input.now ?? Date.now()
  }
}

export function buildHandoffResult(input: {
  handoffId: string
  operationId: string
  text?: string
  error?: string | null
  ms?: number
  now?: number
}): HandoffResult {
  return {
    handoffId: input.handoffId,
    operationId: input.operationId,
    text: input.text ?? '',
    error: input.error ? String(input.error) : null,
    ms: Number.isFinite(input.ms) ? Math.max(0, Math.floor(input.ms as number)) : 0,
    at: input.now ?? Date.now()
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, path)
}

async function readJsonIfAny(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export class HandoffRequestStore {
  private readonly root: string

  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? YAN_DIR
  }

  requestPath(runnerId: string): string {
    return handoffRequestPath(runnerId, this.root)
  }

  resultPath(runnerId: string): string {
    return handoffResultPath(runnerId, this.root)
  }

  async writeRequest(runnerId: string, request: HandoffRequest): Promise<boolean> {
    const path = this.requestPath(runnerId)
    if (!handoffFileKey(runnerId)) return false
    try {
      await writeJsonAtomic(path, request)
      return true
    } catch {
      return false
    }
  }

  async readRequest(runnerId: string): Promise<HandoffRequest | null> {
    return sanitizeHandoffRequest(await readJsonIfAny(this.requestPath(runnerId)))
  }

  async clearRequest(runnerId: string): Promise<void> {
    await rm(this.requestPath(runnerId), { force: true }).catch(() => {})
  }

  async writeResult(runnerId: string, result: HandoffResult): Promise<boolean> {
    if (!handoffFileKey(runnerId)) return false
    try {
      await writeJsonAtomic(this.resultPath(runnerId), result)
      return true
    } catch {
      return false
    }
  }

  async readResult(runnerId: string): Promise<HandoffResult | null> {
    return sanitizeHandoffResult(await readJsonIfAny(this.resultPath(runnerId)))
  }

  async clearResult(runnerId: string): Promise<void> {
    await rm(this.resultPath(runnerId), { force: true }).catch(() => {})
  }
}
