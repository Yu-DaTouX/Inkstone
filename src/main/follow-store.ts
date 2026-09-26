/**
 * 持续关注的落盘与服务（实施-25 P16）。
 *
 * 一份文档 `YAN_DIR/follows.json`（`watches` + `runs`）：
 * 运行记录只对它的关注有意义，生命周期绑在一起（删关注带走记录）。
 *
 * ── 这里**没有调度器** ──
 * 「随应用运行」的意思是：**到点了在界面上提醒**，不是后台自己去查。
 * 宿主不主动调模型（那会变成后台花钱，而且用户看不见），
 * 所以这个文件里没有 `setInterval`：只有 `due()`（谁到点了）与
 * `report()`（模型看完了把结果记回来）。
 *
 * 另外，「用户没启用的关注不自行建立」（T16-3）落在 `save()` 上：
 * 新关注的 `enabled` 必须由调用方显式给 `true`，否则就是一条**提议**。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  applyRunToWatch,
  applyWatchPatch,
  createWatch,
  dueWatches,
  emptyFollowDocument,
  findWatch,
  FOLLOW_LIMITS,
  pruneRuns,
  removeSpaceWatchesFrom,
  removeWatchFrom,
  runsForWatch,
  sanitizeFollowDocument,
  upsertWatchIn,
  validateWatchInput,
  watchViews,
  type FollowDocument,
  type FollowErrorCode,
  type FollowOutcome,
  type FollowRun,
  type Watch,
  type WatchInput,
  type WatchView
} from '../shared/follow'

export const FOLLOW_FILE_NAME = 'follows.json'

export function followPath(root: string = YAN_DIR): string {
  return join(root, FOLLOW_FILE_NAME)
}

export interface FollowStoreOptions {
  root?: string
  idFactory?: () => string
  now?: () => number
}

export type FollowMutation<T> = { ok: true; value: T } | { ok: false; code: FollowErrorCode; error: string }

export class FollowStore {
  private readonly root: string
  private readonly now: () => number
  private readonly idFactory: () => string
  private doc: FollowDocument = emptyFollowDocument()
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: FollowStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? defaultFollowId
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(followPath(this.root), 'utf8')
      this.doc = sanitizeFollowDocument(JSON.parse(text))
    } catch {
      this.doc = emptyFollowDocument()
    }
  }

  snapshot(): FollowDocument {
    return { version: 1, watches: [...this.doc.watches], runs: [...this.doc.runs] }
  }

  list(spaceId?: string | null): Watch[] {
    return spaceId ? this.doc.watches.filter((w) => !w.spaceId || w.spaceId === spaceId) : [...this.doc.watches]
  }

  views(spaceId?: string | null): WatchView[] {
    return watchViews(this.doc, spaceId, this.now())
  }

  find(id: string): Watch | null {
    return findWatch(this.doc, id) ?? null
  }

  runs(watchId: string, limit = 10): FollowRun[] {
    return runsForWatch(this.doc, watchId, limit)
  }

  /** 到点了该看的（**只数用户启用过的**）。 */
  due(): Watch[] {
    return dueWatches(this.doc.watches, this.now())
  }

  async save(input: WatchInput & { id?: unknown }): Promise<FollowMutation<Watch>> {
    await this.load()
    const valid = validateWatchInput(input)
    if (!valid.ok) return { ok: false, code: valid.code, error: valid.message }
    const now = this.now()
    const existingId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : ''
    const existing = existingId ? findWatch(this.doc, existingId) : undefined
    if (existingId && !existing) return { ok: false, code: 'not_found', error: '找不到这个关注' }
    if (!existing) {
      if (this.doc.watches.length >= FOLLOW_LIMITS.maxWatches) {
        return { ok: false, code: 'too_many_watches', error: `最多 ${FOLLOW_LIMITS.maxWatches} 个关注` }
      }
      const watch = createWatch(valid.value, { id: this.nextId(), now })
      await this.persist(upsertWatchIn(this.doc, watch))
      return { ok: true, value: watch }
    }
    const watch: Watch = { ...existing, ...valid.value, id: existing.id, createdAt: existing.createdAt, updatedAt: now }
    await this.persist(upsertWatchIn(this.doc, watch))
    return { ok: true, value: watch }
  }

  async update(
    id: string,
    patch: { title?: unknown; kind?: unknown; cadence?: unknown; intervalMinutes?: unknown; resultPlace?: unknown; notifyOn?: unknown; enabled?: unknown }
  ): Promise<FollowMutation<Watch>> {
    await this.load()
    const prev = findWatch(this.doc, id)
    if (!prev) return { ok: false, code: 'not_found', error: '找不到这个关注' }
    const patched = applyWatchPatch(prev, patch, this.now())
    if (!patched.ok) return { ok: false, code: patched.code, error: patched.message }
    await this.persist(upsertWatchIn(this.doc, patched.watch))
    return { ok: true, value: patched.watch }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    await this.load()
    if (!findWatch(this.doc, id)) return { ok: false, error: '找不到这个关注' }
    await this.persist(removeWatchFrom(this.doc, id))
    return { ok: true }
  }

  async removeSpace(spaceId: string): Promise<number> {
    await this.load()
    const { doc, removed } = removeSpaceWatchesFrom(this.doc, spaceId)
    if (removed > 0) await this.persist(doc)
    return removed
  }

  /**
   * 记一次跟进结果（模型看完后回报）。
   *
   * 只接受这四种结局；`summary` 与列表都可空（「没看成」往往没什么可写的）。
   */
  async report(input: {
    watchId?: unknown
    outcome?: unknown
    summary?: unknown
    changed?: unknown
    decisions?: unknown
  }): Promise<FollowMutation<{ run: FollowRun; watch: Watch }>> {
    await this.load()
    const watchId = typeof input.watchId === 'string' ? input.watchId.trim() : ''
    const watch = findWatch(this.doc, watchId)
    if (!watch) return { ok: false, code: 'not_found', error: '找不到这个关注' }
    const outcome = input.outcome
    if (outcome !== 'no-change' && outcome !== 'changed' && outcome !== 'needs-decision' && outcome !== 'failed') {
      return { ok: false, code: 'bad_notify', error: '结果只能是 no-change / changed / needs-decision / failed' }
    }
    const at = this.now()
    const list = (value: unknown): string[] => {
      if (!Array.isArray(value)) return []
      const out: string[] = []
      for (const item of value) {
        if (typeof item !== 'string') continue
        const trimmed = item.trim()
        if (!trimmed || [...trimmed].length > FOLLOW_LIMITS.maxText) continue
        if (!out.includes(trimmed)) out.push(trimmed)
        if (out.length >= FOLLOW_LIMITS.maxList) break
      }
      return out
    }
    const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, FOLLOW_LIMITS.maxText) : ''
    const run: FollowRun = {
      id: this.nextId(),
      watchId: watch.id,
      at,
      outcome: outcome as FollowOutcome,
      summary,
      changed: list(input.changed),
      decisions: list(input.decisions)
    }
    const nextWatch = applyRunToWatch(watch, { outcome: run.outcome, at })
    await this.persist(pruneRunsDoc(upsertWatchIn({ ...this.doc, runs: [run, ...this.doc.runs] }, nextWatch)))
    return { ok: true, value: { run, watch: nextWatch } }
  }

  /**
   * 显式查重：存储按 id 替换，随机 id 撞车会静默覆盖别人的关注 / 记录。
   */
  private nextId(): string {
    const taken = new Set([...this.doc.watches.map((w) => w.id), ...this.doc.runs.map((r) => r.id)])
    for (let i = 0; i < 50; i += 1) {
      const id = this.idFactory()
      if (!taken.has(id)) return id
    }
    return `fw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private persist(doc: FollowDocument): Promise<FollowDocument> {
    return this.enqueue(async () => {
      this.doc = doc
      const path = followPath(this.root)
      const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(temp, JSON.stringify(this.doc), 'utf8')
        await rename(temp, path)
      } catch {
        try {
          const text = await readFile(path, 'utf8')
          this.doc = sanitizeFollowDocument(JSON.parse(text))
        } catch {
          this.doc = emptyFollowDocument()
        }
        throw new Error('关注落盘失败')
      }
      return this.doc
    })
  }
}

/** 只留每个关注最近 N 条运行记录。 */
function pruneRunsDoc(doc: FollowDocument): FollowDocument {
  return { ...doc, runs: pruneRuns(doc.runs) }
}

function defaultFollowId(): string {
  return `fw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
