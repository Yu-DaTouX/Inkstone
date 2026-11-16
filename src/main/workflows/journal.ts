import { appendFile } from 'node:fs/promises'

export type JournalStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface JournalEntry {
  kind?: 'model'
  seq: number
  index?: number
  hash: string
  status: JournalStatus
  attempt: number
  at: number
  subagentId?: string
  label?: string
  phase?: string
  result?: unknown
  error?: string
  cached?: boolean
  model?: string
  usage?: unknown
  stopReason?: string
}

export interface DivergedMark {
  type: 'diverged'
  seq: number
  attempt: number
  at: number
}

export interface IoLine {
  kind: 'io'
  op: 'read' | 'write' | 'list'
  path: string
  attempt: number
  at: number
  bytes?: number
  count?: number
  sha?: string
  error?: string
}

export type JournalLine = JournalEntry | DivergedMark | IoLine

function isMark(line: JournalLine): line is DivergedMark {
  return (line as DivergedMark).type === 'diverged'
}

function isEntry(value: unknown): value is JournalEntry {
  const line = value as JournalEntry | null
  return !!line && typeof line === 'object' && Number.isInteger(line.seq) && line.seq >= 0 && typeof line.hash === 'string' &&
    (line.status === 'running' || line.status === 'done' || line.status === 'failed' || line.status === 'stopped')
}

function parseLines(text: string): unknown[] {
  const out: unknown[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    try {
      out.push(JSON.parse(raw))
    } catch {
    }
  }
  return out
}

export function readJournal(text: string): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>()
  for (const line of parseLines(text)) {
    if (line && typeof line === 'object' && isMark(line as JournalLine)) {
      const mark = line as DivergedMark
      for (const seq of [...entries.keys()]) if (seq >= mark.seq) entries.delete(seq)
      continue
    }
    if (isEntry(line) && line.kind === undefined) entries.set(line.seq, line)
  }
  return entries
}

export function readModelJournal(text: string): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>()
  for (const line of parseLines(text)) {
    if (isEntry(line) && line.kind === 'model') entries.set(line.seq, line)
  }
  return entries
}

export type ReplayDecision = { hit: JournalEntry } | { miss: true; mark: boolean }

export class Replay {
  private diverged: boolean

  constructor(private readonly previous: Map<number, JournalEntry>) {
    this.diverged = previous.size === 0
  }

  take(seq: number, hash: string): ReplayDecision {
    if (this.diverged) return { miss: true, mark: false }
    const entry = this.previous.get(seq)
    if (entry && entry.status === 'done' && entry.hash === hash) return { hit: entry }
    this.diverged = true
    const stale = [...this.previous.keys()].some((key) => key >= seq)
    return { miss: true, mark: stale }
  }
}

export class ModelReplay {
  private readonly used = new Set<number>()
  private readonly byHash = new Map<string, number[]>()

  constructor(private readonly previous: Map<number, JournalEntry>) {
    for (const entry of [...previous.values()].sort((a, b) => a.seq - b.seq)) {
      if (entry.status !== 'done') continue
      const list = this.byHash.get(entry.hash) ?? []
      list.push(entry.seq)
      this.byHash.set(entry.hash, list)
    }
  }

  take(seq: number, hash: string): JournalEntry | null {
    const exact = this.previous.get(seq)
    if (exact && exact.status === 'done' && exact.hash === hash && !this.used.has(seq)) {
      this.used.add(seq)
      return exact
    }
    const spare = this.byHash.get(hash)?.find((candidate) => !this.used.has(candidate) && this.previous.get(candidate)?.hash === hash)
    if (spare === undefined) return null
    this.used.add(spare)
    return this.previous.get(spare) ?? null
  }
}

export class JournalWriter {
  private chain: Promise<void> = Promise.resolve()
  private buffer: string[] = []
  private scheduled = false

  constructor(private readonly file: string) {}

  append(line: JournalLine): Promise<void> {
    this.buffer.push(`${JSON.stringify(line)}\n`)
    if (!this.scheduled) {
      this.scheduled = true
      this.chain = this.chain.then(() => {
        this.scheduled = false
        const text = this.buffer.join('')
        this.buffer = []
        return appendFile(this.file, text, 'utf8')
      }).catch((error: unknown) => {
        console.warn('[workflow] 写运行记录失败', error)
      })
    }
    return this.chain
  }

  flush(): Promise<void> {
    return this.chain
  }
}
