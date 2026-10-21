import type {
  TerminalBlockedKind,
  TerminalProgramState,
  TerminalProgramStatus
} from '../shared/ipc'

const PROGRAM_STATUS_QUERY_BODY = '7501;?'

export const PROGRAM_STATUS_REPLY = '\x1b]7501;?1\x1b\\'

export const MAX_SEQUENCE_BYTES = 4096

export const MAX_MESSAGE_BYTES = 2048

const MAX_TITLE_CHARS = 120

const PROGRAM_STATES: readonly TerminalProgramState[] = ['working', 'blocked', 'done', 'error', 'idle', 'clear']
const BLOCKED_KINDS: readonly TerminalBlockedKind[] = ['permission', 'question', 'auth']
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const DECIMAL_PATTERN = /^\d{1,3}$/
const LEGACY_STATE_PATTERN = /^[0-4]$/

export type TerminalStatusEvent =
  | { kind: 'query' }
  | { kind: 'report'; status: TerminalProgramStatus }
  | { kind: 'progress'; state: number; value?: number }

function isProgramState(value: string): value is TerminalProgramState {
  return (PROGRAM_STATES as readonly string[]).includes(value)
}

function isBlockedKind(value: string): value is TerminalBlockedKind {
  return (BLOCKED_KINDS as readonly string[]).includes(value)
}

export function decodeStatusText(encoded: string): string | null {
  if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    return null
  }
  if (bytes.toString('base64') !== encoded) return null
  if (bytes.length > MAX_MESSAGE_BYTES) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (CONTROL_CHARS.test(text)) return null
  const codePoints = Array.from(text)
  return codePoints.length > MAX_TITLE_CHARS ? codePoints.slice(0, MAX_TITLE_CHARS).join('') : text
}

export function isTerminalStatusQuery(body: string): boolean {
  return body === PROGRAM_STATUS_QUERY_BODY
}

export function parseTerminalStatusReport(body: string): TerminalProgramStatus | null {
  if (!body.startsWith('7501;')) return null
  const payload = body.slice(5)
  if (payload.startsWith('?')) return null
  if (CONTROL_CHARS.test(payload)) return null

  const fields = new Map<string, string>()
  for (const pair of payload.split(':')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return null
    const key = pair.slice(0, eq)
    if (fields.has(key)) return null
    fields.set(key, pair.slice(eq + 1))
  }

  if (fields.has('id')) return null

  const state = fields.get('state')
  if (!state || !isProgramState(state)) return null
  const status: TerminalProgramStatus = { state }

  if (state === 'blocked') {
    const kind = fields.get('kind')
    if (kind !== undefined) {
      if (!isBlockedKind(kind)) return null
      status.kind = kind
    }
  }

  const progress = fields.get('progress')
  if (progress !== undefined) {
    if (!DECIMAL_PATTERN.test(progress)) return null
    const value = Number(progress)
    if (value > 100) return null
    status.progress = value
  }

  const app = fields.get('app')
  if (app !== undefined) {
    if (!APP_PATTERN.test(app)) return null
    status.app = app
  }

  const encodedTitle = fields.get('msg') ?? fields.get('title')
  if (encodedTitle !== undefined) {
    const title = decodeStatusText(encodedTitle)
    if (title === null) return null
    if (title) status.title = title
  }

  return status
}

export function parseLegacyProgress(body: string): { state: number; value?: number } | null {
  if (!body.startsWith('9;4;')) return null
  const parts = body.split(';')
  if (parts.length !== 3 && parts.length !== 4) return null
  if (!LEGACY_STATE_PATTERN.test(parts[2])) return null
  const state = Number(parts[2])
  if (parts.length === 3) return { state }
  if (!DECIMAL_PATTERN.test(parts[3])) return null
  const value = Number(parts[3])
  if (value > 100) return null
  return { state, value }
}

export function legacyProgressToStatus(progress: { state: number; value?: number }): TerminalProgramStatus | null {
  switch (progress.state) {
    case 0:
      return { state: 'clear' }
    case 1:
      return progress.value === undefined ? { state: 'working' } : { state: 'working', progress: progress.value }
    case 2:
      return { state: 'error' }
    case 3:
      return { state: 'working' }
    case 4:
      return { state: 'idle' }
    default:
      return null
  }
}

export function statusesEqual(a?: TerminalProgramStatus, b?: TerminalProgramStatus): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.state === b.state && a.kind === b.kind && a.progress === b.progress && a.title === b.title && a.app === b.app
}

function findOscEnd(s: string, from: number): { contentEnd: number; end: number; aborted: boolean } | null {
  for (let i = from; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code === 0x07) return { contentEnd: i, end: i + 1, aborted: false }
    if (code === 0x1b) {
      if (s.charCodeAt(i + 1) === 0x5c) return { contentEnd: i, end: i + 2, aborted: false }
      if (i + 1 >= s.length) return null
      return { contentEnd: i, end: i, aborted: true }
    }
  }
  return null
}

export class TerminalStatusScanner {
  private pending = ''
  private discarding = false
  private saw7501 = false

  get programStatusSeen(): boolean {
    return this.saw7501
  }

  write(chunk: string): TerminalStatusEvent[] {
    if (!chunk) return []
    this.pending += chunk
    const events: TerminalStatusEvent[] = []

    for (;;) {
      if (this.discarding) {
        const end = this.findDiscardEnd()
        if (end < 0) {
          this.pending = this.pending.endsWith('\x1b') ? '\x1b' : ''
          break
        }
        this.pending = this.pending.slice(end)
        this.discarding = false
        continue
      }

      const start = this.pending.indexOf('\x1b]')
      if (start < 0) {
        this.pending = this.pending.endsWith('\x1b') ? '\x1b' : ''
        break
      }
      const rest = this.pending.slice(start)
      const end = findOscEnd(rest, 2)
      if (!end) {
        if (Buffer.byteLength(rest, 'utf8') > MAX_SEQUENCE_BYTES) {
          this.discarding = true
          this.pending = rest.endsWith('\x1b') ? '\x1b' : ''
        } else {
          this.pending = rest
        }
        break
      }

      if (Buffer.byteLength(rest.slice(0, end.end), 'utf8') > MAX_SEQUENCE_BYTES) {
        this.pending = rest.slice(end.end)
        continue
      }

      if (!end.aborted) {
        const event = this.consume(rest.slice(2, end.contentEnd))
        if (event) events.push(event)
      }
      this.pending = rest.slice(end.end)
    }

    return events
  }

  private consume(body: string): TerminalStatusEvent | null {
    if (body.startsWith('7501;')) {
      this.saw7501 = true
      if (isTerminalStatusQuery(body)) return { kind: 'query' }
      const status = parseTerminalStatusReport(body)
      return status ? { kind: 'report', status } : null
    }
    if (body.startsWith('9;4;')) {
      if (this.saw7501) return null
      const progress = parseLegacyProgress(body)
      return progress ? { kind: 'progress', ...progress } : null
    }
    return null
  }

  private findDiscardEnd(): number {
    for (let i = 0; i < this.pending.length; i += 1) {
      const code = this.pending.charCodeAt(i)
      if (code === 0x07) return i + 1
      if (code === 0x1b && this.pending.charCodeAt(i + 1) === 0x5c) return i + 2
    }
    return -1
  }
}

export class TerminalProgramStatusTracker {
  private readonly scanner = new TerminalStatusScanner()
  private current: TerminalProgramStatus | undefined

  get status(): TerminalProgramStatus | undefined {
    return this.current
  }

  get programStatusSeen(): boolean {
    return this.scanner.programStatusSeen
  }

  consume(chunk: string): { queries: number; changed: boolean } {
    let queries = 0
    let changed = false
    for (const event of this.scanner.write(chunk)) {
      if (event.kind === 'query') {
        queries += 1
        continue
      }
      const next = event.kind === 'report' ? event.status : legacyProgressToStatus(event)
      if (!next) continue
      if (next.state === 'clear') {
        if (this.current) {
          this.current = undefined
          changed = true
        }
        continue
      }
      if (!statusesEqual(this.current, next)) {
        this.current = next
        changed = true
      }
    }
    return { queries, changed }
  }

  exit(): boolean {
    if (this.current?.state !== 'working' && this.current?.state !== 'blocked') return false
    this.current = undefined
    return true
  }
}
