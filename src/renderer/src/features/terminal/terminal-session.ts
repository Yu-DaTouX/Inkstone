/**
 * v3 终端会话控制器（P3 / R2）。
 *
 * 这一层是**纯逻辑**：不引用 React、xterm 或任何 DOM，只依赖宿主终端的 IPC 形状
 * （`window.yan.terminal` 的子集与 `terminal` 推送通道）。`TerminalPane.tsx` 把
 * xterm 实例接到 `TerminalSink` 上，`scripts/test-v3-terminal.mjs` 用 mock bridge
 * 直接驱动这个类。
 *
 * 四条必须守住的东西（合同 R2）：
 *   ① `owner.active === false` 时不得新建 / 附加 / 写 PTY —— 只看得到「先激活」的提示。
 *   ② `visible === false`（页签隐藏）时同样不得新建 PTY：终端保活只表示后台进程不杀，
 *      显示时才 ensure；否则切会话会在隐藏态反复跑起默认 shell。
 *   ③ 切 owner 时只做本地 detach，**绝不 kill**；后台工具 PTY（agent-hub 受管、
 *      由宿主直接开出的）不能因为面板卸载被误杀。
 *   ④ owner 切换后，迟到的 `data` / `exit` 不能串进新终端：靠 `epoch` + 精确的
 *      `terminalId` 双保险，异步 attach/start 回包也要核对 epoch 后才落地；迟到的
 *      start 若真建出了新 PTY，只清理由本次新建且无人正式占有的 id，绝不动别人的资源。
 *
 * 终端目录只认**正式归属**：`resource-owners` 里 `terminal:<id>` 记到本 owner 的
 * 才显示，未登记的（含工具 PTY）不主动认领 —— 宁可少显示，也不抢别人的进程。
 * cwd 一律取 `owner.cwd`（会话/工作目录），调用方无法从别处塞一个任意根目录。
 */
import type {
  TerminalAvailability,
  TerminalProgramStatus,
  TerminalSnapshot,
  TerminalStartRequest
} from '../../../../shared/ipc'
import type { WorkspaceOwner } from '../workbench/types'

/** 宿主 PTY 的薄接口（`window.yan.terminal` 的子集，便于测试注入 mock）。 */
export interface TerminalBridge {
  available(): Promise<TerminalAvailability>
  list(): Promise<TerminalSnapshot[]>
  start(request?: TerminalStartRequest): Promise<TerminalSnapshot | null>
  write(id: string, data: string): Promise<boolean>
  resize(id: string, cols: number, rows: number): Promise<boolean>
  kill(id: string): Promise<boolean>
  attach(id: string): Promise<TerminalSnapshot | null>
}

/**
 * 终端资源的业务归属（R0 `features/workbench/types.ts` 的唯一真源）。
 *
 * `key` 是工作区/会话键，不是绕过授权的凭证：它只决定「这个终端显示在哪条会话旁边」，
 * 真正的 cwd 授权仍由 `owner.cwd` 与宿主 PTY 服务决定。
 */
export type TerminalOwner = WorkspaceOwner

/** `terminal` 推送通道的一条消息。 */
export type TerminalPushPayload =
  | { id: string; kind: 'data'; data?: string; seq?: number }
  | { id: string; kind: 'exit'; exitCode?: number | null }
  | { id: string; kind: 'status'; status?: TerminalProgramStatus }

export interface TerminalPushMessage {
  readonly ch: string
  readonly payload: TerminalPushPayload
}

/** 订阅推送，返回退订函数。`TerminalPane` 传 `window.yan.onPush` 的适配。 */
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
  /** 能力级错误：原生依赖没装上，`available=false`。 */
  error: string
  /** 可重试的操作错误：壳 / cwd 启动失败、attach 失败，附提示与重试入口。 */
  notice: string
  status: TerminalProgramStatus | undefined
}

/** xterm 侧的写入出口。 */
export interface TerminalSink {
  /** owner / 终端变了：清屏，准备写入新的缓冲。 */
  reset(): void
  /** 追加输出（缓冲或实时块）。 */
  write(data: string): void
}

/** 窄文案（不新增 i18n 键；面板里的固定短语用这里）。 */
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

/** 已登记的、属于本 owner 的终端（保留宿主返回的顺序）。纯函数，供测试直接调用。 */
export function selectOwnedTerminals(
  list: readonly TerminalSnapshot[],
  ownerKey: string,
  ownerOf: (resourceId: string) => string | undefined
): TerminalSnapshot[] {
  return list.filter((item) => ownerOf('terminal:' + item.id) === ownerKey)
}

/** 从归属终端里挑一个来显示：优先最后一个仍存活的，否则最后一个。 */
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
  /** `resource-owners` 的 `resourceOwner`。 */
  ownerOf: (resourceId: string) => string | undefined
  /** `resource-owners` 的 `claimResource`。 */
  claim: (resourceId: string, ownerKey: string) => void
  /** `resource-owners` 的 `releaseResource`。 */
  release: (resourceId: string) => void
  text?: TerminalRuntimeText
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

/** attach 完成前最多缓存的实时块上限，超过按溢出处理（与 v2 守卫同一量级）。 */
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
  /* 默认可见，保持「构造后 setOwner 即建立」的旧契约；隐藏由 setOwner(_, false) / setVisible 显式给出。 */
  private visible = true
  /** 当前 owner 身份下是否已经尝试过建立终端（区分「从未建立」与「用户主动结束」）。 */
  private started = false
  private cols = 80
  private rows = 24
  /** owner 切换 / 显式重建时递增；所有异步回包都要核对。 */
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

  /**
   * 切换可见性。隐藏只停尺寸同步、**不 kill**；从隐藏回到显示时，已建终端补一次
   * 尺寸同步，还没有终端的才在此时 ensure（隐藏态绝不新建）。
   */
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

  /** 面板尺寸变了：记录并同步给宿主（可见且激活时才真的发）。 */
  resize(cols: number, rows: number): void {
    this.cols = clampDimension(cols, this.cols || 80)
    this.rows = clampDimension(rows, this.rows || 24)
    if (!this.owner?.active || !this.visible || !this.terminalId) return
    void this.deps.bridge.resize(this.terminalId, this.cols, this.rows)
  }

  /** 用户输入（含控制字符）→ PTY；未激活 / 隐藏 / 无终端时丢弃。 */
  input(data: string): void {
    if (!data) return
    if (!this.owner?.active || !this.visible || !this.terminalId) return
    void this.deps.bridge.write(this.terminalId, data)
  }

  /**
   * 切换 owner / 可见性。key 或 generation 变化才重建终端；同一 owner 内
   * 只是 active/visible 变化，不重建。
   *
   * `visible` 可选：生产接线一次传两者，避免 setOwner / setVisible 分开时在
   * 隐藏帧先用默认可见性触发一次新建。省略时沿用当前可见性。
   */
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
      /*
       * 未激活：不做任何 PTY 操作（含接收）——只本地 detach，后台 PTY 留着。
       * identity 变化或从激活转未激活都要放下订阅，避免把这条会话的数据
       * 写给正在看的面板；view 字段一并清空，旧 owner 的终端不残留到新 owner。
       */
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
    /* 首次激活、或从「未激活」回到激活：attach/重建；同 identity 的普通重渲染不动。 */
    if (identityChanged || !this.started || !wasActive) {
      void this.ensure()
    } else if (visibilityChanged && this.visible && this.terminalId) {
      /* 只是从隐藏回到显示：已建终端保活，补一次尺寸同步，不重挂。 */
      void this.deps.bridge.resize(this.terminalId, this.cols, this.rows)
    }
  }

  /** 用户显式「新建」：开一个新终端（旧的不杀，仍挂在同一 owner 下）。 */
  async create(): Promise<void> {
    if (!this.owner?.active || !this.visible) return
    this.epoch += 1
    this.started = true
    this.detachLocal()
    this.publishCleared({ phase: 'starting', notice: '' })
    await this.createTerminal(this.epoch)
  }

  /** 用户显式「结束」：只有明确的结束动作才 kill 当前终端。 */
  async kill(): Promise<void> {
    if (!this.owner?.active) return
    const id = this.terminalId
    if (!id) return
    this.epoch += 1
    this.detachLocal()
    /* 结束是最终态：view 里的 terminalId / title / cwd / status 一并清掉，空态给显式新建。 */
    this.publishCleared({ phase: 'idle', notice: '' })
    try {
      await this.deps.bridge.kill(id)
    } finally {
      this.deps.release('terminal:' + id)
    }
  }

  /** 能力不可用 / 启动失败后的重试入口。 */
  async retry(): Promise<void> {
    if (!this.owner?.active || !this.visible) return
    this.epoch += 1
    this.detachLocal()
    this.publishCleared({ phase: 'connecting', notice: '', error: '' })
    await this.ensure()
  }

  /**
   * 卸载：只退订 + 清本地状态，**不 kill**。
   * 后台终端（包括别的会话、工具 PTY）保持原样，下次 attach 还能接回。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    this.detachLocal()
    this.unsubPush()
    this.listeners.clear()
    this.sink = null
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

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
      /* 等待期间被隐藏 / 取消激活：可见时才可能新建，先放下，显示时重新 ensure。 */
      this.started = false
      return
    }
    if (!availability.available) {
      this.publishCleared({ phase: 'unavailable', error: availability.error ?? '' })
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
    const chosen = pickOwnedTerminal(selectOwnedTerminals(list, owner.key, this.deps.ownerOf))
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
      /* cwd 只从 owner 取；调用方没有别的入口塞任意目录。 */
      snapshot = await this.deps.bridge.start({
        cwd: owner.cwd,
        fallbackCwd: owner.cwd,
        cols: this.cols,
        rows: this.rows
      })
    } catch {
      snapshot = null
    }
    if (this.stale(my)) {
      /* owner 切换 / 显式新建 / 卸载：本次 start 新建的 PTY 若无人正式占有，安全清掉。 */
      if (snapshot) this.discardLate(snapshot.id, owner.key)
      return
    }
    if (!this.visible || !this.owner?.active) {
      /* 隐藏或转未激活：visible=false 绝不新留终端，清掉刚建出的这条，显示时再重建。 */
      if (snapshot) this.discardLate(snapshot.id, owner.key)
      this.started = false
      return
    }
    if (!snapshot) {
      /*
       * 壳或 cwd 启动失败 ≠ 原生依赖不可用：只报可重试的错误，
       * 不把模块标成永久不可用。再问一次 available() 拿原因。
       */
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
    /* 先登记归属，再把它作为当前终端 attach。 */
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
    /* exit 推送可能比 attach 回包先到：别把它又覆盖回 ready。 */
    if (!snapshot.alive || this.state.phase === 'exited') {
      this.publish({ phase: 'exited', exitCode: snapshot.exitCode ?? this.state.exitCode })
      return
    }
    this.publish({ phase: 'ready' })
    if (this.visible) void this.deps.bridge.resize(id, this.cols, this.rows)
  }

  /** 迟到 start 的清理：只动本次新建且无人 / 仅本 owner 名下的 id。 */
  private discardLate(id: string, requestedOwnerKey: string): void {
    const holder = this.deps.ownerOf('terminal:' + id)
    if (holder !== undefined && holder !== requestedOwnerKey) return
    this.deps.release('terminal:' + id)
    void this.deps.bridge.kill(id)
  }

  /** 清掉绑定「当前终端」的 view 字段，旧 owner 的 id/title/cwd 不残留到新画面。 */
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
