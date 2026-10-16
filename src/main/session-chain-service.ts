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

const MAX_CHAINS = 2000

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

  chains(): SessionChain[] {
    return this.doc.chains
  }

  chainOf(sessionFile: string): SessionChain | null {
    return chainForFile(this.doc.chains, sessionFile)
  }

  isRepresentative(sessionFile: string): boolean {
    return isRepresentative(this.doc.chains, sessionFile)
  }

  async link(fromFile: string, toFile: string, handoffId: string | null): Promise<SessionChain | null> {
    return this.enqueue(async () => {
      const from = normalizeChainKey(fromFile)
      const to = normalizeChainKey(toFile)
      if (!from || !to || from === to) return null

      const existingTo = chainForFile(this.doc.chains, to)
      const current = chainForFile(this.doc.chains, from)
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

  representativeOf(sessionFile: string): string | null {
    const chain = this.chainOf(sessionFile)
    return chain ? (chainRepresentative(chain)?.sessionFile ?? null) : normalizeChainKey(sessionFile)
  }

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
