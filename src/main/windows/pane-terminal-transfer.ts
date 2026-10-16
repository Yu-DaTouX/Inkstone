/**
 * 终端页签的同 PTY 弹出适配器（v3 · WP-30 终端 transfer）。
 *
 * 作用：把主窗口已打开的一条 PTY 交给一个独立窗口「attach」，**不 start、不 kill、
 * 不新建 PTY**。PTY 自始至终属于 `main/terminal.ts` 的既有 session；这里只改
 * 「谁在看 / 谁在写」的目标，窗口关掉后主窗口照旧收到同一条流。
 *
 * 纪律：
 *   · 打开只接受主窗口来源（IPC 层校验），并把 `owner + terminalId` 绑成 lease；
 *   · lease 记 `leaseId + epoch`，aux 窗口之后只认 leaseId，**没有 terminalId 入口**，
 *     因此弹窗无法申请别的终端，也没有全局 invoke 面；
 *   · 输入 / resize / 输出都按 lease 与 aux webContents 身份路由；输出经
 *     `forward()` 从主进程 sink 转投，未接 relay 时不会假称可交互；
 *   · 失效 / 归还 / 关闭走同一条 `releaseLease`，恰好一次，不丢 PTY。
 *
 * 窗口工厂默认复用 W2 的 `createPanePopoutWindow`（同一 aux/pane.html 与 preload），
 * 单测注入替身，不启动 Electron、不碰 node-pty、不执行任何 shell 命令。
 */
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import {
  PANE_TERMINAL_CHANNELS,
  clampPaneTerminalDimension,
  isPaneTerminalOwner,
  type PaneTerminalLeaseView,
  type PaneTerminalOpenRequest,
  type PaneTerminalOpenResult,
  type PaneTerminalPushEvent,
  type PaneTerminalSnapshot
} from '../../shared/pane-terminal'
import {
  PANE_NATIVE_TRANSFER_FOLLOW_UP,
  type PaneNativeTransferRequest,
  type PanePopoutOwner,
  type PaneTransferResult
} from '../../shared/pane-popout'
import type { TerminalProgramStatus } from '../../shared/ipc'
import type { PanePopoutHost, PanePopoutWindow, PanePopoutWindowDeps } from './pane-popout-types'
import { createPanePopoutWindow } from './pane-popout-controller'

/** 主进程 sink 的事件形状（与 `main/terminal.ts#TerminalSink` 同形，避免反向依赖）。 */
export type PaneTerminalEvent =
  | { kind: 'data'; id: string; data: string; seq: number }
  | { kind: 'status'; id: string; status?: TerminalProgramStatus }
  | { kind: 'exit'; id: string; exitCode: number | null }

/** lease 生命周期通知：主窗口据此让主面板本地 detach（不 kill）。 */
export interface PaneTerminalLeaseChange {
  kind: 'attached' | 'detached' | 'invalidated'
  terminalId: string
  ownerKey: string
  leaseId: string
  epoch: number
  reason?: string
}

/**
 * 宿主事实。`read / write / resize` 直接指向既有 terminal 服务；
 * **刻意不提供 start / kill**，适配器结构上就无法新建或结束 PTY。
 */
export interface PaneTerminalTransferHost extends PanePopoutHost {
  /** 只读现有 session；不存在返回 null。 */
  read(terminalId: string): PaneTerminalSnapshot | null
  /** 写已有 PTY。 */
  write(terminalId: string, data: string): boolean
  /** 缩放已有 PTY。 */
  resize(terminalId: string, cols: number, rows: number): boolean
  /** 归属校验：主窗口确认的当前 owner + terminal 才允许 attach。 */
  authorize(owner: PanePopoutOwner, terminalId: string): boolean
}

export type PaneTerminalWindowFactory = (deps: PanePopoutWindowDeps) => PanePopoutWindow

export interface PaneTerminalTransferOptions {
  /** 测试注入替身；缺省用真实 `createPanePopoutWindow`。 */
  createWindow?: PaneTerminalWindowFactory
  /** lease 建立 / 释放 / 失效时通知主窗口。 */
  onLeaseChange?: (event: PaneTerminalLeaseChange) => void
}

export interface PaneTerminalTransfer {
  readonly kind: 'terminal-attach'
  /** W2 `PaneNativeTransferAdapter` 兼容：能否把这条 terminalId 改挂。 */
  canTransfer(request: PaneNativeTransferRequest): boolean
  /** W2 兼容入口；失败时给出最小后续清单。 */
  transfer(request: PaneNativeTransferRequest): PaneTransferResult
  /** 主窗口发起：校验 owner + 现有 PTY，建立 lease 并开窗（不 start/kill）。 */
  openFromMainWindow(request: PaneTerminalOpenRequest): PaneTerminalOpenResult
  /** aux viewer 读取自己的 lease（同时把该 lease 记为 attached，开始转发输出）。 */
  stateFor(contents: WebContents): PaneTerminalLeaseView | null
  /** 弹窗输入：只按 leaseId 解析，terminalId 不来自调用方。 */
  input(contents: WebContents, leaseId: string, data: string): boolean
  /** 弹窗缩放：只按 leaseId 解析并 clamp。 */
  resize(contents: WebContents, leaseId: string, cols: number, rows: number): boolean
  /** 弹窗主动归还（关窗交给宿主时应调用 closeByContents）。 */
  detach(contents: WebContents, leaseId: string): boolean
  /** 关掉某个弹窗并释放 lease；不 kill PTY。 */
  closeByContents(contents: WebContents): boolean
  /** owner 失效：停止写入并释放数据，窗口保留让用户读到原因。 */
  invalidate(ownerKey: string, reason?: string): void
  invalidateAll(reason?: string): void
  /** 主进程 sink relay：把事件转投给持有该 terminalId 的弹窗。返回是否已转发。 */
  forward(event: PaneTerminalEvent): boolean
  /** 该 webContents 是否属于某个弹窗 lease。 */
  owns(contents: WebContents): boolean
  dispose(): void
}

interface PaneTerminalLease {
  leaseId: string
  epoch: number
  termId: string
  owner: PanePopoutOwner
  window: PanePopoutWindow
  attached: boolean
  invalidated: boolean
  invalidReason?: string
  released: boolean
}

export function createPaneTerminalTransfer(
  host: PaneTerminalTransferHost,
  options: PaneTerminalTransferOptions = {}
): PaneTerminalTransfer {
  const createWindow = options.createWindow ?? createPanePopoutWindow
  const leases = new Map<string, PaneTerminalLease>()
  let epochCounter = 0

  const findByContents = (contents: WebContents): PaneTerminalLease | null => {
    for (const lease of leases.values()) {
      if (lease.window.webContents() === contents) return lease
    }
    return null
  }

  const notify = (kind: PaneTerminalLeaseChange['kind'], lease: PaneTerminalLease, reason?: string): void => {
    options.onLeaseChange?.({
      kind,
      terminalId: lease.termId,
      ownerKey: lease.owner.key,
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      ...(reason ? { reason } : {})
    })
  }

  /** 释放 lease 恰好一次：登记项删除 + 通知主窗口，不触碰 PTY。 */
  const releaseLease = (lease: PaneTerminalLease): void => {
    if (lease.released) return
    lease.released = true
    if (leases.get(lease.termId) === lease) leases.delete(lease.termId)
    notify('detached', lease)
  }

  const pushInvalidated = (lease: PaneTerminalLease, reason?: string): void => {
    lease.window.send(PANE_TERMINAL_CHANNELS.push, {
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      terminalId: lease.termId,
      kind: 'invalidated',
      ...(reason ? { reason } : {})
    } satisfies PaneTerminalPushEvent)
  }

  const openLease = (owner: PanePopoutOwner, terminalId: string): PaneTerminalLease => {
    let lease: PaneTerminalLease | null = null
    const win = createWindow({
      preloadPath: host.preloadPath(),
      load: (target) => host.loadEntry(target, 'pane'),
      anchorBounds: () => host.anchorBounds(),
      workArea: (bounds) => host.workArea(bounds),
      zoomFactor: () => host.zoomFactor(),
      onClosed: () => {
        if (lease) releaseLease(lease)
      }
    })
    lease = {
      leaseId: randomUUID(),
      epoch: ++epochCounter,
      termId: terminalId,
      owner,
      window: win,
      attached: false,
      invalidated: false,
      released: false
    }
    leases.set(terminalId, lease)
    return lease
  }

  const buildState = (lease: PaneTerminalLease): PaneTerminalLeaseView => {
    const snapshot = lease.invalidated ? null : host.read(lease.termId)
    return {
      locale: host.locale(),
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      terminalId: lease.termId,
      ownerKey: lease.owner.key,
      cwd: lease.owner.cwd || snapshot?.cwd || '',
      writable: !lease.invalidated && snapshot?.alive === true,
      invalidated: lease.invalidated,
      ...(lease.invalidReason ? { invalidReason: lease.invalidReason } : {}),
      snapshot
    }
  }

  const openFromMainWindow = (request: PaneTerminalOpenRequest): PaneTerminalOpenResult => {
    if (!request || !isPaneTerminalOwner(request.owner) || typeof request.terminalId !== 'string' || request.terminalId.length === 0) {
      return { ok: false, code: 'rejected', reason: '缺少归属或终端 id' }
    }
    const owner = request.owner
    const terminalId = request.terminalId
    if (!host.authorize(owner, terminalId)) return { ok: false, code: 'not-owner', reason: '归属校验未通过' }
    const snapshot = host.read(terminalId)
    if (!snapshot) return { ok: false, code: 'no-terminal', reason: '终端不存在或已结束' }

    const existing = leases.get(terminalId)
    if (existing) {
      if (existing.owner.key === owner.key) {
        /* 同归属重复打开：复用窗口与 lease，不重挂、不丢输出。 */
        existing.owner = owner
        existing.window.setTitle(snapshot.title)
        existing.window.show()
        return { ok: true, code: 'ok', leaseId: existing.leaseId, epoch: existing.epoch }
      }
      /* 换归属：旧 lease 作废（关窗、释放），再按新归属开。 */
      pushInvalidated(existing, '归属已切换')
      existing.invalidated = true
      releaseLease(existing)
      existing.window.destroy()
    }

    const lease = openLease(owner, terminalId)
    lease.window.setTitle(snapshot.title)
    lease.window.show()
    notify('attached', lease)
    return { ok: true, code: 'ok', leaseId: lease.leaseId, epoch: lease.epoch }
  }

  return {
    kind: 'terminal-attach',

    canTransfer(request) {
      if (!request || request.tab !== 'terminal') return false
      if (!request.terminalId || !isPaneTerminalOwner(request.owner)) return false
      return host.authorize(request.owner, request.terminalId) && host.read(request.terminalId) !== null
    },

    transfer(request) {
      const result = openFromMainWindow({ owner: request.owner, terminalId: request.terminalId ?? '' })
      if (result.ok) return { ok: true }
      return {
        ok: false,
        code: result.code === 'no-terminal' ? 'no-adapter' : 'rejected',
        message: result.reason ?? '终端传移被拒绝',
        followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
      }
    },

    openFromMainWindow,

    stateFor(contents) {
      const lease = findByContents(contents)
      if (!lease) return null
      lease.attached = true
      return buildState(lease)
    },

    input(contents, leaseId, data) {
      const lease = findByContents(contents)
      if (!lease || lease.invalidated || lease.leaseId !== leaseId) return false
      if (typeof data !== 'string' || data.length === 0) return false
      const snapshot = host.read(lease.termId)
      if (!snapshot || !snapshot.alive) return false
      return host.write(lease.termId, data)
    },

    resize(contents, leaseId, cols, rows) {
      const lease = findByContents(contents)
      if (!lease || lease.invalidated || lease.leaseId !== leaseId) return false
      const snapshot = host.read(lease.termId)
      if (!snapshot || !snapshot.alive) return false
      const nextCols = clampPaneTerminalDimension(cols, snapshot.cols)
      const nextRows = clampPaneTerminalDimension(rows, snapshot.rows)
      return host.resize(lease.termId, nextCols, nextRows)
    },

    detach(contents, leaseId) {
      const lease = findByContents(contents)
      if (!lease || lease.leaseId !== leaseId) return false
      releaseLease(lease)
      lease.window.destroy()
      return true
    },

    closeByContents(contents) {
      const lease = findByContents(contents)
      if (!lease) return false
      releaseLease(lease)
      lease.window.destroy()
      return true
    },

    invalidate(ownerKey, reason) {
      for (const lease of leases.values()) {
        if (lease.owner.key !== ownerKey) continue
        if (lease.invalidated) continue
        lease.invalidated = true
        if (reason) lease.invalidReason = reason
        else delete lease.invalidReason
        pushInvalidated(lease, reason)
        notify('invalidated', lease, reason)
      }
    },

    invalidateAll(reason) {
      for (const lease of leases.values()) {
        if (lease.invalidated) continue
        lease.invalidated = true
        if (reason) lease.invalidReason = reason
        else delete lease.invalidReason
        pushInvalidated(lease, reason)
        notify('invalidated', lease, reason)
      }
    },

    forward(event) {
      let handled = false
      for (const lease of leases.values()) {
        if (lease.termId !== event.id) continue
        if (!lease.attached || lease.invalidated) continue
        const payload: PaneTerminalPushEvent =
          event.kind === 'data'
            ? { leaseId: lease.leaseId, epoch: lease.epoch, terminalId: lease.termId, kind: 'data', data: event.data, seq: event.seq }
            : event.kind === 'status'
              ? { leaseId: lease.leaseId, epoch: lease.epoch, terminalId: lease.termId, kind: 'status', status: event.status }
              : { leaseId: lease.leaseId, epoch: lease.epoch, terminalId: lease.termId, kind: 'exit', exitCode: event.exitCode }
        lease.window.send(PANE_TERMINAL_CHANNELS.push, payload)
        handled = true
      }
      return handled
    },

    owns: (contents) => findByContents(contents) !== null,

    dispose() {
      for (const lease of [...leases.values()]) {
        releaseLease(lease)
        lease.window.destroy()
      }
    }
  }
}

/** IPC 层需要的宿主判定：主窗口来源，与 W2 同一思路。 */
export interface PaneTerminalIpcHost {
  isMainWindow(contents: WebContents): boolean
}

/**
 * 注册 `yan:pane-terminal:*`。
 *   · `open` 只接受主窗口；aux 窗口触发不了它；
 *   · `state / input / resize / detach / close-self` 只接受**拥有 lease 的弹窗自身**，
 *     参数里没有 terminalId，主进程只按 leaseId + webContents 身份解析。
 */
export function registerPaneTerminalIpc(transfer: PaneTerminalTransfer, host: PaneTerminalIpcHost): void {
  ipcMain.handle(PANE_TERMINAL_CHANNELS.open, (event, request: unknown) => {
    if (!host.isMainWindow(event.sender)) return { ok: false, code: 'rejected', reason: '拒绝来自非主窗口的终端弹出请求' }
    return transfer.openFromMainWindow(request as PaneTerminalOpenRequest)
  })

  ipcMain.handle(PANE_TERMINAL_CHANNELS.state, (event: { sender: WebContents }) => transfer.stateFor(event.sender))

  ipcMain.handle(PANE_TERMINAL_CHANNELS.input, (event: { sender: WebContents }, leaseId: unknown, data: unknown) =>
    transfer.input(event.sender, String(leaseId ?? ''), typeof data === 'string' ? data : '')
  )

  ipcMain.handle(PANE_TERMINAL_CHANNELS.resize, (event: { sender: WebContents }, leaseId: unknown, cols: unknown, rows: unknown) =>
    transfer.resize(event.sender, String(leaseId ?? ''), Number(cols), Number(rows))
  )

  ipcMain.handle(PANE_TERMINAL_CHANNELS.detach, (event: { sender: WebContents }, leaseId: unknown) =>
    transfer.detach(event.sender, String(leaseId ?? ''))
  )

  ipcMain.on(PANE_TERMINAL_CHANNELS.closeSelf, (event: { sender: WebContents }) => {
    transfer.closeByContents(event.sender)
  })
}
