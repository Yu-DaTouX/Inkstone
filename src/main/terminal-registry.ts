export const MAX_TERMINALS_PER_OWNER = 12
export const REPLAY_BUFFER_CHARS = 400 * 1024
export const REPLAY_SLACK_CHARS = 64 * 1024
export const FLUSH_INTERVAL_MS = 8
export const FLUSH_THRESHOLD_CHARS = 256 * 1024
const MAX_OWNER_LENGTH = 256

export function safeTerminalCut(buffer: string, desired: number): number {
  let cut = Math.max(0, desired)
  const newline = buffer.indexOf('\n', cut)
  if (newline >= 0 && newline - cut < 4096) cut = newline + 1
  const esc = buffer.lastIndexOf('\x1b', cut)
  if (esc >= 0) {
    const sequence = buffer.slice(esc + 1, cut)
    const complete = sequence.startsWith('[')
      ? /[\x40-\x7e]$/.test(sequence.slice(1))
      : sequence.startsWith(']')
        ? /\x07$|\x1b\\$/.test(sequence.slice(1))
        : sequence.length >= 1
    if (!complete) cut = esc
  }
  const code = buffer.charCodeAt(cut)
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1
  return cut
}

export function appendReplay(buffer: string, data: string, limit = REPLAY_BUFFER_CHARS, slack = REPLAY_SLACK_CHARS): string {
  const next = buffer + data
  if (next.length <= limit + slack) return next
  return next.slice(safeTerminalCut(next, next.length - limit))
}

export function normalizeOwner(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const owner = raw.trim()
  return owner && owner.length <= MAX_OWNER_LENGTH ? owner : undefined
}

export interface OwnedTerminal {
  id: string
  owner?: string
  alive: boolean
}

export function planOwnerSlot(
  terminals: readonly OwnedTerminal[],
  owner: string,
  limit = MAX_TERMINALS_PER_OWNER
): { allowed: boolean; evict: string[] } {
  const owned = terminals.filter((terminal) => terminal.owner === owner)
  if (owned.length < limit) return { allowed: true, evict: [] }
  const exited = owned.filter((terminal) => !terminal.alive)
  const needed = owned.length - limit + 1
  if (exited.length < needed) return { allowed: false, evict: [] }
  return { allowed: true, evict: exited.slice(0, needed).map((terminal) => terminal.id) }
}

type Schedule = (fn: () => void, ms: number) => unknown
type Cancel = (handle: unknown) => void

export class OutputBatcher {
  private readonly pending = new Map<string, string>()
  private handle: unknown = null

  constructor(
    private readonly emit: (id: string, data: string) => void,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: Cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    private readonly intervalMs = FLUSH_INTERVAL_MS,
    private readonly thresholdChars = FLUSH_THRESHOLD_CHARS
  ) {}

  push(id: string, data: string): void {
    if (!data) return
    const next = (this.pending.get(id) ?? '') + data
    this.pending.set(id, next)
    if (next.length >= this.thresholdChars) {
      this.flush(id)
      return
    }
    if (this.handle === null) this.handle = this.schedule(() => this.flushAll(), this.intervalMs)
  }

  flush(id: string): void {
    const data = this.pending.get(id)
    if (data === undefined) return
    this.pending.delete(id)
    this.emit(id, data)
    if (this.pending.size === 0) this.clearTimer()
  }

  flushAll(): void {
    this.clearTimer()
    for (const id of [...this.pending.keys()]) this.flush(id)
  }

  drop(id: string): void {
    this.pending.delete(id)
    if (this.pending.size === 0) this.clearTimer()
  }

  private clearTimer(): void {
    if (this.handle === null) return
    this.cancel(this.handle)
    this.handle = null
  }
}
