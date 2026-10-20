import type {
  TerminalAvailability,
  TerminalProgramStatus,
  TerminalSnapshot,
  TerminalStartRequest
} from '../../../../shared/ipc'
import type { WorkspaceOwner } from '../workbench/types'

export interface TerminalBridge {
  available(): Promise<TerminalAvailability>
  list(): Promise<TerminalSnapshot[]>
  start(request?: TerminalStartRequest): Promise<TerminalSnapshot | null>
  write(id: string, data: string): Promise<boolean>
  resize(id: string, cols: number, rows: number): Promise<boolean>
  kill(id: string): Promise<boolean>
  attach(id: string): Promise<TerminalSnapshot | null>
  clear(id: string): Promise<boolean>
}

export type TerminalAdopt = 'latest' | { id: string } | 'none'

export type TerminalOwner = WorkspaceOwner

export type TerminalPushPayload =
  | { id: string; kind: 'data'; data?: string; seq?: number }
  | { id: string; kind: 'exit'; exitCode?: number | null }
  | { id: string; kind: 'status'; status?: TerminalProgramStatus }

export interface TerminalPushMessage {
  readonly ch: string
  readonly payload: TerminalPushPayload
}

export type TerminalPushSubscriber = (cb: (msg: TerminalPushMessage) => void) => () => void

export type TerminalPhase =
  | 'idle'
  | 'inactive'
  | 'unavailable'
  | 'starting'
  | 'connecting'
  | 'ready'
  | 'exited'
  | 'error'

export interface TerminalViewState {
  phase: TerminalPhase
  terminalId: string | null
  title: string
  cwd: string
  exitCode: number | null
  error: string
  notice: string
  status: TerminalProgramStatus | undefined
}

export interface TerminalSink {
  reset(): void
  write(data: string): void
}

export interface TerminalRuntimeText {
  startFailed: string
  attachFailed: string
  bufferOverflow: string
}

export const DEFAULT_RUNTIME_TEXT: TerminalRuntimeText = {
  startFailed: '终端启动失败，可重试',
  attachFailed: '终端连接失败，可重试',
  bufferOverflow: '终端连接缓冲超限，请重新连接'
}

export function selectOwnedTerminals(
  list: readonly TerminalSnapshot[],
  ownerKey: string,
  ownerOf: (resourceId: string) => string | undefined
): TerminalSnapshot[] {
  return list.filter((item) => (item.owner ?? ownerOf('terminal:' + item.id)) === ownerKey)
}

export function pickOwnedTerminal(owned: readonly TerminalSnapshot[]): TerminalSnapshot | null {
  if (owned.length === 0) return null
  for (let i = owned.length - 1; i >= 0; i -= 1) {
    if (owned[i].alive) return owned[i]
  }
  return owned[owned.length - 1]
}

export interface TerminalSessionDeps {
  bridge: TerminalBridge
  onPush: TerminalPushSubscriber
  ownerOf: (resourceId: string) => string | undefined
  claim: (resourceId: string, ownerKey: string) => void
  release: (resourceId: string) => void
  text?: TerminalRuntimeText
  adopt?: TerminalAdopt
}

const INITIAL_STATE: TerminalViewState = {
  phase: 'idle',
  terminalId: null,
  title: '',
  cwd: '',
  exitCode: null,
  error: '',
  notice: '',
  status: undefined
}

const MAX_PENDING_CHUNKS = 512
const MAX_PENDING_BYTES = 2 * 1024 * 1024

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(500, Math.max(2, Math.round(value)))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TerminalSession {
  private readonly deps: TerminalSessionDeps
  private readonly text: TerminalRuntimeText
  private sink: TerminalSink | null = null
  private state: TerminalViewState = INITIAL_STATE
  private readonly listeners = new Set<(state: TerminalViewState) => void>()
  private owner: TerminalOwner | null = null
  private visible = true
  private started = false
  private cols = 80
  private rows = 24
  private epoch = 0
  private terminalId: string | null = null
  private seq = 0
  private attached = false
  private pending: { seq: number; data: string }[] = []
  private pendingBytes = 0
  private disposed = false
  private readonly unsubPush: () => void

  constructor(deps: TerminalSessionDeps) {
    this.deps = deps
    this.text = deps.text ?? DEFAULT_RUNTIME_TEXT
    this.unsubPush = deps.onPush((msg) => this.handlePush(msg))
  }

  getState(): TerminalViewState {
    return this.state
  }

  subscribe(listener: (state: TerminalViewState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setSink(sink: TerminalSink | null): void {
    this.sink = sink
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) return
    const owner = this.owner
    if (!owner?.active || this.disposed) return
    if (!this.started) {
      void this.ensure()
      return
    }
    if (this.terminalId) void this.deps.bridge.resize(this.terminalId, this.cols, this.rows)
  }

  resize(cols: number, rows: number): void {
    this.cols = clampDimension(cols, this.cols || 80)
    this.rows = clampDimension(rows, this.rows || 24)
    if (!this.owner?.active || !this.visible || !this.terminalId) return
    void this.deps.bridge.resize(this.terminalId, this.cols, this.rows)
  }

  input(data: string): void {
    if (!data) return
    if (!this.owner?.active || !this.visible || !this.terminalId) return
    void this.deps.bridge.write(this.terminalId, data)
  }

  setOwner(next: TerminalOwner, visible?: boolean): void {
    const visibilityChanged = visible !== undefined && visible !== this.visible
    if (visible !== undefined) this.visible = visible
    const previous = this.owner
    const identityChanged =
      !previous ||
      previous.key !== next.key ||
      (previous.generation ?? 0) !== (next.generation ?? 0)
    const wasActive = previous?.active ?? false
    this.owner = next

    if (!next.active) {
      if (identityChanged || wasActive) {
        this.epoch += 1
        this.detachLocal()
      }
      this.started = false
      this.publishCleared({ phase: 'inactive', notice: '', error: '' })
      return
    }

    if (identityChanged) {
      this.epoch += 1
      this.started = false
      this.detachLocal()
    }
    if (identityChanged || !this.started || !wasActive) {
      void this.ensure()
    } else if (visibilityChanged && this.visible && this.terminalId) {
      void this.deps.bridge.resize(this.terminalId, this.cols, this.rows)
    }
  }

  async create(): Promise<void> {
    if (!this.owner?.active || !this.visible) return
    this.epoch += 1
    this.started = true
    this.detachLocal()
    this.publishCleared({ phase: 'starting', notice: '' })
    await this.createTerminal(this.epoch)
  }

  async kill(): Promise<void> {
    if (!this.owner?.active) return
    const id = this.terminalId
    if (!id) return
    this.epoch += 1
    this.detachLocal()
    this.publishCleared({ phase: 'idle', notice: '' })
    try {
      await this.deps.bridge.kill(id)
    } finally {
      this.deps.release('terminal:' + id)
    }
  }

  async retry(): Promise<void> {
    if (!this.owner?.active || !this.visible) return
    this.epoch += 1
    this.detachLocal()
    this.publishCleared({ phase: 'connecting', notice: '', error: '' })
    await this.ensure()
  }

  async clear(): Promise<void> {
    const id = this.terminalId
    if (!id) return
    try {
      await this.deps.bridge.clear(id)
    } catch {
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    this.detachLocal()
    this.unsubPush()
    this.listeners.clear()
    this.sink = null
  }

  private detachLocal(): void {
    this.attached = false
    this.terminalId = null
    this.seq = 0
    this.pending = []
    this.pendingBytes = 0
    this.sink?.reset()
  }

  private async ensure(): Promise<void> {
    const owner = this.owner
    if (!owner?.active || this.disposed || !this.visible) return
    const my = this.epoch
    this.started = true
    this.publishCleared({ phase: 'connecting', notice: '', error: '' })

    let availability: TerminalAvailability
    try {
      availability = await this.deps.bridge.available()
    } catch (error) {
      availability = { available: false, error: messageOf(error) }
    }
    if (this.stale(my)) return
    if (!this.visible || !this.owner?.active) {
      this.started = false
      return
    }
    if (!availability.available) {
      this.publishCleared({ phase: 'unavailable', error: availability.error ?? '' })
      return
    }

    const adopt = this.deps.adopt ?? 'latest'
    if (adopt === 'none') {
      await this.createTerminal(my)
      return
    }

    let list: TerminalSnapshot[]
    try {
      list = await this.deps.bridge.list()
    } catch {
      list = []
    }
    if (this.stale(my)) return
    if (!this.visible || !this.owner?.active) {
      this.started = false
      return
    }
    const owned = selectOwnedTerminals(list, owner.key, this.deps.ownerOf)
    const chosen = typeof adopt === 'object' ? owned.find((item) => item.id === adopt.id) ?? null : pickOwnedTerminal(owned)
    if (chosen) {
      await this.connect(chosen.id, my)
      return
    }
    await this.createTerminal(my)
  }

  private async createTerminal(my: number): Promise<void> {
    const owner = this.owner
    if (!owner?.active || this.disposed || !this.visible) return
    this.publishCleared({ phase: 'starting', notice: '' })
    let snapshot: TerminalSnapshot | null
    try {
      snapshot = await this.deps.bridge.start({
        cwd: owner.cwd,
        fallbackCwd: owner.cwd,
        cols: this.cols,
        rows: this.rows,
        owner: owner.key
      })
    } catch {
      snapshot = null
    }
    if (this.stale(my)) {
      if (snapshot) this.discardLate(snapshot.id, owner.key)
      return
    }
    if (!this.visible || !this.owner?.active) {
      if (snapshot) this.discardLate(snapshot.id, owner.key)
      this.started = false
      return
    }
    if (!snapshot) {
      let reason = ''
      try {
        const again = await this.deps.bridge.available()
        reason = again.available ? '' : again.error ?? ''
      } catch {
        reason = ''
      }
      if (this.stale(my)) return
      this.publishCleared({ phase: 'error', notice: reason || this.text.startFailed, error: '' })
      return
    }
    this.deps.claim('terminal:' + snapshot.id, owner.key)
    await this.connect(snapshot.id, my)
  }

  private async connect(id: string, my: number): Promise<void> {
    this.attached = false
    this.pending = []
    this.pendingBytes = 0
    this.terminalId = id
    this.seq = 0
    this.sink?.reset()
    this.publishCleared({ phase: 'connecting', notice: '' })

    let snapshot: TerminalSnapshot | null
    try {
      snapshot = await this.deps.bridge.attach(id)
    } catch {
      snapshot = null
    }
    if (this.stale(my)) return

    if (!snapshot) {
      this.attached = true
      this.publishCleared({ phase: 'error', notice: this.text.attachFailed, error: '' })
      this.flushPending()
      return
    }
    this.applyInfo(snapshot)
    if (snapshot.buffer) this.sink?.write(snapshot.buffer)
    this.seq = snapshot.seq
    this.attached = true
    this.flushPending()
    if (!snapshot.alive || this.state.phase === 'exited') {
      this.publish({ phase: 'exited', exitCode: snapshot.exitCode ?? this.state.exitCode })
      return
    }
    this.publish({ phase: 'ready' })
    if (this.visible) void this.deps.bridge.resize(id, this.cols, this.rows)
  }

  private discardLate(id: string, requestedOwnerKey: string): void {
    const holder = this.deps.ownerOf('terminal:' + id)
    if (holder !== undefined && holder !== requestedOwnerKey) return
    this.deps.release('terminal:' + id)
    void this.deps.bridge.kill(id)
  }

  private publishCleared(patch: Partial<TerminalViewState>): void {
    this.publish({ terminalId: null, title: '', cwd: '', exitCode: null, status: undefined, ...patch })
  }

  private handlePush(msg: TerminalPushMessage): void {
    if (msg.ch !== 'terminal') return
    const payload = msg.payload
    if (!payload || payload.id !== this.terminalId) return
    if (payload.kind === 'data') {
      const seq = payload.seq ?? 0
      const data = payload.data ?? ''
      if (!this.attached) {
        this.queuePending(seq, data)
        return
      }
      if (seq <= this.seq) return
      this.seq = seq
      this.sink?.write(data)
      return
    }
    if (payload.kind === 'exit') {
      this.publish({ phase: 'exited', exitCode: payload.exitCode ?? null })
      return
    }
    if (payload.kind === 'status') {
      this.publish({ status: payload.status })
    }
  }

  private queuePending(seq: number, data: string): void {
    this.pendingBytes += data.length
    if (this.pending.length >= MAX_PENDING_CHUNKS || this.pendingBytes > MAX_PENDING_BYTES) {
      this.pending = []
      this.pendingBytes = 0
      this.publish({ notice: this.text.bufferOverflow })
      return
    }
    this.pending.push({ seq, data })
  }

  private flushPending(): void {
    const queued = this.pending
    this.pending = []
    this.pendingBytes = 0
    for (const chunk of queued) {
      if (chunk.seq <= this.seq) continue
      this.seq = chunk.seq
      this.sink?.write(chunk.data)
    }
  }

  private stale(my: number): boolean {
    return this.disposed || my !== this.epoch
  }

  private applyInfo(snapshot: TerminalSnapshot): void {
    this.publish({
      terminalId: snapshot.id,
      title: snapshot.title,
      cwd: snapshot.cwd,
      exitCode: snapshot.exitCode ?? null,
      status: snapshot.status
    })
  }

  private publish(patch: Partial<TerminalViewState>): void {
    let changed = false
    for (const key of Object.keys(patch) as (keyof TerminalViewState)[]) {
      if (this.state[key] !== patch[key]) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }
}
