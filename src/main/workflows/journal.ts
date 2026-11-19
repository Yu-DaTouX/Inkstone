import { createHash, type Hash } from 'node:crypto'
import { appendFile, open, readFile, stat } from 'node:fs/promises'
import { atomicWriteFile } from '../atomic-write'

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

function parseLines(text: string, strict = false): unknown[] {
  const out: unknown[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    try {
      const line = JSON.parse(raw)
      if (strict && !isReplayLine(line)) throw new Error('未知记录')
      out.push(line)
    } catch {
      if (strict) throw new Error(`运行日志格式损坏（第 ${out.length + 1} 条记录）`)
    }
  }
  return out
}

function isReplayLine(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const line = value as JournalLine
  if (!Number.isInteger(line.attempt) || line.attempt < 1 || !Number.isFinite(line.at)) return false
  if (isMark(line)) return Number.isInteger(line.seq) && line.seq >= 0
  if ('kind' in line && line.kind === 'io') return typeof line.path === 'string' && ['read', 'write', 'list'].includes(line.op)
  return isEntry(line) && (line.kind === undefined || line.kind === 'model') && (line.status !== 'done' || 'result' in line)
}

export function readJournal(input: string | unknown[]): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>()
  for (const line of typeof input === 'string' ? parseLines(input) : input) {
    if (line && typeof line === 'object' && isMark(line as JournalLine)) {
      const mark = line as DivergedMark
      for (const seq of [...entries.keys()]) if (seq >= mark.seq) entries.delete(seq)
      continue
    }
    if (isEntry(line) && line.kind === undefined) entries.set(line.seq, line)
  }
  return entries
}

export function readModelJournal(input: string | unknown[]): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>()
  for (const line of typeof input === 'string' ? parseLines(input) : input) {
    if (isEntry(line) && line.kind === 'model') entries.set(line.seq, line)
  }
  return entries
}

function checkpointFile(file: string): string {
  return `${file}.checkpoint`
}

async function saveCheckpoint(file: string, digest: string): Promise<void> {
  await atomicWriteFile(checkpointFile(file), digest, { durable: true, syncDir: true })
}

export async function initializeJournal(file: string, data: Buffer): Promise<void> {
  await saveCheckpoint(file, createHash('sha256').update(data).digest('hex'))
}

export async function loadReplayJournal(file: string, checked: boolean) {
  const data = await readFile(file)
  if (data.length && data[data.length - 1] !== 10) throw new Error('运行日志末尾不完整')
  if (checked && await readFile(checkpointFile(file), 'utf8') !== createHash('sha256').update(data).digest('hex')) {
    throw new Error('运行日志与校验记录不符，可能已丢失或损坏')
  }
  const lines = parseLines(new TextDecoder('utf-8', { fatal: true }).decode(data), true)
  return { data, lines, agents: readJournal(lines), models: readModelJournal(lines) }
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
  private readonly hash: Hash | undefined
  private bytes: number
  failure?: string

  constructor(private readonly file: string, initial?: Buffer, private readonly onFailure?: () => void) {
    this.hash = initial && createHash('sha256').update(initial)
    this.bytes = initial?.length ?? 0
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure = `工作流不可恢复：保存或校验运行日志失败，已产生的调用结果可能未保存，禁止续跑以免重复执行（${error instanceof Error ? error.message : String(error)}）`
    this.onFailure?.()
  }

  private async checkedWrite(data: Buffer): Promise<void> {
    const handle = await open(this.file, 'r+')
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== this.bytes) throw new Error('运行日志已丢失或长度不符')
      if (this.hash) {
        const { bytesWritten } = await handle.write(data, 0, data.length, this.bytes)
        if (bytesWritten !== data.length) throw new Error('运行日志未写完整')
        await handle.sync()
        this.hash.update(data)
        await saveCheckpoint(this.file, this.hash.copy().digest('hex'))
        this.bytes += bytesWritten
      }
      const named = await stat(this.file)
      if (info.dev !== named.dev || info.ino !== named.ino || named.size !== this.bytes) throw new Error('运行日志已被移动或替换')
    } finally {
      await handle.close()
    }
  }

  append(line: JournalLine): Promise<boolean> {
    if (this.failure) return Promise.resolve(false)
    try {
      this.buffer.push(`${JSON.stringify(line)}\n`)
    } catch (error) {
      this.fail(error)
      return Promise.resolve(false)
    }
    if (!this.scheduled) {
      this.scheduled = true
      this.chain = this.chain.then(async () => {
        this.scheduled = false
        const text = this.buffer.join('')
        this.buffer = []
        if (!this.failure) {
          if (this.hash) await this.checkedWrite(Buffer.from(text))
          else await appendFile(this.file, text, 'utf8')
        }
      }).catch((error: unknown) => this.fail(error))
    }
    return this.chain.then(() => !this.failure)
  }

  async flush(): Promise<void> {
    await this.chain
    if (this.hash && !this.failure) {
      try {
        const [data, digest] = await Promise.all([readFile(this.file), readFile(checkpointFile(this.file), 'utf8')])
        if (digest !== this.hash.copy().digest('hex') || digest !== createHash('sha256').update(data).digest('hex')) {
          throw new Error('运行日志与校验记录不符，可能已丢失或损坏')
        }
      } catch (error) {
        this.fail(error)
      }
    }
  }
}
