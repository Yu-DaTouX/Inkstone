/**
 * 交接计数与交接包的会话级存储（实施-05 S5a）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * §7 的计数必须满足两条硬性质，两条都由磁盘行为决定：
 *
 *   1. **幂等**：`state` 推送会把 `lastCompaction` 重放很多遍。
 *      同一份压缩记录只能计一次 —— 去重键（`compactionKeyOf`）先查后写。
 *   2. **重启不归零**：计数写进 `YAN_DIR/handoffs.json`（按**会话文件路径**索引，
 *      与模式 / 目标同一套键），重启后接着数。否则「重启一次就躲开阈值」
 *      会让交接永远不发生，而且看起来像「还没压够」。
 *
 * 并发策略与 goal / work-mode 一致：进程内一条串行队列，读-改-写都在队列里，
 * 原子替换（临时文件 + `rename`，Windows 上退化为直写）。落盘失败**必须抛** ——
 * 与目标状态同因：宁可下一次重算，也不要留下「内存里数到了、磁盘上没有」的假状态。
 *
 * ⚠️ 这一层只存计数与交接包，**不建目的会话、不动执行租约**（S5b 的事务）。
 */

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
  HANDOFF_SYSTEM_PROMPT,
  type HandoffPackage,
  type HandoffRequest,
  type HandoffResult,
  type HandoffTally
} from '../shared/handoff'
import type { CompactionRun } from '../shared/ipc'
import { normalizeSessionFileKey } from './work-mode-service'

export const HANDOFF_FILE_NAME = 'handoffs.json'

/** 最多记多少个会话（与 work-modes / goals 同量级）。 */
const MAX_ENTRIES = 2000

export interface HandoffEntry {
  tally: HandoffTally
  /** 最近一次生成的交接包（S5a-2 由模型写、宿主校验后落这里）。 */
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

/** 脏计数一律降级成「没数过」；键只保留字符串。 */
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

/** 脏文档一律降级成空文档，不抛（用户手改坏了文件不能让应用起不来）。 */
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
      /*
       * 交接包的清洗要来源字段：读盘时来源就是这条记录自己的键 ——
       * 缺来源的包一律当「没有」（形如半个包的东西不许进事务）。
       */
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

  /** 读当前状态（不落盘）。未知会话返回空计数 + 没有交接包。 */
  state(sessionKey: string): HandoffEntry {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return emptyEntry()
    return this.doc.entries[key] ?? emptyEntry()
  }

  /**
   * 记一次压缩（幂等）。
   *
   * 返回 `counted:false` 时 `reason` 说明为什么没计（`duplicate` / `manual-or-unknown` /
   * `failed` / `no-stable-key`）—— 诊断与单测都靠它区分「去重挡住了」和「本来就不该计」。
   * 未计数的调用**不落盘**（避免每次 state 推送都写一次文件）。
   */
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

  /** 写入一份已校验过的交接包（S5a-2 生成之后调）。 */
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

  /**
   * 交接成功：新片段从零开始数（§7「成功移交的新片段从零开始」）。
   *
   * 旧的 `keys` 一并丢掉是对的 —— 那些压缩属于**上一个片段**，
   * 新片段要重新攒够 2 次才值得再交接一次。
   */
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

  /** 保证文档已从磁盘读过（幂等）。 */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(handoffDocumentPath(this.root), 'utf8')
      this.doc = sanitizeHandoffDocument(JSON.parse(text))
    } catch {
      /* 文件不存在 / 读不了 / 坏 JSON：都当「还没有任何计数」 */
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
      /* 落盘失败不报成功：把内存态退回磁盘上的样子，让下一次调用重新走一遍 */
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

/* ------------------------------------------------------------ 请求 / 结果文件（S5b-2） */

/*
 * 为什么用文件而不是 IPC / 事件：
 *
 * 宿主与薄层是两个进程里的两套代码，中间只有磁盘。目标续行（S3b/S3c/S5c）已经用
 * 同一套「宿主写快照 → 薄层消费」的模式跑通了三条链路，交接包只是反向一次：
 * 宿主写**请求**、薄层写**结果**。好处是崩溃后两侧都能从磁盘看出「上次做到哪」，
 * 而不是「有一条消息发没发出去只有天知道」。
 *
 * 文件很小、生命周期很短（生成完就删），所以不做单独的 sweep ——
 * 请求没被消费时由薄层的 TTL 兜住，结果没被消费时由下一次交接覆盖。
 */

export const HANDOFF_REQUEST_DIR = 'handoff-request'
export const HANDOFF_RESULT_DIR = 'handoff-result'

export function handoffRequestPath(runnerId: string, root: string = YAN_DIR): string {
  return join(root, HANDOFF_REQUEST_DIR, `${handoffFileKey(runnerId)}.json`)
}

export function handoffResultPath(runnerId: string, root: string = YAN_DIR): string {
  return join(root, HANDOFF_RESULT_DIR, `${handoffFileKey(runnerId)}.json`)
}

/**
 * 组装一份请求（宿主侧渲染好提示词）。
 *
 * `operationId` 与 `handoffId` 分开：`handoffId` 是**这次交接**的身份（事务日志里贯穿），
 * `operationId` 是**这一次生成**的身份（重做一次交接包时换新的，旧结果据此作废）。
 */
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
    sourceHead: input.sourceHead ?? null,
    mode: input.mode,
    model: input.model ?? null,
    createdAt: input.now ?? Date.now()
  }
}

/** 薄层与单测都用的结果组装（`error` 与 `text` 可以同时为空 —— 那是「跑了但什么都没回」）。 */
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

/**
 * 请求 / 结果文件的门面（无内存状态 —— 每次调用都看磁盘，因为写入方是另一个进程）。
 */
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

  /** 写请求。`runnerId` 洗不出可用文件名时返回 `false`（调用方据此放弃这次交接，不写坏文件）。 */
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
