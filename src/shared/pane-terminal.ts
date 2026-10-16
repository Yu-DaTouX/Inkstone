/**
 * 终端页签「同 PTY 弹出」的跨进程契约（v3 · WP-30 终端 transfer）。
 *
 * 纯类型与纯逻辑，不 import Electron、不 import DOM：主进程 transfer 适配器、
 * 独立窗口里的轻量 viewer、主窗口客户端与单测共用这一份，可直接在 node 里编译。
 *
 * 与 `pane-popout.ts` 的分工：
 *   · `pane-popout.ts` 管 DOM-only 只读投影（files / changes / context / branch）；
 *   · 本文件管**同一条 terminalId 的第二个窗口 attach**。它只做 attach，不 start
 *     也不 kill：PTY 始终由 `main/terminal.ts` 的既有 session 持有，弹窗只是换了
 *     一个「看与写」的目标；窗口关掉后主窗口照旧接收同一条流。
 *
 * 归属与代次是唯一的路由依据：
 *   · 主窗口只在打开时提供一次可信 `PanePopoutOwner` + `terminalId`；
 *   · 主进程把它绑成 lease（`leaseId` + `epoch`），aux 窗口之后只认 leaseId，
 *     **不再接受 terminalId**，因此弹窗无法申请别的终端，也没有全局 invoke 面；
 *   · 迟到的 data / status / exit 按 `leaseId + epoch` 丢弃。
 */

import type { TerminalProgramStatus } from './ipc'
import type { PanePopoutOwner } from './pane-popout'

/** 弹出窗语言字面量；与 `pane-popout.ts` 同形，不引入运行时 i18n。 */
export type PaneTerminalLocale = 'zh-CN' | 'en-US'

/* ── 快照与视图 ─────────────────────────────────────────────────────── */

/** 已有 PTY 的只读快照（与 `main/terminal.ts#TerminalSnapshot` 同形，去掉 shell 等宿主细节）。 */
export interface PaneTerminalSnapshot {
  terminalId: string
  title: string
  cwd: string
  cols: number
  rows: number
  alive: boolean
  exitCode?: number | null
  status?: TerminalProgramStatus
  /** 重连时先灌回 xterm 的输出尾部。 */
  buffer: string
  /** `buffer` 对应的输出序号；实时块按 seq 去重。 */
  seq: number
}

/** aux viewer 从主进程拿到的 lease 视图；`state()` 的唯一返回。 */
export interface PaneTerminalLeaseView {
  locale: PaneTerminalLocale
  leaseId: string
  epoch: number
  terminalId: string
  ownerKey: string
  cwd: string
  /** PTY 仍存活且 lease 未失效时为 true；退出后只读。 */
  writable: boolean
  /** owner 已失效：停止写入、释放数据，但窗口保留让用户读到原因。 */
  invalidated: boolean
  invalidReason?: string
  snapshot: PaneTerminalSnapshot | null
}

/* ── 推送 ───────────────────────────────────────────────────────────── */

export type PaneTerminalPushKind = 'data' | 'status' | 'exit' | 'invalidated'

/**
 * 主进程 → aux viewer 的推送。每条都带 `leaseId + epoch`，
 * viewer 据此丢弃切 owner / 关窗前的迟到事件。
 */
export type PaneTerminalPushEvent =
  | { leaseId: string; epoch: number; terminalId: string; kind: 'data'; data: string; seq: number }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'status'; status?: TerminalProgramStatus }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'exit'; exitCode: number | null }
  | { leaseId: string; epoch: number; terminalId: string; kind: 'invalidated'; reason?: string }

/* ── 打开请求与结果 ─────────────────────────────────────────────────── */

/** 只有主窗口能发这个请求；`terminalId` 从此进入 lease，aux 侧不再持有它。 */
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

/* ── 渲染端桥 ───────────────────────────────────────────────────────── */

/**
 * aux viewer 与主窗口共用的一小组白名单方法。主窗口只用 `open`；
 * 弹窗只用 `state / input / resize / detach / closeSelf / onPush`。
 * 方法参数只接受 `leaseId`，**没有 terminalId 入口**。
 */
export interface PaneTerminalBridge {
  open(request: PaneTerminalOpenRequest): Promise<PaneTerminalOpenResult>
  state(): Promise<PaneTerminalLeaseView | null>
  input(leaseId: string, data: string): Promise<boolean>
  resize(leaseId: string, cols: number, rows: number): Promise<boolean>
  detach(leaseId: string): Promise<boolean>
  closeSelf(): void
  onPush(cb: (event: PaneTerminalPushEvent) => void): () => void
}

/* ── 通道名 ─────────────────────────────────────────────────────────── */

export const PANE_TERMINAL_CHANNELS = {
  open: 'yan:pane-terminal:open',
  state: 'yan:pane-terminal:state',
  input: 'yan:pane-terminal:input',
  resize: 'yan:pane-terminal:resize',
  detach: 'yan:pane-terminal:detach',
  closeSelf: 'yan:pane-terminal:close-self',
  push: 'yan:pane-terminal:push',
  /** 主进程 → 主窗口：lease 建立 / 释放 / 失效，供主面板本地 detach（不 kill）。 */
  lease: 'yan:pane-terminal:lease'
} as const

/* ── 纯判定与小工具 ─────────────────────────────────────────────────── */

/** 终端行列的合法范围与宿主 PTY 的 clamp 保持同一量级。 */
export function clampPaneTerminalDimension(value: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(2, Math.min(1000, Math.round(n)))
}

/** 归属形状校验：只认 key 字符串与 cwd 的 owner，不把任意对象当授权。 */
export function isPaneTerminalOwner(value: unknown): value is PanePopoutOwner {
  if (!value || typeof value !== 'object') return false
  const owner = value as Partial<PanePopoutOwner>
  return typeof owner.key === 'string' && owner.key.length > 0 && typeof owner.cwd === 'string' && typeof owner.active === 'boolean'
}

/** `main/terminal.ts` 的快照折成弹窗用的精简形状（只读取，不改宿主）。 */
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

/* ── 推送流过滤（纯逻辑，供 viewer 与单测共用） ─────────────────────── */

export interface PaneTerminalStreamOutput {
  data: string
  status?: TerminalProgramStatus
  /** 出现 exit 事件时带上；`undefined` 表示这条输出没有退出事实。 */
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

/** 未 attach 前最多缓存的实时块；超过按溢出丢弃，不回灌旧内容。 */
const STREAM_PENDING_LIMIT = 256

/**
 * 把一条 terminalId 的推送流收敛成 viewer 能直接写 xterm 的输出。
 *
 * 纪律：
 *   · leaseId / epoch / terminalId 任一不匹配 → 丢弃（切窗口前的迟到事件）；
 *   · attach 快照之前到达的 data 先排队，attach 时按 seq 去重合并；
 *   · attach 之后按 `seq <= 已写序号` 丢弃重复 / 乱序块。
 *
 * 纯逻辑、无 React / xterm / IPC，`scripts/test-v3-pane-terminal-transfer.mjs` 直接驱动。
 */
export class PaneTerminalStream {
  private lease: PaneTerminalStreamLease
  private attached = false
  private seq = 0
  private pending: Array<{ seq: number; data: string }> = []

  constructor(lease: PaneTerminalStreamLease) {
    this.lease = lease
  }

  /** 当前已写到的输出序号。 */
  get currentSeq(): number {
    return this.seq
  }

  get isAttached(): boolean {
    return this.attached
  }

  /** 换 lease（窗口重开 / owner 切换）：本地清空，不触碰 PTY。 */
  reset(lease: PaneTerminalStreamLease): void {
    this.lease = lease
    this.attached = false
    this.seq = 0
    this.pending = []
  }

  /**
   * 用快照建立基准并转入 attached。返回排队 data 合并后的输出；
   * 快照本身的 buffer 由调用方直接写 xterm（这里只对齐序号）。
   */
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

  /**
   * 处理一条推送。返回 null 表示丢弃（非本 lease / 乱序 / 未 attach 已排队）。
   */
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
      /* 快照还没回来：先排队，避免 attach 空隙丢实时块。 */
      if (this.pending.length >= STREAM_PENDING_LIMIT) return null
      this.pending.push({ seq: event.seq, data: event.data })
      return null
    }
    if (event.seq <= this.seq) return null
    this.seq = event.seq
    return { data: event.data }
  }
}
