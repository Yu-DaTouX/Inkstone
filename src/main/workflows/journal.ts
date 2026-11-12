import { appendFile } from 'node:fs/promises'

export type JournalStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface JournalEntry {
  seq: number
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
}

export interface DivergedMark {
  type: 'diverged'
  seq: number
  attempt: number
  at: number
}

export type JournalLine = JournalEntry | DivergedMark

function isMark(line: JournalLine): line is DivergedMark {
  return (line as DivergedMark).type === 'diverged'
}

function isEntry(value: unknown): value is JournalEntry {
  const line = value as JournalEntry | null
  return !!line && typeof line === 'object' && Number.isInteger(line.seq) && line.seq >= 0 && typeof line.hash === 'string' &&
    (line.status === 'running' || line.status === 'done' || line.status === 'failed' || line.status === 'stopped')
}

export function readJournal(text: string): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>()
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    let line: unknown
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (line && typeof line === 'object' && isMark(line as JournalLine)) {
      const mark = line as DivergedMark
      for (const seq of [...entries.keys()]) if (seq >= mark.seq) entries.delete(seq)
      continue
    }
    if (isEntry(line)) entries.set(line.seq, line)
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

export class JournalWriter {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  append(line: JournalLine): Promise<void> {
    const text = `${JSON.stringify(line)}\n`
    this.chain = this.chain.then(() => appendFile(this.file, text, 'utf8')).catch((error: unknown) => {
      console.warn('[workflow] 写运行记录失败', error)
    })
    return this.chain
  }

  flush(): Promise<void> {
    return this.chain
  }
}
