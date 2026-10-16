import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { YAN_DIR } from '../paths'
import type { RunCounts, RunKind, RunModel } from '../../shared/runs'

export interface RunHistorySegment {
  phase: string
  from: number
  to: number
}

export interface RunHistoryRecord {
  runId: string
  code: string
  kind: RunKind
  sessionId: string
  sessionPath?: string
  projectId?: string
  parentRunId?: string
  title: string
  model?: RunModel
  startedAt: number
  endedAt: number
  terminal: 'done' | 'stopped' | 'failed'
  cause?: string
  errorKind?: string
  message?: string
  segments: RunHistorySegment[]
  costUsd?: number
  counts: RunCounts
}

export interface RunHistoryWriter {
  append(record: RunHistoryRecord): Promise<void>
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function runHistoryPath(at: number, root: string = YAN_DIR): string {
  const date = new Date(at)
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return join(root, 'runs', `${day}.jsonl`)
}

export interface DurableRunHistoryOptions {
  write?: (path: string, text: string, mode: 'append') => Promise<void>
}

export class DurableRunHistory implements RunHistoryWriter {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly root: string = YAN_DIR,
    private readonly options: DurableRunHistoryOptions = {}
  ) {}

  append(record: RunHistoryRecord): Promise<void> {
    const job = this.tail.then(() => this.write(record))
    this.tail = job.catch(() => undefined)
    return job
  }

  whenIdle(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  private async write(record: RunHistoryRecord): Promise<void> {
    const path = runHistoryPath(record.endedAt, this.root)
    const text = `${JSON.stringify(record)}\n`
    if (this.options.write) {
      await this.options.write(path, text, 'append')
      return
    }
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

export class MemoryRunHistory implements RunHistoryWriter {
  readonly records: RunHistoryRecord[] = []
  async append(record: RunHistoryRecord): Promise<void> {
    this.records.push(record)
  }
}
