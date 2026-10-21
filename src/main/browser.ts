import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { app, shell, BrowserWindow, WebContentsView } from 'electron'
import type {
  BrowserTransferRevokeReason,
  BrowserTransferView,
  BrowserTransferWindow
} from './windows/pane-browser-transfer'
import { mkdir } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  BrowserBlockedRequest,
  BrowserBounds,
  BrowserNetworkSnapshot,
  BrowserObservation,
  BrowserPermissionRecord,
  BrowserState,
  BrowserTabState,
  MainPush
} from '../shared/ipc'
import { BrowserPolicy } from './browser/BrowserPolicy'
import { sharedResources, INTERACTIVE_RESOURCE } from './interactive-resources'
import { failureUrl, shouldSurfaceLoadError } from '../shared/browser-navigation'
import { CDPBridge } from './browser/CDPBridge'
import type { CdpChannel } from './browser/CdpChannel'
import { ElementRegistry } from './browser/ElementRegistry'
import { InputController, type SelectOutcome } from './browser/InputController'
import { Observer } from './browser/Observer'
import { NetworkTracker } from './browser/NetworkTracker'
import {
  RawCdp,
  createTab as createCdpTab,
  closeTarget as closeCdpTarget,
  listTargets,
  pickPageTarget,
  waitForCdp,
  type CdpTarget
} from './browser/RawCdp'
import { defaultProfileDir, launchChrome, pickFreePort, stopChrome } from './chrome'
import { syncLocalChromeData, type ChromeSyncReport } from './chrome-profile'
import { YAN_DIR } from './paths'
import { transferCookies } from './browser/cookie-transfer'
import { transferPageStorage } from './browser/storage-transfer'
import { PrivateDnsGuard } from './browser/network-policy'
import { isForbiddenOrigin, normalizeSiteOrigin } from './preview-site-access'
import type { PreviewSiteGate } from './preview-site-gate'
import { decideRequestBoundary } from './browser/network-boundary'
import { decideExternalRequest } from './browser/external-boundary'
import { createStateFlush, ownedViewVisible } from './browser/host-state'

type Push = (msg: MainPush) => void
type BrowserActionResult = { ok: boolean; error?: string; code?: string }
const INITIAL_URL = 'about:blank'

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim()
  if (value === 'about:blank') return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const origin = normalizeSiteOrigin(url.toString())
    return origin && !isForbiddenOrigin(origin) ? url.toString() : null
  } catch {
    return null
  }
}

function normalizePermissionOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function permissionKey(permission: string, origin: string): string {
  return `${permission}\u0000${origin}`
}

interface BrowserTab {
  id: string
  view: WebContentsView
  cdp: CDPBridge
  registry: ElementRegistry
  observer: Observer
  input: InputController
  network: NetworkTracker
  state: BrowserTabState
  committedUrl: string
  pendingMainFrameUrl: string | null
  openerUrl: string
  borrowedBy?: string
}

interface ExternalTarget {
  cdp: RawCdp
  registry: ElementRegistry
  observer: Observer
  input: InputController
  network: NetworkTracker
  chrome: ChildProcess | null
  port: number
  profileDir: string
  targetId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  chromeTabs: BrowserTabState[]
  syncReport?: ChromeSyncReport
}

interface TargetParts {
  cdp: CdpChannel
  registry: ElementRegistry
  observer: Observer
  input: InputController
  network: NetworkTracker
}

export interface BrowserHostTransfer {
  readonly tabId: string
  readonly ownerKey: string
  readonly generation: number
  readonly webContentsId: number
  readonly view: BrowserTransferView
  readonly sourceWindow: BrowserTransferWindow | null
  navigate(url: string): Promise<BrowserActionResult>
  closeTab(): Promise<void>
}

export interface BrowserHostTransferRequest {
  tabId: string
  ownerKey: string
  generation: number
  onRevoke(reason: BrowserTransferRevokeReason): void
}

export interface BrowserHostTransferResult {
  ok: boolean
  code: 'ok' | 'not-found' | 'destroyed' | 'owner-conflict'
  message?: string
  transfer?: BrowserHostTransfer
}

export class BrowserController {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly hostTransfers = new Map<
    string,
    {
      ownerKey: string
      generation: number
      transfer: BrowserHostTransfer
      revoke: (reason: BrowserTransferRevokeReason) => void
    }
  >()
  private activeTabId: string | null = null
  private userControl = false
  private lastDownload: BrowserState['lastDownload']
  private automationOwner?: string
  private readonly ownedDownloads = new Map<string, NonNullable<BrowserState['lastDownload']>>()
  setAutomationOwner(owner?: string): void { this.automationOwner = owner }
  getOwnedDownload(owner: string): BrowserState['lastDownload'] { return this.ownedDownloads.get(owner) }
  private nativeBounds: BrowserBounds | undefined
  private downloadSessionAttached = false
  private permissionHandlersAttached = false
  private requestBoundaryAttached = false
  private permissionLog: BrowserPermissionRecord[] = []
  private blockedRequests: BrowserBlockedRequest[] = []
  private readonly permissionGrants = new Set<string>()
  private readonly privateDns = new PrivateDnsGuard()
  private viewVisibleRequested = false
  private readonly stateFlush = createStateFlush(() => this.updateState())
  private external: ExternalTarget | null = null
  private externalOpening: Promise<BrowserActionResult> | null = null
  private externalBoundaryCdp: RawCdp | null = null
  private externalPendingUrl = ''
  private activeMode: 'embedded' | 'external' = 'embedded'

  private externalTabId(targetId: string): string {
    return `chrome:${targetId}`
  }

  private externalTargetId(tabId: string): string | null {
    return tabId.startsWith('chrome:') ? tabId.slice('chrome:'.length) : null
  }
  private readonly externalDownloads = new Map<string, { filename: string; url: string }>()
  private state: BrowserState = {
    open: false,
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    tabs: []
  }
  private readonly policy = new BrowserPolicy()

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly push: Push,
    private readonly siteGate: () => PreviewSiteGate | null = () => null,
    private readonly approveProfileSync: () => Promise<boolean> = async () => false
  ) {}

  getState(): BrowserState {
    const ext = this.external
    const active = this.activeTab()
    const activeIsExternal = this.activeMode === 'external' && Boolean(ext)
    const embeddedTabs = [...this.tabs.values()].map((tab) => ({ ...tab.state }))
    const externalTabs = ext ? ext.chromeTabs.map((tab) => ({ ...tab, id: this.externalTabId(tab.id) })) : []
    return {
      open: Boolean(active) || Boolean(ext),
      url: activeIsExternal ? ext?.url ?? '' : active?.state.url ?? '',
      title: activeIsExternal ? ext?.title ?? '' : active?.state.title ?? '',
      loading: activeIsExternal ? ext?.loading ?? false : active?.state.loading ?? false,
      canGoBack: activeIsExternal ? ext?.canGoBack ?? false : active?.state.canGoBack ?? false,
      canGoForward: activeIsExternal ? ext?.canGoForward ?? false : active?.state.canGoForward ?? false,
      tabs: [...embeddedTabs, ...externalTabs],
      activeTabId: activeIsExternal ? this.externalTabId(ext!.targetId) : this.activeTabId ?? undefined,
      userControl: this.userControl,
      lastDownload: this.lastDownload,
      loadError: activeIsExternal ? undefined : active?.state.loadError,
      permissions: this.permissionLog,
      blockedRequests: this.blockedRequests,
      nativeBounds: this.nativeBounds,
      mode: activeIsExternal ? 'external' : 'embedded',
      external: ext
        ? {
            url: ext.url,
            title: ext.title,
            loading: ext.loading,
            profileDir: ext.profileDir,
            debuggingPort: ext.port,
            sync: ext.syncReport
          }
        : undefined
    }
  }

  private publish(): void {
    this.push({ ch: 'browser-state', payload: this.getState() })
  }

  private updateState(): void {
    sharedResources.setPaused(INTERACTIVE_RESOURCE, this.userControl)
    this.state = this.getState()
    this.publish()
  }

  private parts(): TargetParts | null {
    if (this.external && this.activeMode === 'external') return this.external
    const tab = this.activeTab()
    return tab ? { cdp: tab.cdp, registry: tab.registry, observer: tab.observer, input: tab.input, network: tab.network } : null
  }

  private createTab(): BrowserTab {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:yan-browser'
      }
    })
    view.setBackgroundColor('#ffffff')
    view.webContents.setZoomMode('isolated')
    view.webContents.setZoomFactor(1)
    const id = `tab-${randomBytes(5).toString('hex')}`
    const cdp = new CDPBridge(view.webContents)
    const registry = new ElementRegistry()
    const tab: BrowserTab = {
      id,
      view,
      cdp,
      registry,
      observer: new Observer(cdp, registry),
      input: new InputController(cdp),
      network: new NetworkTracker(cdp),
      state: { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
      committedUrl: '',
      pendingMainFrameUrl: null,
      openerUrl: ''
    }
    void tab.network.start()
    view.webContents.on('did-start-loading', () => {
      tab.state.loading = true
      tab.state.loadError = undefined
      this.updateState()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.state.loading = false
      tab.pendingMainFrameUrl = null
      this.syncTabNavigation(tab)
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-finish-load', () => {
      void view.webContents.insertCSS('@media (max-width: 300px) { ::-webkit-scrollbar:horizontal { height: 0 !important; } }').catch(() => {})
    })
    view.webContents.on('did-navigate', (_event, url) => {
      tab.state.url = url
      tab.committedUrl = url
      tab.state.loadError = undefined
      tab.pendingMainFrameUrl = null
      tab.state.canGoBack = view.webContents.canGoBack()
      tab.state.canGoForward = view.webContents.canGoForward()
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      tab.state.url = url
      tab.committedUrl = url
      tab.state.loadError = undefined
      tab.state.canGoBack = view.webContents.canGoBack()
      tab.state.canGoForward = view.webContents.canGoForward()
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.state.title = title
      this.updateState()
    })
    view.webContents.on('render-process-gone', () => {
      tab.state.loading = false
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      tab.pendingMainFrameUrl = null
      tab.state.loading = false
      if (shouldSurfaceLoadError(errorCode, isMainFrame !== false)) {
        tab.state.loadError = {
          code: errorCode,
          description: errorDescription,
          url: failureUrl(validatedURL, tab.state.url)
        }
      }
      this.updateState()
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = safeUrl(url)
      if (target) {
        void this.openGatedTab(tab, target, tab.committedUrl || tab.openerUrl).catch((error) =>
          this.pushError(`无法打开后台标签：${error instanceof Error ? error.message : String(error)}`)
        )
      }
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => this.guardNavigation(tab, event, url))
    view.webContents.on('will-redirect', (event, url) => this.guardNavigation(tab, event, url))
    view.webContents.debugger.on('message', (_event, method) => {
      if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated') {
        tab.registry.clear()
      }
    })
    if (!this.downloadSessionAttached) {
      try {
        view.webContents.session.on('will-download', (_event, item, contents) => {
          const owner = !this.userControl && this.activeMode !== 'external' && contents?.id === this.activeTab()?.view.webContents.id ? this.automationOwner : undefined
          void this.handleDownload(item, owner).catch((error) => {
            item.cancel()
            this.pushError(`浏览器下载无法保存：${error instanceof Error ? error.message : String(error)}`)
          })
        })
        this.downloadSessionAttached = true
      } catch (error) {
        this.pushError(`浏览器下载监听未能启用：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!this.permissionHandlersAttached) {
      try {
        const ses = view.webContents.session
        ses.setPermissionRequestHandler((wc, permission, callback, details) => {
          const name = String(permission)
          const rawUrl = (details as { requestingUrl?: unknown } | undefined)?.requestingUrl
          const origin = normalizePermissionOrigin(rawUrl) ?? normalizePermissionOrigin(wc.getURL()) ?? ''
          const allowed = Boolean(origin && this.permissionGrants.has(permissionKey(name, origin)))
          this.recordPermission(name, origin, allowed ? 'allowed' : 'blocked')
          this.updateState()
          callback(allowed)
        })
        ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
          const origin = normalizePermissionOrigin(requestingOrigin)
          return Boolean(origin && this.permissionGrants.has(permissionKey(String(permission), origin)))
        })
        this.permissionHandlersAttached = true
      } catch (error) {
        this.pushError(`浏览器权限处理未能启用：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!this.requestBoundaryAttached) {
      try {
        view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        let target: URL
        try {
          target = new URL(details.url)
        } catch {
          callback({})
          return
        }
        const owner = [...this.tabs.values()].find(
          (t) => t.view.webContents.id === details.webContentsId
        )
        const requestFrame = details.frame
        const frameUrl = details.resourceType === 'subFrame' ? requestFrame?.parent?.url : requestFrame?.url
        const initiator = frameUrl || (details.resourceType === 'mainFrame' ? owner?.committedUrl || owner?.openerUrl : '') || ''
        const decision = decideRequestBoundary({
          targetHost: target.hostname,
          initiatorUrl: initiator,
          resourceType: details.resourceType,
          requestedByUs:
            details.resourceType === 'mainFrame' && owner?.pendingMainFrameUrl === details.url
        })
        if (decision === 'allow') {
          callback({})
          return
        }
        if (decision === 'block-private') {
          this.recordBlockedRequest(target.hostname, 'private-host', initiator)
          callback({ cancel: true })
          return
        }
        void this.resolvesToPrivateTarget(target.hostname)
          .then((privateTarget) => {
            if (privateTarget) this.recordBlockedRequest(target.hostname, 'dns-rebind', initiator)
            callback(privateTarget ? { cancel: true } : {})
          })
          .catch(() => callback({}))
      })
        this.requestBoundaryAttached = true
      } catch (error) {
        this.pushError(`浏览器网络边界未能启用：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void cdp.attach().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (tab.view.webContents.isDestroyed() || /target closed|closed|destroyed/i.test(message)) return
      this.pushError(`浏览器 CDP 启动失败：${message}`)
    })
    this.tabs.set(id, tab)
    return tab
  }

  private syncTabNavigation(tab: BrowserTab): void {
    tab.state.url = tab.view.webContents.getURL()
    tab.state.canGoBack = tab.view.webContents.canGoBack()
    tab.state.canGoForward = tab.view.webContents.canGoForward()
  }

  private activeTab(): BrowserTab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null
  }

  private removeForeignBrowserViews(win: BrowserWindow): void {
    const owned = new Set([...this.tabs.values()].map((tab) => tab.view))
    for (const child of [...win.contentView.children]) {
      if (owned.has(child as WebContentsView)) continue
      const contents = (child as WebContentsView).webContents
      if (!contents || contents.id === win.webContents.id) continue
      win.contentView.removeChildView(child)
    }
  }

  async open(url = INITIAL_URL): Promise<BrowserState> {
    const next = safeUrl(url)
    if (!next) throw new Error('只允许打开 http(s) 网页')
    this.activeMode = 'embedded'
    let tab = this.activeTab()
    if (!tab) {
      tab = this.createTab()
      this.activeTabId = tab.id
    }
    const win = this.getWindow()
    if (!win) return this.getState()
    this.removeForeignBrowserViews(win)
    this.showOnlyOwnedView(tab.id)
    if (!tab.borrowedBy && !win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view)
    if (next !== tab.view.webContents.getURL()) {
      tab.state.url = next
      tab.state.title = ''
      tab.state.loading = true
      tab.pendingMainFrameUrl = next
      this.updateState()
        await tab.view.webContents.loadURL(next).catch(() => undefined)
    }
    if (tab.view.webContents.isDestroyed()) return this.getState()
    this.syncTabNavigation(tab)
    this.updateState()
    return this.getState()
  }

  private guardNavigation(tab: BrowserTab, event: { preventDefault(): void }, rawUrl: string): void {
    const url = safeUrl(rawUrl)
    if (!url) {
      event.preventDefault()
      return
    }
    const gate = this.siteGate()
    if (!gate) return
    const verdict = gate.peek(tab.id, url)
    if (verdict === 'allow') return
    event.preventDefault()
    if (verdict !== 'ask') return
    void this.navigateAfterApproval(tab, url)
  }

  private async navigateAfterApproval(tab: BrowserTab, url: string): Promise<void> {
    const gate = this.siteGate()
    if (!gate) return
    const decision = await gate.check(tab.id, url).catch(() => 'deny' as const)
    if (decision !== 'allow') return
    if (tab.view.webContents.isDestroyed() || this.tabs.get(tab.id) !== tab) return
    tab.state.url = url
    tab.state.title = ''
    tab.state.loading = true
    tab.pendingMainFrameUrl = url
    this.updateState()
    await tab.view.webContents.loadURL(url).catch(() => undefined)
    if (tab.view.webContents.isDestroyed() || this.tabs.get(tab.id) !== tab) return
    this.syncTabNavigation(tab)
    this.updateState()
  }

  private async openGatedTab(tab: BrowserTab, url: string, openerUrl: string): Promise<void> {
    const gate = this.siteGate()
    if (gate && gate.peek(tab.id, url) !== 'allow') {
      const decision = await gate.check(tab.id, url).catch(() => 'deny' as const)
      if (decision !== 'allow') return
    }
    await this.openBackgroundTab(url, openerUrl)
  }

  private async openBackgroundTab(rawUrl: string, openerUrl: string): Promise<void> {
    const url = safeUrl(rawUrl)
    if (!url) return
    const tab = this.createTab()
    const win = this.getWindow()
    if (win) {
      this.removeForeignBrowserViews(win)
      win.contentView.addChildView(tab.view)
    }
    tab.view.setVisible(false)
    tab.state.url = url
    tab.state.loading = true
    tab.openerUrl = openerUrl
    this.updateState()
    try {
      await tab.view.webContents.loadURL(url)
    } catch {
    }
    if (tab.view.webContents.isDestroyed() || this.tabs.get(tab.id) !== tab) return
    this.syncTabNavigation(tab)
    this.updateState()
  }

  async newTab(rawUrl = INITIAL_URL): Promise<BrowserState> {
    const url = safeUrl(rawUrl)
    if (!url) throw new Error('只允许打开 http(s) 网页')
    if (this.external && this.activeMode === 'external') {
      const created = await createCdpTab(this.external.port, url)
      if (created?.webSocketDebuggerUrl) await this.attachExternalTarget(created)
      else await this.navigateExternal(url)
      return this.getState()
    }
    const tab = this.createTab()
    this.activeTabId = tab.id
    const win = this.getWindow()
    if (win) {
      this.removeForeignBrowserViews(win)
      win.contentView.addChildView(tab.view)
    }
    this.showOnlyOwnedView(tab.id)
    tab.state.url = url
    tab.state.loading = true
    tab.pendingMainFrameUrl = url
    this.updateState()
    await tab.view.webContents.loadURL(url).catch(() => undefined)
    if (tab.view.webContents.isDestroyed()) return this.getState()
    this.syncTabNavigation(tab)
    this.updateState()
    return this.getState()
  }

  async switchTab(id: string): Promise<BrowserState> {
    const externalTargetId = this.externalTargetId(id)
    if (externalTargetId && this.external) {
      const target = (await listTargets(this.external.port)).find(
        (t) => t.id === externalTargetId && !!t.webSocketDebuggerUrl
      )
      if (!target) throw new Error('找不到浏览器标签页')
      await this.attachExternalTarget(target)
      this.activeMode = 'external'
      this.hideOwnedViews()
      this.updateState()
      return this.getState()
    }
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('找不到浏览器标签页')
    this.activeMode = 'embedded'
    this.activeTabId = id
    this.showOnlyOwnedView(id)
    this.updateState()
    return this.getState()
  }

  async closeTab(id = this.activeTabId ?? '', options: { silent?: boolean } = {}): Promise<BrowserState> {
    const externalTargetId = this.externalTargetId(id)
    if (externalTargetId && this.external) {
      const ext = this.external
      const targetId = externalTargetId
      await closeCdpTarget(ext.port, targetId)
      if (targetId === ext.targetId) {
        let remaining: CdpTarget | undefined
        try {
          remaining = (await listTargets(ext.port)).find((t) => t.type === 'page' && !!t.webSocketDebuggerUrl)
        } catch {
          remaining = undefined
        }
        if (remaining) await this.attachExternalTarget(remaining)
        else return this.closeExternalChrome()
      } else {
        await this.syncExternalTabs()
      }
      this.updateState()
      return this.getState()
    }
    const tab = this.tabs.get(id)
    if (!tab) return this.getState()
    const transfer = this.hostTransfers.get(id)
    if (transfer) {
      this.hostTransfers.delete(id)
      tab.borrowedBy = undefined
      try {
        transfer.revoke('tab-closed')
      } catch {
      }
    }
    this.detachViewFromAllWindows(tab.view)
    tab.observer.dispose()
    this.siteGate()?.forgetSession(tab.id)
    await tab.cdp.detach().catch(() => undefined)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    const priorIndex = [...this.tabs.keys()].indexOf(id)
    this.tabs.delete(id)
    if (this.activeTabId === id) {
      const remaining = [...this.tabs.values()]
      const next = remaining[Math.min(Math.max(0, priorIndex), remaining.length - 1)]
      this.activeTabId = next?.id ?? null
      this.showOnlyOwnedView(this.activeTabId)
    }
    if (!options.silent) this.updateState()
    return this.getState()
  }

  async close(): Promise<BrowserState> {
    const ids = [...this.tabs.keys()]
    for (const id of ids) await this.closeTab(id, { silent: true })
    await this.closeExternalChrome()
    this.userControl = false
    this.nativeBounds = undefined
    this.viewVisibleRequested = false
    this.stateFlush.cancel()
    this.updateState()
    return this.getState()
  }

  beginHostTransfer(request: BrowserHostTransferRequest): BrowserHostTransferResult {
    const tab = this.tabs.get(request.tabId)
    if (!tab) return { ok: false, code: 'not-found', message: '找不到浏览器标签页' }
    if (tab.view.webContents.isDestroyed()) return { ok: false, code: 'destroyed', message: '浏览器标签页已销毁' }
    const existing = this.hostTransfers.get(tab.id)
    if (existing && existing.ownerKey !== request.ownerKey) {
      return { ok: false, code: 'owner-conflict', message: '该标签页已借给其它归属，不能抢占' }
    }
    if (tab.borrowedBy !== request.ownerKey) tab.view.setVisible(false)
    tab.borrowedBy = request.ownerKey
    const transfer: BrowserHostTransfer = {
      tabId: tab.id,
      ownerKey: request.ownerKey,
      generation: request.generation,
      webContentsId: tab.view.webContents.id,
      view: tab.view,
      sourceWindow: this.getWindow(),
      navigate: (url) => this.navigateTransferredTab(tab.id, request.ownerKey, request.generation, url),
      closeTab: async () => {
        await this.closeTab(tab.id)
      }
    }
    this.hostTransfers.set(tab.id, {
      ownerKey: request.ownerKey,
      generation: request.generation,
      transfer,
      revoke: request.onRevoke
    })
    return { ok: true, code: 'ok', transfer }
  }

  endHostTransfer(tabId: string, ownerKey: string): boolean {
    const record = this.hostTransfers.get(tabId)
    if (!record || record.ownerKey !== ownerKey) return false
    this.hostTransfers.delete(tabId)
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.borrowedBy = undefined
      this.parkTransferredView(tab)
    }
    return true
  }

  private async navigateTransferredTab(
    tabId: string,
    ownerKey: string,
    generation: number,
    raw: string
  ): Promise<BrowserActionResult> {
    const record = this.hostTransfers.get(tabId)
    const tab = this.tabs.get(tabId)
    if (!record || record.ownerKey !== ownerKey || record.generation !== generation || !tab) {
      return { ok: false, error: '标签页已归还主窗口' }
    }
    if (tab.view.webContents.isDestroyed()) return { ok: false, error: '标签页已关闭' }
    const url = safeUrl(raw)
    if (!url) return { ok: false, error: '只允许打开 http(s) 网页' }
    if (url !== tab.view.webContents.getURL()) {
      tab.state.url = url
      tab.state.title = ''
      tab.state.loading = true
      tab.pendingMainFrameUrl = url
      this.updateState()
      await tab.view.webContents.loadURL(url).catch(() => undefined)
    }
    if (tab.view.webContents.isDestroyed()) return { ok: false, error: '标签页已关闭' }
    this.syncTabNavigation(tab)
    this.updateState()
    return { ok: true }
  }

  private showOnlyOwnedView(activeId: string | null): void {
    for (const tab of this.tabs.values()) {
      if (tab.borrowedBy) continue
      tab.view.setVisible(ownedViewVisible(activeId, tab.id, this.viewVisibleRequested))
    }
  }

  private hideOwnedViews(): void {
    for (const tab of this.tabs.values()) {
      if (tab.borrowedBy) continue
      tab.view.setVisible(false)
    }
  }

  private detachViewFromAllWindows(view: WebContentsView): void {
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (candidate.isDestroyed()) continue
      if (candidate.contentView.children.includes(view)) candidate.contentView.removeChildView(view)
    }
  }

  private parkTransferredView(tab: BrowserTab): void {
    if (tab.view.webContents.isDestroyed()) return
    this.detachViewFromAllWindows(tab.view)
    const win = this.getWindow()
    if (win && !win.isDestroyed() && !win.contentView.children.includes(tab.view)) {
      win.contentView.addChildView(tab.view)
    }
    tab.view.setVisible(false)
  }

  async navigate(raw: string): Promise<BrowserActionResult> {
    const url = safeUrl(raw)
    if (!url) return { ok: false, error: '只允许打开 http(s) 网页' }
    try {
      if (this.external && this.activeMode === 'external') await this.navigateExternal(url)
      else await this.open(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async back(): Promise<BrowserActionResult> {
    if (this.external && this.activeMode === 'external') return this.externalHistory(-1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoBack()) return { ok: false, error: '没有可返回的页面' }
    tab.view.webContents.goBack()
    return { ok: true }
  }

  async forward(): Promise<BrowserActionResult> {
    if (this.external && this.activeMode === 'external') return this.externalHistory(1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoForward()) return { ok: false, error: '没有可前进的页面' }
    tab.view.webContents.goForward()
    return { ok: true }
  }

  async reload(): Promise<BrowserActionResult> {
    if (this.external && this.activeMode === 'external') {
      try {
        this.external.registry.clear()
        await this.external.cdp.send('Page.reload', {})
        await this.syncExternalHistory()
        this.updateState()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    const tab = this.activeTab()
    if (!tab) return { ok: false, error: '浏览器尚未打开' }
    tab.registry.clear()
    tab.view.webContents.reload()
    return { ok: true }
  }

  openExternal(raw?: string): BrowserActionResult {
    const tab = this.activeTab()
    const value = raw && raw.trim() ? raw.trim() : tab?.state.url ?? ''
    const url = safeUrl(value)
    if (!url || url === 'about:blank') return { ok: false, error: '没有可打开的外部地址' }
    void shell.openExternal(url).catch((error) => {
      this.pushError(`无法用系统浏览器打开：${error instanceof Error ? error.message : String(error)}`)
    })
    return { ok: true }
  }

  async openExternalChrome(rawUrl?: string): Promise<BrowserActionResult> {
    if (this.externalOpening) return this.externalOpening
    const opening = this.openExternalChromeImpl(rawUrl)
    this.externalOpening = opening
    try {
      return await opening
    } finally {
      if (this.externalOpening === opening) this.externalOpening = null
    }
  }

  private async openExternalChromeImpl(rawUrl?: string): Promise<BrowserActionResult> {
    const url = safeUrl(rawUrl ?? this.activeTab()?.state.url ?? INITIAL_URL)
    if (!url) return { ok: false, error: '只允许打开 http(s) 网页' }
    if (this.external) {
      this.activeMode = 'external'
      await this.navigateExternal(url)
      return { ok: true }
    }

    const port = await pickFreePort()
    const profileDir = defaultProfileDir(YAN_DIR)
    let chrome: ChildProcess | null = null
    try {
      await mkdir(profileDir, { recursive: true })
      const syncReport = await this.profileSyncReport(profileDir)
      chrome = launchChrome({
        profileDir,
        port,
        url,
        headless: process.env.YAN_CHROME_HEADLESS === '1'
      })
      await waitForCdp(port, 20_000)
      const page = pickPageTarget(await listTargets(port))
      if (!page?.webSocketDebuggerUrl) throw new Error('Chrome 已启动，但没有可调试的页面目标')

      const cdp = new RawCdp(page.webSocketDebuggerUrl)
      await cdp.attach()
      const registry = new ElementRegistry()
      await this.enableExternalBoundary(cdp)
      await this.setupExternalDownloads(cdp)
      this.external = {
        cdp,
        registry,
        observer: new Observer(cdp, registry),
        input: new InputController(cdp),
        network: new NetworkTracker(cdp),
        chrome,
        port,
        profileDir,
        targetId: page.id,
        url: page.url || url,
        title: page.title || '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        chromeTabs: [],
        syncReport
      }
      void this.external.network.start()
      this.activeMode = 'external'
      this.hideOwnedViews()
      chrome.once('exit', () => {
        if (this.external?.chrome === chrome) void this.closeExternalChrome()
      })
      this.userControl = false
      await this.syncExternalTabs()
      await this.syncExternalHistory()
      this.updateState()
      return { ok: true }
    } catch (error) {
      stopChrome(chrome)
      this.external = null
      this.updateState()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async setupExternalDownloads(cdp: RawCdp): Promise<void> {
    const directory = app.getPath('downloads')
    try {
      await mkdir(directory, { recursive: true })
      try {
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: directory,
          eventsEnabled: true
        })
      } catch {
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory })
      }
    } catch (error) {
      this.pushError(`外部 Chrome 下载监听未能启用：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    cdp.on('Browser.downloadWillBegin', (params) => {
      const guid = String(params.guid ?? '')
      const name = String(params.suggestedFilename ?? '')
      const url = String(params.url ?? '')
      if (guid && name) this.externalDownloads.set(guid, { filename: name, url })
    })
    cdp.on('Browser.downloadProgress', (params) => {
      if (String(params.state ?? '') !== 'completed') return
      const guid = String(params.guid ?? '')
      const begun = this.externalDownloads.get(guid)
      const filename = (begun?.filename ?? `download-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '') || `download-${Date.now()}`
      this.externalDownloads.delete(guid)
      const size = Number(params.receivedBytes ?? 0)
      this.lastDownload = {
        path: join(directory, filename),
        filename,
        size: Number.isFinite(size) && size > 0 ? size : undefined,
        source: begun?.url || undefined
      }
      this.updateState()
    })
  }

  async syncLocalProfile(): Promise<ChromeSyncReport> {
    if (this.external) {
      const embedded = this.activeTab()
      if (!embedded) throw new Error('请先打开内置浏览器页面，再复制 Cookie')
      const fromChrome = this.activeMode === 'external'
      const result = await transferCookies(
        fromChrome ? this.external.cdp : embedded.cdp,
        fromChrome ? embedded.cdp : this.external.cdp
      )
      const report: ChromeSyncReport = {
        found: true, chromeRunning: true, cookiesSynced: result.failed === 0,
        source: fromChrome ? 'Chrome' : '内置浏览器',
        target: fromChrome ? '内置浏览器' : 'Chrome',
        copied: [`Cookies: ${result.copied}`],
        failed: result.failed ? [{ item: 'Cookies', reason: `${result.failed} 项未能复制` }] : []
      }
      this.external.syncReport = report
      this.updateState()
      return report
    }
    const profileDir = defaultProfileDir(YAN_DIR)
    await mkdir(profileDir, { recursive: true })
    const report = await syncLocalChromeData(profileDir)
    return report
  }

  async syncPageStorage(): Promise<ChromeSyncReport> {
    if (!this.external) throw new Error('请先接入本机 Chrome')
    const embedded = this.activeTab()
    if (!embedded) throw new Error('请先打开内置浏览器页面，再复制当前页面存储')
    const externalUrl = safeUrl(this.external.url)
    const embeddedUrl = safeUrl(embedded.state.url)
    if (!externalUrl || !embeddedUrl || externalUrl === 'about:blank' || embeddedUrl === 'about:blank') throw new Error('两个页面都需要先打开 http(s) 网站，才能复制当前页面存储')
    if (new URL(externalUrl).origin !== new URL(embeddedUrl).origin) throw new Error('两个页面必须处于同一网站，才能复制当前页面存储')
    const from = this.activeMode === 'external' ? this.external.cdp : embedded.cdp
    const to = this.activeMode === 'external' ? embedded.cdp : this.external.cdp
    const results = await Promise.all([transferPageStorage(from, to, 'localStorage'), transferPageStorage(from, to, 'sessionStorage')])
    const report: ChromeSyncReport = { found: true, chromeRunning: true, cookiesSynced: false, source: this.activeMode === 'external' ? 'Chrome 当前页面' : '内置浏览器当前页面', target: this.activeMode === 'external' ? '内置浏览器当前页面' : 'Chrome 当前页面', copied: results.map((r) => `${r.kind}: ${r.copied}`), failed: results.flatMap((r) => r.failed ? [{ item: r.kind, reason: `${r.failed} 项未能复制` }] : []) }
    this.external.syncReport = report
    this.updateState()
    return report
  }

  async closeExternalChrome(): Promise<BrowserState> {
    const ext = this.external
    if (!ext) return this.getState()
    this.external = null
    this.externalDownloads.clear()
    this.externalBoundaryCdp = null
    this.externalPendingUrl = ''
    ext.observer.dispose()
    await ext.cdp.detach().catch(() => undefined)
    stopChrome(ext.chrome)
    this.activeMode = 'embedded'
    const active = this.activeTab()
    this.showOnlyOwnedView(active?.id ?? null)
    this.userControl = false
    this.updateState()
    return this.getState()
  }

  private async attachExternalTarget(target: CdpTarget): Promise<void> {
    if (!this.external || !target.webSocketDebuggerUrl) return
    const ext = this.external
    const previousCdp = ext.cdp
    const previousObserver = ext.observer
    const cdp = new RawCdp(target.webSocketDebuggerUrl)
    await cdp.attach()
    const registry = new ElementRegistry()
    ext.cdp = cdp
    ext.registry = registry
    ext.observer = new Observer(cdp, registry)
    ext.input = new InputController(cdp)
    ext.network = new NetworkTracker(cdp)
    void ext.network.start()
    previousObserver.dispose()
    ext.targetId = target.id
    ext.url = target.url
    ext.title = target.title
    await previousCdp.detach().catch(() => undefined)
    await this.enableExternalBoundary(cdp)
    await this.setupExternalDownloads(cdp)
    await this.syncExternalTabs()
    await this.syncExternalHistory()
    this.updateState()
  }

  private async syncExternalHistory(): Promise<void> {
    const ext = this.external
    if (!ext) return
    try {
      const history = await ext.cdp.send<{ currentIndex: number; entries: unknown[] }>(
        'Page.getNavigationHistory'
      )
      ext.canGoBack = history.currentIndex > 0
      ext.canGoForward = history.currentIndex < history.entries.length - 1
    } catch {
    }
  }

  private async syncExternalTabs(): Promise<void> {
    const ext = this.external
    if (!ext) return
    try {
      ext.chromeTabs = (await listTargets(ext.port))
        .filter((t) => t.type === 'page' && !!t.webSocketDebuggerUrl)
        .map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          loading: false,
          canGoBack: false,
          canGoForward: false
        }))
    } catch {
    }
  }

  private async navigateExternal(url: string): Promise<void> {
    const ext = this.external
    if (!ext) return
    ext.loading = true
    this.externalPendingUrl = url
    this.updateState()
    try {
      await ext.cdp.send('Page.navigate', { url })
      ext.url = url
      await this.syncExternalHistory()
    } finally {
      if (this.external === ext) {
        ext.loading = false
        this.updateState()
      }
    }
  }

  private async enableExternalBoundary(cdp: RawCdp): Promise<void> {
    if (this.externalBoundaryCdp === cdp) return
    this.externalBoundaryCdp = cdp
    cdp.on('Fetch.requestPaused', (params) => {
      void this.handleExternalRequest(cdp, params)
    })
    try {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    } catch (error) {
      this.pushError(`外部 Chrome 的网络边界未能启用：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleExternalRequest(cdp: RawCdp, params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '')
    if (!requestId) return
    const request = (params.request ?? {}) as { url?: unknown }
    const url = String(request.url ?? '')
    const resourceType = String(params.resourceType ?? '')
    const pageUrl = this.external?.url ?? ''
    const decision = decideExternalRequest({
      url,
      resourceType,
      pageUrl,
      requestedByUs: Boolean(this.externalPendingUrl) && this.externalPendingUrl === url
    })
    let blocked = decision === 'block-private'
    if (decision === 'check-dns') {
      try {
        blocked = await this.privateDns.resolves(new URL(url).hostname)
      } catch {
        blocked = false
      }
    }
    try {
      if (blocked) {
        await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        try {
          this.recordBlockedRequest(new URL(url).hostname, 'private-host', pageUrl)
        } catch {
        }
        return
      }
      await cdp.send('Fetch.continueRequest', { requestId })
    } catch {
    }
  }

  private async profileSyncReport(profileDir: string): Promise<ChromeSyncReport | undefined> {
    if (existsSync(join(profileDir, 'Local State'))) return undefined
    const approved = await this.approveProfileSync().catch(() => false)
    if (!approved) return undefined
    return syncLocalChromeData(profileDir)
  }

  private async externalHistory(delta: 1 | -1): Promise<BrowserActionResult> {
    const ext = this.external
    if (!ext) return { ok: false, error: '外部浏览器未接入' }
    try {
      const history = await ext.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
        'Page.getNavigationHistory'
      )
      const index = history.currentIndex + delta
      if (index < 0 || index >= history.entries.length) {
        return { ok: false, error: delta < 0 ? '没有可返回的页面' : '没有可前进的页面' }
      }
      await ext.cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[index].id })
      await this.syncExternalHistory()
      this.updateState()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  setViewVisible(visible: boolean): void {
    this.viewVisibleRequested = visible
    if (!visible) {
      this.hideOwnedViews()
      return
    }
    if (this.activeMode !== 'embedded') return
    this.showOnlyOwnedView(this.activeTabId)
  }

  setBounds(bounds: BrowserBounds): void {
    if (this.external && this.activeMode === 'external') return
    const tab = this.activeTab()
    if (!tab || !this.state.open) return
    if (tab.borrowedBy) return
    const win = this.getWindow()
    const zoom = win && !win.isDestroyed() ? win.webContents.getZoomFactor() || 1 : 1
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every((value) => typeof value === 'number' && Number.isFinite(value))) return
    const clean = {
      x: Math.max(0, Math.round(bounds.x * zoom)),
      y: Math.max(0, Math.round(bounds.y * zoom)),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom))
    }
    this.nativeBounds = clean
    tab.view.setBounds(clean)
  }

  async dispose(): Promise<void> {
    await this.close()
  }

  async observe(): Promise<BrowserObservation> {
    const p = this.parts()
    if (!p) throw new Error('浏览器尚未打开')
    return this.observeTarget(p)
  }

  private async observeTarget(p: TargetParts): Promise<BrowserObservation> {
    const tab = [...this.tabs.values()].find((candidate) => candidate.cdp === p.cdp)
    const external = this.external?.observer === p.observer ? this.external : null
    if (!tab && !external) throw new Error('浏览器目标已失效，请重新 observe')
    await p.cdp.attach()
    if (external) {
      const observation = await p.observer.capture(external.url, external.title)
      if (this.external?.observer === p.observer) {
        external.url = observation.url
        external.title = observation.title
        await this.syncExternalHistory()
        await this.syncExternalTabs()
        this.updateState()
      }
      return observation
    }
    return p.observer.capture(tab!.state.url, tab!.state.title)
  }

  async network(): Promise<BrowserNetworkSnapshot> {
    const p = this.parts()
    if (!p) throw new Error('浏览器尚未打开')
    await p.network.start()
    return p.network.snapshot()
  }

  async click(ref: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      const element = p.registry.resolve(ref)
      const policy = this.policy.checkAction('click', `${element.role} ${element.name}`)
      if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
      await p.input.click(element)
      await this.waitForPage()
      return { ok: true, observation: await this.observeTarget(p) }
    } catch (error) {
      return this.actionError(error)
    }
  }

  async type(ref: string, text: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      const element = p.registry.resolve(ref)
      const policy = this.policy.checkAction('type', `${element.role} ${element.name}`)
      if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
      await p.input.type(element, text)
      await this.waitForPage()
      return { ok: true, observation: await this.observeTarget(p) }
    } catch (error) {
      return this.actionError(error)
    }
  }

  async press(key: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    const policy = this.policy.checkAction(key.trim().toLowerCase() === 'enter' ? 'submit' : 'press', key)
    if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
    try {
      await p.input.press(key)
      await this.waitForPage()
      return { ok: true, observation: await this.observeTarget(p) }
    } catch (error) {
      return this.actionError(error)
    }
  }

  async select(ref: string, value: string): Promise<BrowserActionResult & { observation?: BrowserObservation; chosen?: SelectOutcome }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      const element = p.registry.resolve(ref)
      const policy = this.policy.checkAction('select', `${element.role} ${element.name}`)
      if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
      const outcome = await p.input.select(element, value)
      await this.waitForPage()
      return { ok: true, chosen: outcome, observation: await this.observeTarget(p) }
    } catch (error) {
      return this.actionError(error)
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      await p.input.scroll(deltaX, deltaY)
      return { ok: true, observation: await this.observeTarget(p) }
    } catch (error) {
      return this.actionError(error)
    }
  }

  requestUserControl(): BrowserState {
    this.userControl = true
    this.updateState()
    return this.getState()
  }

  async screenshot(): Promise<{ mimeType: string; data: Buffer }> {
    const p = this.parts()
    if (!p) throw new Error('浏览器尚未打开')
    return { mimeType: 'image/png', data: await p.cdp.screenshot() }
  }

  setUserControl(value: boolean): BrowserState {
    this.userControl = value
    this.updateState()
    return this.getState()
  }

  setPermission(permission: string, origin: string, allowed: boolean): BrowserActionResult {
    const name = typeof permission === 'string' ? permission.trim() : ''
    const normalizedOrigin = normalizePermissionOrigin(origin)
    if (!name) return { ok: false, error: '权限名称不能为空' }
    if (!normalizedOrigin) return { ok: false, error: '权限只接受 http/https origin' }
    const key = permissionKey(name, normalizedOrigin)
    if (allowed) this.permissionGrants.add(key)
    else this.permissionGrants.delete(key)
    this.recordPermission(name, normalizedOrigin, allowed ? 'allowed' : 'blocked')
    this.updateState()
    return { ok: true }
  }

  private recordPermission(permission: string, origin: string, status: BrowserPermissionRecord['status']): void {
    const at = Date.now()
    const index = this.permissionLog.findIndex((item) => item.permission === permission && item.origin === origin)
    const next = { permission, origin, status, at }
    if (index >= 0) this.permissionLog[index] = next
    else this.permissionLog.push(next)
    if (this.permissionLog.length > 40) this.permissionLog.splice(0, this.permissionLog.length - 40)
  }

  private recordBlockedRequest(
    rawHost: string,
    reason: BrowserBlockedRequest['reason'],
    fromUrl: string
  ): void {
    const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (!host) return
    let from = ''
    try {
      from = new URL(fromUrl).hostname
    } catch {
      from = ''
    }
    const index = this.blockedRequests.findIndex((item) => item.host === host && item.reason === reason)
    if (index >= 0) {
      const previous = this.blockedRequests[index]
      this.blockedRequests[index] = { ...previous, from, at: Date.now(), count: previous.count + 1 }
    } else {
      this.blockedRequests.push({ host, reason, from, at: Date.now(), count: 1 })
    }
    if (this.blockedRequests.length > 20) {
      this.blockedRequests.splice(0, this.blockedRequests.length - 20)
    }
    this.stateFlush.schedule()
  }

  private resolvesToPrivateTarget(hostname: string): Promise<boolean> {
    return this.privateDns.resolves(hostname)
  }

  private actionError(error: unknown): BrowserActionResult {
    const message = error instanceof Error ? error.message : String(error)
    if (/detached|Could not find node|No node with given id|Cannot find context/i.test(message)) {
      return { ok: false, code: 'STALE_ELEMENT', error: `元素引用已失效，请重新调用 yan browser observe。（${message}）` }
    }
    if (error && typeof error === 'object' && 'code' in error) {
      const typed = error as { code: string; message: string }
      return { ok: false, code: typed.code, error: typed.message }
    }
    return { ok: false, error: message }
  }

  private async waitForPage(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  private async handleDownload(item: Electron.DownloadItem, owner?: string): Promise<void> {
    const directory = app.getPath('downloads')
    const filename = item.getFilename().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `download-${Date.now()}`
    const path = join(directory, `${randomUUID()}-${filename}`)
    const origin = item.getURL()
    mkdirSync(directory, { recursive: true })
    item.setSavePath(path)
    item.once('done', (_event, state) => {
      if (state !== 'completed') return
      this.lastDownload = { path, filename, size: item.getReceivedBytes(), source: origin }
      if (owner) {
        this.ownedDownloads.delete(owner)
        this.ownedDownloads.set(owner, this.lastDownload)
        while (this.ownedDownloads.size > 50) this.ownedDownloads.delete(this.ownedDownloads.keys().next().value!)
      }
      this.updateState()
    })
  }

  private pushError(detail: string): void {
    this.push({ ch: 'notify', payload: { id: `browser-${Date.now()}`, method: 'notify', notifyType: 'error', message: detail } })
  }
}
