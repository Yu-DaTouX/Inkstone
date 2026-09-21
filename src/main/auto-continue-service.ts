/**
 * 模型出错后「自动继续」的会话级状态（实施-05 S5c）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * 自动继续最危险的失败不是「没继续」，而是**继续得太多**：上游一直挂，
 * 没人看着，它一轮轮重试把额度烧光；或者用户已经接手了，它还在旁边抢着发消息。
 * 所以这一层只做一件事：**把「这个会话连续失败了几次」记准**，并据此给出计划。
 *
 *   1. **幂等**：`auto_retry_end` 与 `stopReason === 'error'` 会同时报同一件事，
 *      同一错误在短窗口内重放只算一次（`isDuplicateError`）；
 *   2. **重启不忘记**：次数写进 `YAN_DIR/auto-continue.json`（按会话文件路径）——
 *      重启后接着数，避免「重启一次就重新给满额度」；
 *   3. **用户优先**：用户发言 / 用户停止 / 一轮真的成功 → 归零（下一轮错误从第 1 次算）。
 *
 * 判定本身（分类 / 退避 / 上限）全在 `shared/auto-continue.ts`，这里只管持久化。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  classifyModelError,
  emptyAutoContinueState,
  isDuplicateError,
  planAutoContinue,
  sanitizeAutoContinueOptions,
  type AutoContinuePlan,
  type AutoContinueState
} from '../shared/auto-continue'
import { normalizeSessionFileKey } from './work-mode-service'

export const AUTO_CONTINUE_FILE_NAME = 'auto-continue.json'

/** 最多记多少个会话（与其它 store 同量级）。 */
const MAX_ENTRIES = 2000

interface AutoContinueEntry {
  attempts: number
  lastError: string | null
  lastAt: number
}

export interface AutoContinueDocument {
  version: 1
  entries: Record<string, AutoContinueEntry>
  updatedAt: number
}

export function autoContinueDocumentPath(root: string = YAN_DIR): string {
  return join(root, AUTO_CONTINUE_FILE_NAME)
}

function emptyEntry(): AutoContinueEntry {
  return { attempts: 0, lastError: null, lastAt: 0 }
}

/** 脏值一律降级成「没失败过」（宁可多试一次，也不要因为一条坏记录永远不重试）。 */
function sanitizeEntry(raw: unknown): AutoContinueEntry {
  if (!raw || typeof raw !== 'object') return emptyEntry()
  const item = raw as Partial<AutoContinueEntry>
  return {
    attempts:
      typeof item.attempts === 'number' && Number.isFinite(item.attempts) && item.attempts > 0
        ? Math.floor(item.attempts)
        : 0,
    lastError: typeof item.lastError === 'string' && item.lastError ? item.lastError : null,
    lastAt: typeof item.lastAt === 'number' && Number.isFinite(item.lastAt) ? item.lastAt : 0
  }
}

export function sanitizeAutoContinueDocument(raw: unknown): AutoContinueDocument {
  if (!raw || typeof raw !== 'object') return { version: 1, entries: {}, updatedAt: 0 }
  const doc = raw as Partial<AutoContinueDocument>
  const entries: Record<string, AutoContinueEntry> = {}
  for (const [key, value] of Object.entries(doc.entries ?? {})) {
    const id = normalizeSessionFileKey(key)
    if (!id) continue
    entries[id] = sanitizeEntry(value)
  }
  const updatedAt = typeof doc.updatedAt === 'number' && Number.isFinite(doc.updatedAt) ? doc.updatedAt : 0
  return { version: 1, entries, updatedAt }
}

/** `YAN_AUTO_CONTINUE`（测试通道）：覆盖上限与退避间隔。 */
export function autoContinueOptionsFromEnv(raw: string | undefined): { limit?: number; delays?: number[] } {
  if (!raw || !raw.trim()) return {}
  try {
    return sanitizeAutoContinueOptions(JSON.parse(raw))
  } catch {
    return {}
  }
}

export interface AutoContinueStoreOptions {
  root?: string
  now?: () => number
  /** 覆盖上限（默认 3） */
  limit?: number
  /** 覆盖退避（默认 3s / 10s / 30s） */
  delays?: readonly number[]
}

export class AutoContinueStore {
  private readonly root: string
  private readonly now: () => number
  private readonly limit?: number
  private readonly delays?: readonly number[]
  private doc: AutoContinueDocument = { version: 1, entries: {}, updatedAt: 0 }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: AutoContinueStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.limit = options.limit
    this.delays = options.delays
  }

  state(sessionKey: string): AutoContinueState {
    const key = normalizeSessionFileKey(sessionKey)
    if (!key) return emptyAutoContinueState(this.now())
    const entry = this.doc.entries[key] ?? emptyEntry()
    return { attempts: entry.attempts, lastError: entry.lastError, lastAt: entry.lastAt }
  }

  /**
   * 记一次模型错误，并给出「该不该自动继续、隔多久」的计划。
   *
   * 返回 `plan: null` 表示这次**是重复上报**（`auto_retry_end` 与 `stopReason` 同时到达），
   * 调用方应当忽略 —— 不落盘、不发通知、不计数。
   */
  async noteFailure(
    sessionKey: string,
    errorText: unknown,
    opts: { userStopped?: boolean } = {}
  ): Promise<{ plan: AutoContinuePlan | null; state: AutoContinueState; duplicate: boolean }> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      const error = classifyModelError(errorText)
      const signature = error.text || error.label
      if (!key) {
        const state = emptyAutoContinueState(this.now())
        return { plan: null, state, duplicate: false }
      }
      const at = this.now()
      const entry = (this.doc.entries[key] ??= emptyEntry())
      if (isDuplicateError({ attempts: entry.attempts, lastError: entry.lastError, lastAt: entry.lastAt }, signature, at)) {
        return {
          plan: null,
          state: { attempts: entry.attempts, lastError: entry.lastError, lastAt: entry.lastAt },
          duplicate: true
        }
      }

      const state: AutoContinueState = {
        attempts: entry.attempts,
        lastError: entry.lastError,
        lastAt: entry.lastAt
      }
      const plan = planAutoContinue({
        state,
        error,
        userStopped: opts.userStopped === true,
        ...(this.limit ? { limit: this.limit } : {}),
        ...(this.delays ? { delays: this.delays } : {})
      })

      /*
       * 计数语义：
       *   · 继续 → +1；
       *   · 到上限 → 保持（用户不发言就不会再试，一发言就 `reset`）；
       *   · 不值得重试 / 用户停止 → 归零（额度恢复后不该被上次的失败挡着）。
       */
      if (plan.action === 'retry') entry.attempts = state.attempts + 1
      else if (plan.reason !== 'limit') entry.attempts = 0
      entry.lastError = signature
      entry.lastAt = at
      this.doc.updatedAt = at
      this.trim()
      await this.persist()
      return { plan, state: { ...state, attempts: entry.attempts, lastError: entry.lastError, lastAt: at }, duplicate: false }
    })
  }

  /** 用户发言 / 用户停止 / 一轮成功 → 归零（只在真的变过时落盘）。 */
  async reset(sessionKey: string): Promise<void> {
    return this.enqueue(async () => {
      const key = normalizeSessionFileKey(sessionKey)
      if (!key) return
      const entry = this.doc.entries[key]
      if (!entry || (entry.attempts === 0 && !entry.lastError)) return
      this.doc.entries[key] = emptyEntry()
      this.doc.updatedAt = this.now()
      await this.persist()
    })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(autoContinueDocumentPath(this.root), 'utf8')
      this.doc = sanitizeAutoContinueDocument(JSON.parse(text))
    } catch {
      this.doc = { version: 1, entries: {}, updatedAt: 0 }
    }
  }

  snapshot(): AutoContinueDocument {
    return { ...this.doc, entries: { ...this.doc.entries } }
  }

  private trim(): void {
    const ids = Object.keys(this.doc.entries)
    if (ids.length <= MAX_ENTRIES) return
    ids
      .sort((a, b) => this.doc.entries[a].lastAt - this.doc.entries[b].lastAt)
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((key) => delete this.doc.entries[key])
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = autoContinueDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeAutoContinueDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, entries: {}, updatedAt: 0 }
      }
      throw new Error('自动继续状态落盘失败')
    }
  }
}
