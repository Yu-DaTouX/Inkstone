/**
 * 会话链的会话级存储（实施-05 S5b）。
 *
 * ══════════════════════════════════════════════════════════
 * 它守的是什么
 * ══════════════════════════════════════════════════════════
 * 「后台两份、前端一条」全靠这份关系：**哪几段属于同一条会话**。
 * 它一旦写错，界面就会出现两条会话（用户在侧栏看到不该存在的第二段）、
 * 或者历史拼错顺序（读侧按段顺序取文件）。所以三条不变式在这里钉死：
 *
 *   1. **一个段只属于一条链**（`sanitizeSessionChains` 也守这条）——
 *      合并两条链是**猜测**，宁可少一条关系也不要凭猜拼历史；
 *   2. **链内向后追加**（`link` 只往后接，历史不重排）—— 交接是单向过程；
 *   3. **落盘失败必须抛**（与目标 / 交接计数同因）：内存里有一条链、磁盘上没有，
 *      重启后界面就会突然多出一条会话 —— 那比「这次交接失败」糟得多。
 *
 * ⚠️ 这一层**不改写任何 JSONL**，只写 `YAN_DIR/session-chains.json`（旁挂关系）。
 *    真正的「创建目的会话 + 执行租约 + resume」是 S5b 的事务侧。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  SESSION_CHAIN_FILE_NAME,
  appendSegment,
  chainForFile,
  chainRepresentative,
  createChain,
  isRepresentative,
  normalizeChainKey,
  sanitizeSessionChains,
  type SessionChain
} from '../shared/session-chain'

/** 最多记多少条链（与其它 store 同量级）。 */
const MAX_CHAINS = 2000

/* 落盘文件名与契约同一份定义（避免两处常量漂移） */
export { SESSION_CHAIN_FILE_NAME }

export interface SessionChainDocument {
  version: 1
  chains: SessionChain[]
  updatedAt: number
}

export function sessionChainDocumentPath(root: string = YAN_DIR): string {
  return join(root, SESSION_CHAIN_FILE_NAME)
}

export function sanitizeSessionChainDocument(raw: unknown): SessionChainDocument {
  const chains = sanitizeSessionChains(raw)
  const updatedAt = Number.isFinite((raw as { updatedAt?: number } | null)?.updatedAt)
    ? Number((raw as { updatedAt?: number }).updatedAt)
    : 0
  return { version: 1, chains, updatedAt }
}

export interface SessionChainStoreOptions {
  root?: string
  now?: () => number
}

export class SessionChainStore {
  private readonly root: string
  private readonly now: () => number
  private doc: SessionChainDocument = { version: 1, chains: [], updatedAt: 0 }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: SessionChainStoreOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  /** 全部链（界面 / 侧栏用；调用前请先 `load`）。 */
  chains(): SessionChain[] {
    return this.doc.chains
  }

  chainOf(sessionFile: string): SessionChain | null {
    return chainForFile(this.doc.chains, sessionFile)
  }

  /**
   * 这条会话在侧栏里该不该显示（只有代表段显示）。
   *
   * 不在任何链上 → 显示（孤立会话自己就是一条）。
   */
  isRepresentative(sessionFile: string): boolean {
    return isRepresentative(this.doc.chains, sessionFile)
  }

  /**
   * 交接提交：把 `toFile` 作为 `fromFile` 所在链的新段。
   *
   * 四种情形都有确定行为：
   *   · `fromFile` 已在某链上 → 向后追加（幂等：`toFile` 已在链上就原样返回）；
   *   · `fromFile` 不在任何链上 → 新建一条链 `[from, to]`（首段交接）；
   *   · `toFile` 已经属于**另一条**链 → 拒绝并原样返回（一个段只能属于一条链）；
   *   · 键不可用（空 / 控制字符）→ 返回 `null`，不落盘。
   *
   * 返回提交后 `fromFile` 所在的链（调用方据此拿到代表段 = 新段）。
   */
  async link(fromFile: string, toFile: string, handoffId: string | null): Promise<SessionChain | null> {
    return this.enqueue(async () => {
      const from = normalizeChainKey(fromFile)
      const to = normalizeChainKey(toFile)
      if (!from || !to || from === to) return null

      const existingTo = chainForFile(this.doc.chains, to)
      const current = chainForFile(this.doc.chains, from)
      /* `to` 已属于另一条链：拒绝，且不改任何东西（合并是猜测） */
      if (existingTo && existingTo !== current) return existingTo

      const at = this.now()
      let next: SessionChain
      if (current) {
        const appended = appendSegment(current, { sessionFile: to, startedAt: at, handoffId })
        if (appended === current) return current
        next = { ...appended, updatedAt: at }
        this.doc.chains = this.doc.chains.map((chain) => (chain === current ? next : chain))
      } else {
        const base = createChain({ sessionFile: from, startedAt: at, handoffId: null })
        if (!base) return null
        const appended = appendSegment(base, { sessionFile: to, startedAt: at, handoffId })
        next = { ...appended, updatedAt: at }
        this.doc.chains = [...this.doc.chains, next]
      }
      this.doc.updatedAt = at
      this.trim()
      await this.persist()
      return next
    })
  }

  /** 代表段（最后一段）；界面 / 发送目标都用它。 */
  representativeOf(sessionFile: string): string | null {
    const chain = this.chainOf(sessionFile)
    return chain ? (chainRepresentative(chain)?.sessionFile ?? null) : normalizeChainKey(sessionFile)
  }

  /**
   * 忘掉包含这个段的**整条链**（删除会话时调）。
   *
   * 为什么整条一起忘：段文件都进了回收站，链记录再留着就会让「代表段」
   * 指向一个不存在的文件 —— 侧栏会因此把另一段（真实存在）也藏起来。
   * 幂等：不在任何链上时返回 false，不动磁盘。
   */
  async forget(sessionFile: string): Promise<boolean> {
    return this.enqueue(async () => {
      const key = normalizeChainKey(sessionFile)
      if (!key) return false
      const before = this.doc.chains.length
      this.doc.chains = this.doc.chains.filter(
        (chain) => !chain.segments.some((seg) => normalizeChainKey(seg.sessionFile) === key)
      )
      if (this.doc.chains.length === before) return false
      this.doc.updatedAt = this.now()
      await this.persist()
      return true
    })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(sessionChainDocumentPath(this.root), 'utf8')
      this.doc = sanitizeSessionChainDocument(JSON.parse(text))
    } catch {
      /* 文件不存在 / 读不了 / 坏 JSON：都当「还没有任何链」（每条会话各自一条） */
      this.doc = { version: 1, chains: [], updatedAt: 0 }
    }
  }

  snapshot(): SessionChainDocument {
    return { ...this.doc, chains: [...this.doc.chains] }
  }

  private trim(): void {
    if (this.doc.chains.length <= MAX_CHAINS) return
    this.doc.chains = [...this.doc.chains]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CHAINS)
      .sort((a, b) => a.updatedAt - b.updatedAt)
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job)
    this.tail = next.catch(() => {})
    return next
  }

  private async persist(): Promise<void> {
    const path = sessionChainDocumentPath(this.root)
    const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, JSON.stringify(this.doc), 'utf8')
      await rename(temp, path)
    } catch {
      /* 落盘失败不报成功：回退内存态，让调用方看到失败 */
      try {
        const text = await readFile(path, 'utf8')
        this.doc = sanitizeSessionChainDocument(JSON.parse(text))
      } catch {
        this.doc = { version: 1, chains: [], updatedAt: 0 }
      }
      throw new Error('会话链落盘失败')
    }
  }
}
