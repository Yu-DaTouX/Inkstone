import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { YAN_DIR } from './paths'
import {
  HANDOFF_EVENT_LIMIT,
  normalizeHandoffEvent,
  sanitizeHandoffEventLine,
  type HandoffEvent
} from '../shared/handoff-diagnostics'

export const HANDOFF_DIAGNOSTICS_DIR = 'handoff'
export const HANDOFF_EVENT_FILE = 'events.jsonl'

export function handoffEventPath(root: string = YAN_DIR): string {
  return join(root, HANDOFF_DIAGNOSTICS_DIR, HANDOFF_EVENT_FILE)
}

export interface HandoffDiagnosticsOptions {
  root?: string
  now?: () => number
  limit?: number
}

export class HandoffDiagnostics {
  private readonly root: string
  private readonly now: () => number
  private readonly limit: number
  private readonly file: string
  private events: HandoffEvent[] = []
  private tail: Promise<void> = Promise.resolve()
  private dirty = false
  private loaded = false

  constructor(options: HandoffDiagnosticsOptions = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
    this.limit = Number.isFinite(options.limit) && (options.limit as number) > 0 ? Math.floor(options.limit as number) : HANDOFF_EVENT_LIMIT
    this.file = handoffEventPath(this.root)
  }

  path(): string {
    return this.file
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw = ''
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return
    }
    const parsed: HandoffEvent[] = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = sanitizeHandoffEventLine(JSON.parse(trimmed))
        if (event) parsed.push(event)
      } catch {
      }
    }
    this.events = parsed.slice(-this.limit)
  }

  record(input: Partial<HandoffEvent> & { at?: number; stage: HandoffEvent['stage']; outcome: string }): HandoffEvent {
    const event = normalizeHandoffEvent({ ...input, at: input.at ?? this.now() })
    this.events.push(event)
    if (this.events.length > this.limit) this.events = this.events.slice(-this.limit)
    this.schedule()
    return event
  }

  recent(limit = this.limit): HandoffEvent[] {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : this.limit
    return this.events.slice(-n)
  }

  async flush(): Promise<void> {
    await this.tail.catch(() => undefined)
  }

  private schedule(): void {
    if (this.dirty) return
    this.dirty = true
    this.tail = this.tail
      .then(async () => {
        this.dirty = false
        await this.persist()
      })
      .catch(() => undefined)
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      const body = this.events.map((event) => JSON.stringify(event)).join('\n')
      await writeFile(temp, body ? `${body}\n` : '', 'utf8')
      await rename(temp, this.file)
    } catch {
    }
  }
}
