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

export type PaneTerminalEvent =
  | { kind: 'data'; id: string; data: string; seq: number }
  | { kind: 'status'; id: string; status?: TerminalProgramStatus }
  | { kind: 'exit'; id: string; exitCode: number | null }

export interface PaneTerminalLeaseChange {
  kind: 'attached' | 'detached' | 'invalidated'
  terminalId: string
  ownerKey: string
  leaseId: string
  epoch: number
  reason?: string
}

export interface PaneTerminalTransferHost extends PanePopoutHost {
  read(terminalId: string): PaneTerminalSnapshot | null
  write(terminalId: string, data: string): boolean
  resize(terminalId: string, cols: number, rows: number): boolean
  authorize(owner: PanePopoutOwner, terminalId: string): boolean
}

export type PaneTerminalWindowFactory = (deps: PanePopoutWindowDeps) => PanePopoutWindow

export interface PaneTerminalTransferOptions {
  createWindow?: PaneTerminalWindowFactory
  onLeaseChange?: (event: PaneTerminalLeaseChange) => void
}

export interface PaneTerminalTransfer {
  readonly kind: 'terminal-attach'
  canTransfer(request: PaneNativeTransferRequest): boolean
  transfer(request: PaneNativeTransferRequest): PaneTransferResult
  openFromMainWindow(request: PaneTerminalOpenRequest): PaneTerminalOpenResult
  stateFor(contents: WebContents): PaneTerminalLeaseView | null
  input(contents: WebContents, leaseId: string, data: string): boolean
  resize(contents: WebContents, leaseId: string, cols: number, rows: number): boolean
  detach(contents: WebContents, leaseId: string): boolean
  closeByContents(contents: WebContents): boolean
  invalidate(ownerKey: string, reason?: string): void
  invalidateAll(reason?: string): void
  forward(event: PaneTerminalEvent): boolean
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
        existing.owner = owner
        existing.window.setTitle(snapshot.title)
        existing.window.show()
        return { ok: true, code: 'ok', leaseId: existing.leaseId, epoch: existing.epoch }
      }
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

export interface PaneTerminalIpcHost {
  isMainWindow(contents: WebContents): boolean
}

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
