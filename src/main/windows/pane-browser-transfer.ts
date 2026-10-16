import {
  PANE_NATIVE_TRANSFER_FOLLOW_UP,
  type PaneNativeTransferAdapter,
  type PaneNativeTransferRequest,
  type PaneTransferResult
} from '../../shared/pane-popout'
import type { Rect } from './geometry'

export interface BrowserTransferContentView {
  readonly children: readonly unknown[]
  addChildView(view: unknown): void
  removeChildView(view: unknown): void
}

export interface BrowserTransferWindow {
  readonly contentView: BrowserTransferContentView
  readonly webContents: { readonly id: number }
  isDestroyed?(): boolean
}

export interface BrowserTransferNavigation {
  canGoBack(): boolean
  goBack(): void
  canGoForward(): boolean
  goForward(): void
  reload(): void
  getURL(): string
}

export interface BrowserTransferView {
  readonly webContents:
    | ({ readonly id: number; isDestroyed(): boolean } & Partial<BrowserTransferNavigation>)
    | null
  setVisible(visible: boolean): void
  setBounds(bounds: Rect): void
}

export type BrowserTransferRevokeReason = 'tab-closed' | 'controller-disposed'

export interface BrowserHostTransferHandle {
  readonly tabId: string
  readonly ownerKey: string
  readonly generation: number
  readonly webContentsId: number
  readonly view: BrowserTransferView
  readonly sourceWindow: BrowserTransferWindow | null
  navigate(url: string): Promise<{ ok: boolean; error?: string }>
  closeTab(): Promise<void>
}

export interface BrowserHostTransferBridge {
  beginHostTransfer(request: {
    tabId: string
    ownerKey: string
    generation: number
    onRevoke(reason: BrowserTransferRevokeReason): void
  }): { ok: boolean; code: string; message?: string; transfer?: BrowserHostTransferHandle }
  endHostTransfer(tabId: string, ownerKey: string): boolean
}

export type BrowserLeaseInvalidReason =
  | 'released'
  | 'owner-stale'
  | 'target-closed'
  | 'tab-closed'
  | 'disposed'

export interface BrowserPaneLease {
  readonly tabId: string
  readonly ownerKey: string
  readonly generation: number
  readonly webContentsId: number
  readonly targetWebContentsId: number
  readonly invalidated: boolean
  readonly invalidReason?: BrowserLeaseInvalidReason
}

export interface BrowserLeaseSender {
  readonly webContentsId: number
  readonly ownerKey?: string
  readonly generation?: number
}

export type BrowserLeaseCode =
  | 'ok'
  | 'rejected'
  | 'stale'
  | 'invalid-owner'
  | 'owner-conflict'
  | 'not-found'
  | 'destroyed'
  | 'target-closed'
  | 'unsupported'

export interface BrowserLeaseResult {
  ok: boolean
  code: BrowserLeaseCode
  message?: string
  lease?: BrowserPaneLease
}

export interface PaneBrowserTransferBeginRequest {
  tabId: string
  ownerKey: string
  generation: number
  target: BrowserTransferWindow
  onInvalidate?(lease: BrowserPaneLease, reason: BrowserLeaseInvalidReason): void
}

export interface PaneBrowserTransfer {
  readonly kind: 'native-view'
  begin(request: PaneBrowserTransferBeginRequest): BrowserLeaseResult
  updateBounds(sender: BrowserLeaseSender, bounds: Rect): BrowserLeaseResult
  navigate(sender: BrowserLeaseSender, url: string): Promise<BrowserLeaseResult>
  goBack(sender: BrowserLeaseSender): BrowserLeaseResult
  goForward(sender: BrowserLeaseSender): BrowserLeaseResult
  reload(sender: BrowserLeaseSender): BrowserLeaseResult
  navigationState(sender: BrowserLeaseSender): { url: string; canGoBack: boolean; canGoForward: boolean } | null
  close(sender: BrowserLeaseSender): Promise<BrowserLeaseResult>
  returnToHost(sender: BrowserLeaseSender): BrowserLeaseResult
  invalidateOwner(ownerKey: string, reason?: BrowserLeaseInvalidReason): number
  invalidateTab(tabId: string, reason?: BrowserLeaseInvalidReason): boolean
  invalidateAll(reason?: BrowserLeaseInvalidReason): void
  leaseOfTab(tabId: string): BrowserPaneLease | null
  leaseOfTarget(webContentsId: number): BrowserPaneLease | null
  isLeased(tabId: string): boolean
  owns(sender: BrowserLeaseSender): boolean
  dispose(): void
}

export function normalizeTransferBounds(bounds: Rect | null | undefined): Rect | null {
  if (!bounds) return null
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

function windowAlive(window: BrowserTransferWindow | null | undefined): window is BrowserTransferWindow {
  return !!window && !(window.isDestroyed?.() ?? false) && !!window.contentView
}

function viewAlive(view: BrowserTransferView): boolean {
  const contents = view.webContents
  return !!contents && !contents.isDestroyed()
}

function navigationOf(record: LeaseRecord): BrowserTransferNavigation | null {
  const contents = record.handle.view.webContents
  if (!contents || contents.isDestroyed()) return null
  if (typeof contents.canGoBack !== 'function' || typeof contents.goBack !== 'function') return null
  if (typeof contents.canGoForward !== 'function' || typeof contents.goForward !== 'function') return null
  if (typeof contents.reload !== 'function') return null
  return contents as BrowserTransferNavigation
}

function detachView(view: BrowserTransferView, window: BrowserTransferWindow | null | undefined): void {
  if (!windowAlive(window)) return
  if (!window.contentView.children.includes(view)) return
  window.contentView.removeChildView(view)
}

function attachView(view: BrowserTransferView, window: BrowserTransferWindow | null | undefined): void {
  if (!windowAlive(window)) return
  if (window.contentView.children.includes(view)) return
  window.contentView.addChildView(view)
}

function hideView(view: BrowserTransferView): void {
  if (!viewAlive(view)) return
  view.setVisible(false)
}

function showView(view: BrowserTransferView): void {
  if (!viewAlive(view)) return
  view.setVisible(true)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface LeaseRecord {
  tabId: string
  ownerKey: string
  generation: number
  webContentsId: number
  targetWebContentsId: number
  target: BrowserTransferWindow
  handle: BrowserHostTransferHandle
  invalidated: boolean
  invalidReason?: BrowserLeaseInvalidReason
  onInvalidate?: (lease: BrowserPaneLease, reason: BrowserLeaseInvalidReason) => void
}

export function createPaneBrowserTransfer(host: BrowserHostTransferBridge): PaneBrowserTransfer {
  const byTab = new Map<string, LeaseRecord>()
  const byTarget = new Map<number, LeaseRecord>()
  let disposed = false

  const snapshot = (record: LeaseRecord): BrowserPaneLease => ({
    tabId: record.tabId,
    ownerKey: record.ownerKey,
    generation: record.generation,
    webContentsId: record.webContentsId,
    targetWebContentsId: record.targetWebContentsId,
    invalidated: record.invalidated,
    ...(record.invalidReason ? { invalidReason: record.invalidReason } : {})
  })

  const forget = (record: LeaseRecord): void => {
    if (byTab.get(record.tabId) === record) byTab.delete(record.tabId)
    if (byTarget.get(record.targetWebContentsId) === record) byTarget.delete(record.targetWebContentsId)
  }

  const release = (record: LeaseRecord, reason: BrowserLeaseInvalidReason, returnToHost: boolean): boolean => {
    if (record.invalidated) return false
    record.invalidated = true
    record.invalidReason = reason
    detachView(record.handle.view, record.target)
    hideView(record.handle.view)
    if (returnToHost) {
      attachView(record.handle.view, record.handle.sourceWindow)
      hideView(record.handle.view)
      host.endHostTransfer(record.tabId, record.ownerKey)
    }
    forget(record)
    record.onInvalidate?.(snapshot(record), reason)
    return true
  }

  const findActive = (
    sender: BrowserLeaseSender | undefined
  ): { record: LeaseRecord } | { error: BrowserLeaseResult } => {
    if (!sender || typeof sender.webContentsId !== 'number') {
      return { error: { ok: false, code: 'rejected', message: '缺少来源窗口' } }
    }
    const record = byTarget.get(sender.webContentsId)
    if (!record || record.invalidated) {
      return { error: { ok: false, code: 'stale', message: '该窗口没有有效的浏览器租约' } }
    }
    if (sender.ownerKey !== undefined && sender.ownerKey !== record.ownerKey) {
      return { error: { ok: false, code: 'invalid-owner', message: '调用来源与租约归属不一致' } }
    }
    if (sender.generation !== undefined && sender.generation !== record.generation) {
      return { error: { ok: false, code: 'invalid-owner', message: '调用来源的代次已过期' } }
    }
    return { record }
  }

  const begin: PaneBrowserTransfer['begin'] = (request) => {
    if (disposed) return { ok: false, code: 'rejected', message: '适配器已销毁' }
    const tabId = typeof request?.tabId === 'string' ? request.tabId.trim() : ''
    const ownerKey = typeof request?.ownerKey === 'string' ? request.ownerKey.trim() : ''
    if (!tabId || !ownerKey) return { ok: false, code: 'rejected', message: '缺少页签 id 或归属' }
    const generation = Number.isFinite(request.generation) ? Math.trunc(request.generation) : 0
    const target = request.target
    if (!windowAlive(target)) return { ok: false, code: 'target-closed', message: '目标窗口不可用' }
    const targetId = target.webContents?.id
    if (typeof targetId !== 'number') return { ok: false, code: 'rejected', message: '目标窗口缺少标识' }

    const existing = byTab.get(tabId)
    if (existing) {
      if (existing.ownerKey !== ownerKey) {
        return { ok: false, code: 'owner-conflict', message: '该页签已借给其它归属，不能抢占' }
      }
      if (existing.generation !== generation) existing.generation = generation
      if (existing.targetWebContentsId === targetId && existing.target === target) {
        return { ok: true, code: 'ok', lease: snapshot(existing) }
      }
      detachView(existing.handle.view, existing.target)
      byTarget.delete(existing.targetWebContentsId)
      attachView(existing.handle.view, target)
      showView(existing.handle.view)
      existing.target = target
      existing.targetWebContentsId = targetId
      byTarget.set(targetId, existing)
      return { ok: true, code: 'ok', lease: snapshot(existing) }
    }

    let record: LeaseRecord | null = null
    const revoke = (reason: BrowserTransferRevokeReason): void => {
      if (!record || record.invalidated) return
      release(record, reason === 'tab-closed' ? 'tab-closed' : 'disposed', false)
    }

    let hostResult: ReturnType<BrowserHostTransferBridge['beginHostTransfer']>
    try {
      hostResult = host.beginHostTransfer({ tabId, ownerKey, generation, onRevoke: revoke })
    } catch (error) {
      return { ok: false, code: 'rejected', message: messageOf(error) }
    }
    if (!hostResult?.ok || !hostResult.transfer) {
      const code = hostResult?.code
      const mapped: BrowserLeaseCode =
        code === 'not-found' || code === 'destroyed' || code === 'owner-conflict' ? code : 'rejected'
      return { ok: false, code: mapped, message: hostResult?.message ?? '宿主拒绝改挂该页签' }
    }

    const handle = hostResult.transfer
    record = {
      tabId,
      ownerKey,
      generation,
      webContentsId: handle.webContentsId,
      targetWebContentsId: targetId,
      target,
      handle,
      invalidated: false,
      onInvalidate: request.onInvalidate
    }

    const view = handle.view
    detachView(view, handle.sourceWindow)
    if (!windowAlive(target)) {
      attachView(view, handle.sourceWindow)
      hideView(view)
      host.endHostTransfer(tabId, ownerKey)
      return { ok: false, code: 'target-closed', message: '目标窗口在改挂前失效，已回滚' }
    }
    attachView(view, target)
    showView(view)
    byTab.set(tabId, record)
    byTarget.set(targetId, record)
    return { ok: true, code: 'ok', lease: snapshot(record) }
  }

  return {
    kind: 'native-view',
    begin,

    updateBounds(sender, bounds): BrowserLeaseResult {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const clean = normalizeTransferBounds(bounds)
      if (!clean) return { ok: false, code: 'rejected', message: '坐标不合法' }
      found.record.handle.view.setBounds(clean)
      return { ok: true, code: 'ok' }
    },

    async navigate(sender, url): Promise<BrowserLeaseResult> {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const next = typeof url === 'string' ? url.trim() : ''
      if (!next) return { ok: false, code: 'rejected', message: '地址不能为空' }
      try {
        const result = await found.record.handle.navigate(next)
        return result?.ok ? { ok: true, code: 'ok' } : { ok: false, code: 'rejected', message: result?.error ?? '导航失败' }
      } catch (error) {
        return { ok: false, code: 'rejected', message: messageOf(error) }
      }
    },

    goBack(sender): BrowserLeaseResult {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const nav = navigationOf(found.record)
      if (!nav) return { ok: false, code: 'unsupported', message: '当前视图不支持历史返回' }
      if (!nav.canGoBack()) return { ok: false, code: 'rejected', message: '没有可返回的页面' }
      nav.goBack()
      return { ok: true, code: 'ok' }
    },

    goForward(sender): BrowserLeaseResult {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const nav = navigationOf(found.record)
      if (!nav) return { ok: false, code: 'unsupported', message: '当前视图不支持历史前进' }
      if (!nav.canGoForward()) return { ok: false, code: 'rejected', message: '没有可前进的页面' }
      nav.goForward()
      return { ok: true, code: 'ok' }
    },

    reload(sender): BrowserLeaseResult {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const nav = navigationOf(found.record)
      if (!nav) return { ok: false, code: 'unsupported', message: '当前视图不支持刷新' }
      nav.reload()
      return { ok: true, code: 'ok' }
    },

    navigationState(sender) {
      const found = findActive(sender)
      if ('error' in found) return null
      const contents = found.record.handle.view.webContents
      if (!contents || contents.isDestroyed()) return null
      return {
        url: typeof contents.getURL === 'function' ? contents.getURL() : '',
        canGoBack: typeof contents.canGoBack === 'function' ? contents.canGoBack() : false,
        canGoForward: typeof contents.canGoForward === 'function' ? contents.canGoForward() : false
      }
    },

    async close(sender): Promise<BrowserLeaseResult> {
      const found = findActive(sender)
      if ('error' in found) return found.error
      const record = found.record
      record.invalidated = true
      record.invalidReason = 'tab-closed'
      detachView(record.handle.view, record.target)
      forget(record)
      try {
        await record.handle.closeTab()
        return { ok: true, code: 'ok' }
      } catch (error) {
        return { ok: false, code: 'rejected', message: messageOf(error) }
      }
    },

    returnToHost(sender): BrowserLeaseResult {
      const found = findActive(sender)
      if ('error' in found) return found.error
      return release(found.record, 'released', true)
        ? { ok: true, code: 'ok' }
        : { ok: false, code: 'stale', message: '租约已失效' }
    },

    invalidateOwner(ownerKey, reason = 'owner-stale'): number {
      const targets = [...byTab.values()].filter((record) => record.ownerKey === ownerKey && !record.invalidated)
      let count = 0
      for (const record of targets) if (release(record, reason, true)) count += 1
      return count
    },

    invalidateTab(tabId, reason = 'owner-stale'): boolean {
      const record = byTab.get(tabId)
      return record ? release(record, reason, true) : false
    },

    invalidateAll(reason = 'owner-stale'): void {
      for (const record of [...byTab.values()]) release(record, reason, true)
    },

    leaseOfTab: (tabId) => {
      const record = byTab.get(tabId)
      return record ? snapshot(record) : null
    },
    leaseOfTarget: (webContentsId) => {
      const record = byTarget.get(webContentsId)
      return record ? snapshot(record) : null
    },
    isLeased: (tabId) => {
      const record = byTab.get(tabId)
      return !!record && !record.invalidated
    },
    owns: (sender) => {
      if (!sender || typeof sender.webContentsId !== 'number') return false
      const record = byTarget.get(sender.webContentsId)
      return !!record && !record.invalidated
    },

    dispose(): void {
      if (disposed) return
      for (const record of [...byTab.values()]) release(record, 'disposed', true)
      disposed = true
    }
  }
}

export interface PaneBrowserTransferAdapterOptions {
  host: BrowserHostTransferBridge
  resolveTarget(request: PaneNativeTransferRequest): BrowserTransferWindow | undefined
  onInvalidate?(request: PaneNativeTransferRequest, lease: BrowserPaneLease, reason: BrowserLeaseInvalidReason): void
}

export interface PaneBrowserTransferAdapter extends PaneNativeTransferAdapter {
  readonly kind: 'native-view'
  readonly port: PaneBrowserTransfer
}

export function createPaneBrowserTransferAdapter(
  options: PaneBrowserTransferAdapterOptions
): PaneBrowserTransferAdapter {
  const port = createPaneBrowserTransfer(options.host)
  return {
    kind: 'native-view',
    port,
    canTransfer(request) {
      if (!request || request.tab !== 'browser' || !request.viewId) return false
      return Boolean(options.resolveTarget(request))
    },
    transfer(request): PaneTransferResult {
      if (!request || request.tab !== 'browser') {
        return {
          ok: false,
          code: 'unsupported',
          message: '该适配器只处理 browser 页签',
          followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
        }
      }
      const tabId = request.viewId
      if (!tabId) {
        return { ok: false, code: 'rejected', message: '缺少浏览器页签 id', followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP }
      }
      const target = options.resolveTarget(request)
      if (!target) {
        return {
          ok: false,
          code: 'unsupported',
          message: '找不到承载原生视图的目标窗口',
          followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
        }
      }
      const result = port.begin({
        tabId,
        ownerKey: request.owner.key,
        generation: request.owner.generation ?? 0,
        target,
        onInvalidate: (lease, reason) => options.onInvalidate?.(request, lease, reason)
      })
      if (result.ok) return { ok: true }
      return {
        ok: false,
        code: result.code === 'owner-conflict' ? 'rejected' : 'unsupported',
        message: result.message ?? '原生视图改挂失败',
        followUp: PANE_NATIVE_TRANSFER_FOLLOW_UP
      }
    }
  }
}
