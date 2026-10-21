import type { TerminalProgramStatus } from './ipc'
import type { PanePopoutOwner } from './pane-popout'

export type PaneTerminalLocale = 'zh-CN' | 'en-US'

export interface PaneTerminalSnapshot {
  terminalId: string
  title: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
  status?: TerminalProgramStatus
  buffer: string
  seq: number
}

export interface PaneTerminalLeaseView {
  locale: PaneTerminalLocale
  leaseId: string
  epoch: number
  terminalId: string
  ownerKey: string
  cwd: string
  writable: boolean
  invalidated: boolean
  invalidReason?: string
  snapshot: PaneTerminalSnapshot | null
}

export type PaneTerminalPushKind = 'data' | 'status' | 'exit' | 'invalidated'

export interface PaneTerminalLeaseEvent {
  kind: 'attached' | 'detached' | 'invalidated'
  terminalId: string
  ownerKey: string
  leaseId: string
  epoch: number
  reason?: string
}

export type PaneTerminalPushEvent =
  | { leaseId: string; epoch: number; terminalId: string; kind: 'data'; data: string; seq: number }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'status'; status?: TerminalProgramStatus }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'exit'; exitCode: number | null }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'invalidated'; reason?: string }

export interface PaneTerminalOpenRequest {
  owner: PanePopoutOwner
  terminalId: string
  locale?: PaneTerminalLocale
}

export type PaneTerminalOpenCode = 'ok' | 'rejected' | 'no-terminal' | 'not-owner'

export interface PaneTerminalOpenResult {
  ok: boolean
  code?: PaneTerminalOpenCode
  reason?: string
  leaseId?: string
  epoch?: number
}

export interface PaneTerminalBridge {
  open(request: PaneTerminalOpenRequest): Promise<PaneTerminalOpenResult>
  state(): Promise<PaneTerminalLeaseView | null>
  input(leaseId: string, data: string): Promise<boolean>
  resize(leaseId: string, cols: number, rows: number): Promise<boolean>
  detach(leaseId: string): Promise<boolean>
  closeSelf(): void
  onPush(cb: (event: PaneTerminalPushEvent) => void): () => void
  onLease(cb: (event: PaneTerminalLeaseEvent) => void): () => void
}

export const PANE_TERMINAL_CHANNELS = {
  open: 'yan:pane-terminal:open',
  state: 'yan:pane-terminal:state',
  input: 'yan:pane-terminal:input',
  resize: 'yan:pane-terminal:resize',
  detach: 'yan:pane-terminal:detach',
  closeSelf: 'yan:pane-terminal:close-self',
  push: 'yan:pane-terminal:push',
  lease: 'yan:pane-terminal:lease'
} as const

export function clampPaneTerminalDimension(value: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.round(n)))
}

export function isPaneTerminalOwner(value: unknown): value is PanePopoutOwner {
  if (!value || typeof value !== 'object') return false
  const owner = value as Partial<PanePopoutOwner>
  return typeof owner.key === 'string' && owner.key.length > 0 && typeof owner.cwd === 'string' && typeof owner.active === 'boolean'
}

export function toPaneTerminalSnapshot(snapshot: {
  id: string
  title: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
  status?: TerminalProgramStatus
  buffer: string
  seq: number
}): PaneTerminalSnapshot {
  return {
    terminalId: snapshot.id,
    title: snapshot.title,
    cwd: snapshot.cwd,
    cols: snapshot.cols,
    rows: snapshot.rows,
    alive: snapshot.alive,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    buffer: snapshot.buffer,
    seq: snapshot.seq
  }
}

export interface PaneTerminalStreamOutput {
  data: string
  status?: TerminalProgramStatus
  exitCode?: number | null
  exit?: boolean
  invalidated?: boolean
  invalidReason?: string
}

interface PaneTerminalStreamLease {
  leaseId: string
  epoch: number
  terminalId: string
}

const STREAM_PENDING_LIMIT = 256

export class PaneTerminalStream {
  private lease: PaneTerminalStreamLease
  private attached = false
  private seq = 0
  private pending: Array<{ seq: number; data: string }> = []

  constructor(lease: PaneTerminalStreamLease) {
    this.lease = lease
  }

  get currentSeq(): number {
    return this.seq
  }

  get isAttached(): boolean {
    return this.attached
  }

  reset(lease: PaneTerminalStreamLease): void {
    this.lease = lease
    this.attached = false
    this.seq = 0
    this.pending = []
  }

  attachSnapshot(snapshotSeq: number): PaneTerminalStreamOutput {
    this.attached = true
    this.seq = Number.isFinite(snapshotSeq) ? snapshotSeq : 0
    const queued = this.pending
    this.pending = []
    let data = ''
    let lastSeq = this.seq
    for (const chunk of queued) {
      if (chunk.seq <= lastSeq) continue
      lastSeq = chunk.seq
      data += chunk.data
    }
    this.seq = lastSeq
    return { data }
  }

  push(event: PaneTerminalPushEvent): PaneTerminalStreamOutput | null {
    if (!event || event.leaseId !== this.lease.leaseId) return null
    if (event.epoch !== this.lease.epoch) return null
    if (event.terminalId !== this.lease.terminalId) return null
    if (event.kind === 'invalidated') {
      return { data: '', invalidated: true, ...(event.reason ? { invalidReason: event.reason } : {}) }
    }
    if (event.kind === 'status') {
      return { data: '', status: event.status }
    }
    if (event.kind === 'exit') {
      return { data: '', exit: true, exitCode: event.exitCode }
    }
    if (!this.attached) {
      if (this.pending.length >= STREAM_PENDING_LIMIT) return null
      this.pending.push({ seq: event.seq, data: event.data })
      return null
    }
    if (event.seq <= this.seq) return null
    this.seq = event.seq
    return { data: event.data }
  }
}
