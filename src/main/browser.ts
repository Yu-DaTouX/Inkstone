import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { app, shell, BrowserWindow, View, WebContentsView } from 'electron'
import { cp, mkdir } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  BrowserBlockedRequest,
  BrowserBounds,
  BrowserViewport,
  BrowserNetworkSnapshot,
  BrowserObservation,
  BrowserPermissionRecord,
  BrowserState,
  BrowserTabState,
  BrowserLoginImport,
  BrowserLoginImportStatus,
  MainPush
} from '../shared/ipc'
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
import { createCookieBridge, writeBridgeCookies, type BridgeCookie } from './browser/cookie-bridge'
import type { BrowserActionOptions, BrowserActionReceipt, BrowserDialogRecord } from './browser/receipt'
import { SCRIPT_GUIDE, ScriptError, runBrowserScript, type ScriptResult } from './browser/script-runner'
import { transferCookies } from './browser/cookie-transfer'
import { transferPageStorage } from './browser/storage-transfer'
import { PrivateDnsGuard } from './browser/network-policy'
import { isForbiddenOrigin, normalizeSiteOrigin } from './preview-site-access'
import { decideRequestBoundary } from './browser/network-boundary'
import { decideExternalRequest } from './browser/external-boundary'
import { createStateFlush, ownedViewVisible } from './browser/host-state'
import { pick } from '../shared/ui-lang'

type Push = (msg: MainPush) => void
type BrowserActionResult = { ok: boolean; error?: string; code?: string }
type BrowserActionOutcome = BrowserActionResult & { observation?: BrowserObservation; receipt?: BrowserActionReceipt }
const INITIAL_URL = 'about:blank'
const PROMPT_TOKEN = `yan-prompt-${randomBytes(6).toString('hex')}:`
const PROMPT_SHIM = `(() => { if (window.__yanPromptShim) return; Object.defineProperty(window, '__yanPromptShim', { value: true }); const log = console.debug.bind(console); window.prompt = function (message) { try { log(${JSON.stringify(PROMPT_TOKEN)} + String(message === undefined ? '' : message)) } catch {} return null } })()`
export const DOWNLOAD_CONFIRM_BYTES = 100 * 1024 * 1024

export interface LargeDownload {
  filename: string
  bytes: number
  source: string
}
const HIDDEN_LAYOUT_SIZE = { width: 1280, height: 800 }
const HIDDEN_LAYOUT_MIN_WIDTH = 320
const HIDDEN_LAYOUT_MIN_HEIGHT = 240
const HIDDEN_LAYOUT_TIMEOUT_MS = 1_500
const HIDDEN_PAINT_TIMEOUT_MS = 500
const HIDDEN_PAINT_SCRIPT = 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

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
  sessionId: string
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
  dialogs: BrowserDialogRecord[]
  dialogPolicy?: BrowserActionOptions
  acting?: boolean
  emulatedKey?: string
  mobileUa?: boolean
  loadedUa?: string
  uaReloadTimer?: ReturnType<typeof setTimeout>
}

const NARROW_ENTER_PX = 600
const NARROW_EXIT_PX = 640
const UA_RELOAD_DELAY_MS = 600

const VIEWPORT_PRESETS: Partial<Record<BrowserViewport, { width: number; height: number }>> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
}

function isBrowserViewport(value: unknown): value is BrowserViewport {
  return value === 'responsive' || value === 'mobile' || value === 'tablet' || value === 'desktop'
}

function mobileUserAgent(): string {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '140.0.0.0'} Mobile Safari/537.36`
}

export interface ViewportFit extends BrowserBounds {
  scale: number
  emulated: { width: number; height: number } | null
}

export function viewportRect(pane: BrowserBounds, viewport: BrowserViewport): ViewportFit {
  const preset = VIEWPORT_PRESETS[viewport]
  if (!preset) return { ...pane, scale: 1, emulated: null }
  const scale = Math.min(1, pane.width / preset.width)
  const width = Math.max(1, Math.min(pane.width, Math.round(preset.width * scale)))
  const emulatedHeight = Math.max(1, Math.round(pane.height / scale))
  return { x: pane.x + Math.round((pane.width - width) / 2), y: pane.y, width, height: pane.height, scale, emulated: { width: preset.width, height: emulatedHeight } }
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

type BrowserTransferRevokeReason = 'tab-closed' | 'controller-disposed'
type BrowserTransferView = WebContentsView
type BrowserTransferWindow = BrowserWindow

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
  private focusSessionId = 'workspace'
  private viewerSessionId = 'workspace'
  private readonly activeBySession = new Map<string, string | null>()
  private get activeTabId(): string | null {
    return this.activeBySession.get(this.focusSessionId) ?? null
  }
  private set activeTabId(id: string | null) {
    this.activeBySession.set(this.focusSessionId, id)
  }
  forSession(sessionId: string): this {
    if (sessionId && sessionId !== this.focusSessionId) {
      this.focusSessionId = sessionId
      this.updateState()
    }
    return this
  }
  userSession(sessionId?: string): this {
    const target = sessionId || this.viewerSessionId
    const changed = target !== this.focusSessionId || target !== this.viewerSessionId
    this.viewerSessionId = target
    this.focusSessionId = target
    if (changed) this.showOnlyOwnedView(this.activeTabId)
    return this
  }
  activateSession(sessionId: string): BrowserState {
    this.viewerSessionId = sessionId
    if (!this.agentSessionId || this.agentSessionId === sessionId) this.focusSessionId = sessionId
    this.showOnlyOwnedView(this.activeBySession.get(this.focusSessionId) ?? null)
    this.updateState()
    return this.getState(sessionId)
  }
  private userControl = false
  private userControlRequest: { reason: string; sessionId: string; at: number } | null = null
  private lastDownload: BrowserState['lastDownload']
  private automationOwner?: string
  private readonly ownedDownloads = new Map<string, NonNullable<BrowserState['lastDownload']>>()
  setAutomationOwner(owner?: string): void { this.automationOwner = owner }
  private agentSessionId: string | undefined
  setAgentSession(sessionId: string): void {
    if (this.agentSessionId === sessionId) return
    this.agentSessionId = sessionId
    this.updateState()
  }
  getOwnedDownload(owner: string): BrowserState['lastDownload'] { return this.ownedDownloads.get(owner) }
  private downloadStarted: { name: string; at: number } | null = null
  private readonly downloadsInProgress = new Map<Electron.DownloadItem, string>()
  pendingDownloads(): string[] { return [...this.downloadsInProgress.values()] }
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
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly push: Push,
    private readonly approveProfileSync: () => Promise<boolean> = async () => false,
    private readonly approveLargeDownload: (download: LargeDownload) => Promise<boolean> = async () => false
  ) {}

  private loginImport?: Awaited<ReturnType<typeof createCookieBridge>>
  private loginImportStarting = false

  private loginImportExtensionPath(): string {
    return join(YAN_DIR, 'browser-cookie-bridge')
  }

  private async showLoginImportExtension(): Promise<void> {
    const error = await shell.openPath(this.loginImportExtensionPath())
    if (error) throw new Error(pick('无法打开扩展目录', 'Cannot open the extensions folder'))
  }

  async startLoginImport(): Promise<{ id: string }> {
    if (this.loginImportStarting || this.loginImport?.status().phase === 'importing') throw new Error(pick('登录态正在写入，请稍后再试', 'Sign-in data is being written; try again shortly'))
    this.loginImportStarting = true
    try {
      if (this.loginImport?.status().phase !== 'waiting') {
        const source = app.isPackaged ? join(process.resourcesPath, 'browser-cookie-bridge') : join(app.getAppPath(), 'resources', 'browser-cookie-bridge')
        await cp(source, this.loginImportExtensionPath(), { recursive: true, force: true })
        this.loginImport = await createCookieBridge({
          extensionPath: this.loginImportExtensionPath(),
          showExtension: () => this.showLoginImportExtension(),
          receive: (cookies) => this.receiveLoginCookies(cookies)
        })
      }
      try { await shell.openExternal(this.loginImport.url) } catch { this.loginImport.cancel(); throw new Error(pick('无法打开来源浏览器', 'Cannot open the source browser')) }
      return { id: this.loginImport.id }
    } finally { this.loginImportStarting = false }
  }

  loginImportStatus(id: string): BrowserLoginImportStatus {
    if (!this.loginImport || this.loginImport.id !== id) return { id, phase: 'cancelled' }
    return this.loginImport.status()
  }

  cancelLoginImport(id: string): BrowserLoginImportStatus {
    if (this.loginImport?.id === id) this.loginImport.cancel()
    return this.loginImportStatus(id)
  }

  private async receiveLoginCookies(cookies: BridgeCookie[]): Promise<BrowserLoginImport> {
    const view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'persist:yan-browser' } })
    try {
      await view.webContents.loadURL('about:blank')
      view.webContents.debugger.attach('1.3')
      return await writeBridgeCookies((method, params) => view.webContents.debugger.sendCommand(method, params), cookies)
    } finally {
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
      view.webContents.close()
    }
  }

  getState(sessionId: string = this.focusSessionId): BrowserState {
    const isFocus = sessionId === this.focusSessionId
    const ext = isFocus ? this.external : null
    const activeId = this.activeBySession.get(sessionId) ?? null
    const active = activeId ? this.tabs.get(activeId) ?? null : null
    const activeIsExternal = isFocus && this.activeMode === 'external' && Boolean(ext)
    const embeddedTabs = [...this.tabs.values()].filter((tab) => tab.sessionId === sessionId).map((tab) => ({ ...tab.state }))
    const externalTabs = ext ? ext.chromeTabs.map((tab) => ({ ...tab, id: this.externalTabId(tab.id) })) : []
    return {
      sessionId,
      open: Boolean(active) || Boolean(ext),
      url: activeIsExternal ? ext?.url ?? '' : active?.state.url ?? '',
      title: activeIsExternal ? ext?.title ?? '' : active?.state.title ?? '',
      loading: activeIsExternal ? ext?.loading ?? false : active?.state.loading ?? false,
      canGoBack: activeIsExternal ? ext?.canGoBack ?? false : active?.state.canGoBack ?? false,
      canGoForward: activeIsExternal ? ext?.canGoForward ?? false : active?.state.canGoForward ?? false,
      tabs: [...embeddedTabs, ...externalTabs],
      activeTabId: activeIsExternal ? this.externalTabId(ext!.targetId) : activeId ?? undefined,
      userControl: this.userControl,
      ...(this.userControl && this.userControlRequest ? { userControlRequest: this.userControlRequest } : {}),
      lastDownload: this.lastDownload,
      ...(this.agentSessionId ? { agentSessionId: this.agentSessionId } : {}),
      loadError: activeIsExternal ? undefined : active?.state.loadError,
      permissions: this.permissionLog,
      blockedRequests: this.blockedRequests,
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
    this.push({ ch: 'browser-state', payload: this.getState(this.viewerSessionId) })
    if (this.focusSessionId !== this.viewerSessionId) {
      this.push({ ch: 'browser-state', payload: this.getState(this.focusSessionId) })
    }
  }

  private updateState(): void {
    sharedResources.setPaused(INTERACTIVE_RESOURCE, this.userControl)
    this.publish()
  }

  private parts(): TargetParts | null {
    if (this.external && this.activeMode === 'external') return this.external
    const tab = this.activeTab()
    return tab ? { cdp: tab.cdp, registry: tab.registry, observer: tab.observer, input: tab.input, network: tab.network } : null
  }

  private createTab(sessionId: string = this.focusSessionId): BrowserTab {
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
      sessionId,
      view,
      cdp,
      registry,
      observer: new Observer(cdp, registry),
      input: new InputController(cdp),
      network: new NetworkTracker(cdp),
      state: { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
      committedUrl: '',
      pendingMainFrameUrl: null,
      openerUrl: '',
      dialogs: []
    }
    void tab.network.start()
    cdp.on('Page.javascriptDialogOpening', (params) => this.answerDialog(tab, params))
    view.webContents.on('dom-ready', () => {
      void view.webContents.executeJavaScript(PROMPT_SHIM, true).catch(() => undefined)
    })
    view.webContents.on('console-message', (details) => {
      const message = String((details as unknown as { message?: unknown }).message ?? '')
      if (!message.startsWith(PROMPT_TOKEN)) return
      tab.dialogs.push({ type: 'prompt', message: message.slice(PROMPT_TOKEN.length, PROMPT_TOKEN.length + 300), accepted: false, unsupported: true })
      if (tab.dialogs.length > 10) tab.dialogs.shift()
    })
    view.webContents.on('did-start-loading', () => {
      tab.state.loading = true
      tab.state.loadError = undefined
      this.updateState()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.state.loading = false
      tab.pendingMainFrameUrl = null
      this.syncTabProgress(tab)
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-finish-load', () => {
      void view.webContents.insertCSS('@media (max-width: 300px) { ::-webkit-scrollbar:horizontal { height: 0 !important; } }').catch(() => {})
    })
    view.webContents.on('did-navigate', (_event, url) => {
      tab.loadedUa = view.webContents.getUserAgent()
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
        void this.openBackgroundTab(target, tab.committedUrl || tab.openerUrl, tab.sessionId).catch((error) =>
          this.pushError(pick(`无法打开后台标签：${error instanceof Error ? error.message : String(error)}`, `Cannot open background tab: ${error instanceof Error ? error.message : String(error)}`))
        )
      }
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => this.guardNavigation(event, url))
    view.webContents.on('will-redirect', (event, url) => this.guardNavigation(event, url))
    view.webContents.debugger.on('message', (_event, method) => {
      if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated') {
        tab.registry.clear()
      }
    })
    if (!this.downloadSessionAttached) {
      try {
        view.webContents.session.on('will-download', (_event, item, contents) => {
          this.downloadStarted = { name: item.getFilename(), at: Date.now() }
          const owner = !this.userControl && this.activeMode !== 'external' && contents?.id === this.activeTab()?.view.webContents.id ? this.automationOwner : undefined
          void this.handleDownload(item, owner).catch((error) => {
            item.cancel()
            this.pushError(pick(`浏览器下载无法保存：${error instanceof Error ? error.message : String(error)}`, `Browser download cannot be saved: ${error instanceof Error ? error.message : String(error)}`))
          })
        })
        this.downloadSessionAttached = true
      } catch (error) {
        this.pushError(pick(`浏览器下载监听未能启用：${error instanceof Error ? error.message : String(error)}`, `Browser download listener failed to start: ${error instanceof Error ? error.message : String(error)}`))
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
        this.pushError(pick(`浏览器权限处理未能启用：${error instanceof Error ? error.message : String(error)}`, `Browser permission handling failed to start: ${error instanceof Error ? error.message : String(error)}`))
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
        this.pushError(pick(`浏览器网络边界未能启用：${error instanceof Error ? error.message : String(error)}`, `Browser network boundary failed to start: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    void cdp.attach().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (tab.view.webContents.isDestroyed() || /target closed|closed|destroyed/i.test(message)) return
      this.pushError(pick(`浏览器 CDP 启动失败：${message}`, `Browser CDP failed to start: ${message}`))
    })
    this.tabs.set(id, tab)
    return tab
  }

  private syncTabNavigation(tab: BrowserTab): void {
    tab.state.url = tab.view.webContents.getURL()
    this.syncTabProgress(tab)
  }

  private syncTabProgress(tab: BrowserTab): void {
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

  async openFromUser(url?: string, sessionId = 'workspace'): Promise<BrowserState> {
    const open = async (): Promise<BrowserState> => {
      if (this.activeTab()?.borrowedBy) throw new Error(pick('浏览器正在独立窗口中使用，请先归还后重试', 'The browser is in a separate window; return it first'))
      await this.open(url)
      this.agentSessionId = undefined
      this.updateState()
      return this.getState()
    }
    if (this.userControl) {
      const resource = sharedResources.snapshot().find(item => item.resourceId === INTERACTIVE_RESOURCE)
      if (resource?.owner || resource?.uncertain) throw new Error(pick('浏览器操作尚未结束，请稍后重试', 'A browser operation is still running; try again shortly'))
      return open()
    }
    return sharedResources.run(INTERACTIVE_RESOURCE, `browser-user:${sessionId}`, open)
  }

  async open(url = INITIAL_URL): Promise<BrowserState> {
    const next = safeUrl(url)
    if (!next) throw new Error(pick('只允许打开 http(s) 网页', 'Only http(s) pages can be opened'))
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

  private guardNavigation(event: { preventDefault(): void }, rawUrl: string): void {
    if (!safeUrl(rawUrl)) event.preventDefault()
  }

  private async openBackgroundTab(rawUrl: string, openerUrl: string, sessionId: string): Promise<void> {
    const url = safeUrl(rawUrl)
    if (!url) return
    const tab = this.createTab(sessionId)
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
    if (!url) throw new Error(pick('只允许打开 http(s) 网页', 'Only http(s) pages can be opened'))
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
      if (!target) throw new Error(pick('找不到浏览器标签页', 'Browser tab not found'))
      await this.attachExternalTarget(target)
      this.activeMode = 'external'
      this.hideOwnedViews()
      this.updateState()
      return this.getState()
    }
    const tab = this.tabs.get(id)
    if (!tab) throw new Error(pick('找不到浏览器标签页', 'Browser tab not found'))
    this.activeMode = 'embedded'
    this.activeBySession.set(tab.sessionId, id)
    this.showOnlyOwnedView(this.activeTabId)
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
    await tab.cdp.detach().catch(() => undefined)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    const sameSession = [...this.tabs.values()].filter((candidate) => candidate.sessionId === tab.sessionId)
    const priorIndex = sameSession.indexOf(tab)
    this.tabs.delete(id)
    if (this.activeBySession.get(tab.sessionId) === id) {
      const remaining = sameSession.filter((candidate) => candidate !== tab)
      const next = remaining[Math.min(Math.max(0, priorIndex), remaining.length - 1)]
      this.activeBySession.set(tab.sessionId, next?.id ?? null)
      this.showOnlyOwnedView(this.activeTabId)
    }
    if (!options.silent) this.updateState()
    return this.getState()
  }

  async closeSession(sessionId: string): Promise<BrowserState> {
    const ids = [...this.tabs.values()].filter((tab) => tab.sessionId === sessionId).map((tab) => tab.id)
    for (const id of ids) await this.closeTab(id, { silent: true })
    this.activeBySession.delete(sessionId)
    if (this.focusSessionId === sessionId) await this.closeExternalChrome()
    this.updateState()
    return this.getState(sessionId)
  }

  async close(): Promise<BrowserState> {
    const ids = [...this.tabs.keys()]
    for (const id of ids) await this.closeTab(id, { silent: true })
    await this.closeExternalChrome()
    this.userControl = false
    this.agentSessionId = undefined
    this.viewVisibleRequested = false
    this.stateFlush.cancel()
    this.updateState()
    return this.getState()
  }

  beginHostTransfer(request: BrowserHostTransferRequest): BrowserHostTransferResult {
    const tab = this.tabs.get(request.tabId)
    if (!tab) return { ok: false, code: 'not-found', message: pick('找不到浏览器标签页', 'Browser tab not found') }
    if (tab.view.webContents.isDestroyed()) return { ok: false, code: 'destroyed', message: pick('浏览器标签页已销毁', 'Browser tab was destroyed') }
    const existing = this.hostTransfers.get(tab.id)
    if (existing && existing.ownerKey !== request.ownerKey) {
      return { ok: false, code: 'owner-conflict', message: pick('该标签页已借给其它归属，不能抢占', 'This tab is lent to another owner and cannot be taken') }
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
      return { ok: false, error: pick('标签页已归还主窗口', 'Tab was returned to the main window') }
    }
    if (tab.view.webContents.isDestroyed()) return { ok: false, error: pick('标签页已关闭', 'Tab is closed') }
    const url = safeUrl(raw)
    if (!url) return { ok: false, error: pick('只允许打开 http(s) 网页', 'Only http(s) pages can be opened') }
    if (url !== tab.view.webContents.getURL()) {
      tab.state.url = url
      tab.state.title = ''
      tab.state.loading = true
      tab.pendingMainFrameUrl = url
      this.updateState()
      await tab.view.webContents.loadURL(url).catch(() => undefined)
    }
    if (tab.view.webContents.isDestroyed()) return { ok: false, error: pick('标签页已关闭', 'Tab is closed') }
    this.syncTabNavigation(tab)
    this.updateState()
    return { ok: true }
  }

  private showOnlyOwnedView(activeId: string | null): void {
    const shownId = this.viewerSessionId === this.focusSessionId ? activeId : this.activeBySession.get(this.viewerSessionId) ?? null
    for (const tab of this.tabs.values()) {
      if (tab.borrowedBy) continue
      const visible = ownedViewVisible(shownId, tab.id, this.viewVisibleRequested)
      if (visible) void this.placeTab(tab)
      tab.view.setVisible(visible)
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
    if (!url) return { ok: false, error: pick('只允许打开 http(s) 网页', 'Only http(s) pages can be opened') }
    try {
      if (this.automationOwner) await this.parts()?.input.showActivity(pick('打开网页', 'Opening page'))
      if (this.external && this.activeMode === 'external') await this.navigateExternal(url)
      else await this.open(url)
      if (this.automationOwner) await this.parts()?.input.showActivity(pick('打开网页', 'Opening page'))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async back(): Promise<BrowserActionResult> {
    if (this.external && this.activeMode === 'external') return this.externalHistory(-1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoBack()) return { ok: false, error: pick('没有可返回的页面', 'Nothing to go back to') }
    const settled = this.navigationSettled(tab)
    tab.view.webContents.goBack()
    await settled
    return { ok: true }
  }

  async forward(): Promise<BrowserActionResult> {
    if (this.external && this.activeMode === 'external') return this.externalHistory(1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoForward()) return { ok: false, error: pick('没有可前进的页面', 'Nothing to go forward to') }
    const settled = this.navigationSettled(tab)
    tab.view.webContents.goForward()
    await settled
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
    if (!tab) return { ok: false, error: pick('浏览器尚未打开', 'Browser is not open') }
    tab.registry.clear()
    const settled = this.navigationSettled(tab)
    tab.view.webContents.reload()
    await settled
    return { ok: true }
  }

  openExternal(raw?: string): BrowserActionResult {
    const tab = this.activeTab()
    const value = raw && raw.trim() ? raw.trim() : tab?.state.url ?? ''
    const url = safeUrl(value)
    if (!url || url === 'about:blank') return { ok: false, error: pick('没有可打开的外部地址', 'No external address to open') }
    void shell.openExternal(url).catch((error) => {
      this.pushError(pick(`无法用系统浏览器打开：${error instanceof Error ? error.message : String(error)}`, `Cannot open in the system browser: ${error instanceof Error ? error.message : String(error)}`))
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
    if (!url) return { ok: false, error: pick('只允许打开 http(s) 网页', 'Only http(s) pages can be opened') }
    if (this.external) {
      this.activeMode = 'external'
      await this.navigateExternal(url)
      return { ok: true }
    }

    const port = await pickFreePort()
    const profileDir = defaultProfileDir(YAN_DIR)
    let chrome: ChildProcess | null = null
    let cdp: RawCdp | null = null
    try {
      await mkdir(profileDir, { recursive: true })
      const syncReport = await this.profileSyncReport(profileDir)
      chrome = launchChrome({
        profileDir,
        port,
        url: INITIAL_URL,
        headless: process.env.YAN_CHROME_HEADLESS === '1'
      })
      await waitForCdp(port, 20_000)
      const page = pickPageTarget(await listTargets(port))
      if (!page?.webSocketDebuggerUrl) throw new Error(pick('Chrome 已启动，但没有可调试的页面目标', 'Chrome started, but there is no debuggable page target'))

      cdp = new RawCdp(page.webSocketDebuggerUrl)
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
      await this.navigateExternal(url)
      await this.syncExternalTabs()
      await this.syncExternalHistory()
      this.updateState()
      return { ok: true }
    } catch (error) {
      if (this.external?.cdp === cdp) this.external.observer.dispose()
      if (this.externalBoundaryCdp === cdp) this.externalBoundaryCdp = null
      await cdp?.detach().catch(() => undefined)
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
      this.pushError(pick(`外部 Chrome 下载监听未能启用：${error instanceof Error ? error.message : String(error)}`, `External Chrome download listener failed to start: ${error instanceof Error ? error.message : String(error)}`))
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
      if (!embedded) throw new Error(pick('请先打开内置浏览器页面，再复制 Cookie', 'Open a built-in browser page first, then copy cookies'))
      const fromChrome = this.activeMode === 'external'
      const result = await transferCookies(
        fromChrome ? this.external.cdp : embedded.cdp,
        fromChrome ? embedded.cdp : this.external.cdp
      )
      const report: ChromeSyncReport = {
        found: true, chromeRunning: true, cookiesSynced: result.failed === 0,
        source: fromChrome ? 'Chrome' : pick('内置浏览器', 'Built-in browser'),
        target: fromChrome ? pick('内置浏览器', 'Built-in browser') : 'Chrome',
        copied: [`Cookies: ${result.copied}`],
        failed: result.failed ? [{ item: 'Cookies', reason: pick(`${result.failed} 项未能复制`, `${result.failed} failed to copy`) }] : []
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
    if (!this.external) throw new Error(pick('请先接入本机 Chrome', 'Connect local Chrome first'))
    const embedded = this.activeTab()
    if (!embedded) throw new Error(pick('请先打开内置浏览器页面，再复制当前页面存储', 'Open a built-in browser page first, then copy page storage'))
    const externalUrl = safeUrl(this.external.url)
    const embeddedUrl = safeUrl(embedded.state.url)
    if (!externalUrl || !embeddedUrl || externalUrl === 'about:blank' || embeddedUrl === 'about:blank') throw new Error(pick('两个页面都需要先打开 http(s) 网站，才能复制当前页面存储', 'Both pages must have an http(s) site open to copy page storage'))
    if (new URL(externalUrl).origin !== new URL(embeddedUrl).origin) throw new Error(pick('两个页面必须处于同一网站，才能复制当前页面存储', 'Both pages must be on the same site to copy page storage'))
    const from = this.activeMode === 'external' ? this.external.cdp : embedded.cdp
    const to = this.activeMode === 'external' ? embedded.cdp : this.external.cdp
    const results = await Promise.all([transferPageStorage(from, to, 'localStorage'), transferPageStorage(from, to, 'sessionStorage')])
    const report: ChromeSyncReport = { found: true, chromeRunning: true, cookiesSynced: false, source: this.activeMode === 'external' ? pick('Chrome 当前页面', 'Chrome current page') : pick('内置浏览器当前页面', 'Built-in browser current page'), target: this.activeMode === 'external' ? pick('内置浏览器当前页面', 'Built-in browser current page') : pick('Chrome 当前页面', 'Chrome current page'), copied: results.map((r) => `${r.kind}: ${r.copied}`), failed: results.flatMap((r) => r.failed ? [{ item: r.kind, reason: pick(`${r.failed} 项未能复制`, `${r.failed} failed to copy`) }] : []) }
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
    try {
      await cdp.attach()
      await this.enableExternalBoundary(cdp)
    } catch (error) {
      await cdp.detach().catch(() => undefined)
      throw error
    }
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
    const unsubscribe = cdp.on('Fetch.requestPaused', (params) => {
      void this.handleExternalRequest(cdp, params)
    })
    try {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      this.externalBoundaryCdp = cdp
    } catch (error) {
      unsubscribe()
      throw new Error(pick(`外部 Chrome 的网络边界未能启用：${error instanceof Error ? error.message : String(error)}`, `External Chrome network boundary failed to start: ${error instanceof Error ? error.message : String(error)}`))
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
        blocked = true
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
    if (!ext) return { ok: false, error: pick('外部浏览器未接入', 'External browser is not connected') }
    try {
      const history = await ext.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
        'Page.getNavigationHistory'
      )
      const index = history.currentIndex + delta
      if (index < 0 || index >= history.entries.length) {
        return { ok: false, error: delta < 0 ? pick('没有可返回的页面', 'Nothing to go back to') : pick('没有可前进的页面', 'Nothing to go forward to') }
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
    const viewerActive = this.activeBySession.get(this.viewerSessionId) ?? null
    const tab = viewerActive ? this.tabs.get(viewerActive) ?? null : null
    if (!tab) return
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
    this.pane = clean
    void this.placeTab(tab)
  }

  private pane: BrowserBounds | null = null

  private placeTab(tab: BrowserTab): Promise<void> {
    const pane = this.pane
    const viewport = tab.state.viewport ?? 'responsive'
    if (!pane || tab.borrowedBy || tab.view.webContents.isDestroyed()) return Promise.resolve()
    const fitted = viewportRect(pane, viewport)
    tab.view.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height })
    const mobileUa = viewport === 'mobile' || (viewport === 'responsive' && (tab.mobileUa ? pane.width < NARROW_EXIT_PX : pane.width < NARROW_ENTER_PX))
    const key = `${viewport}:${mobileUa ? 'm' : 'd'}:${fitted.emulated ? `${fitted.emulated.width}x${fitted.emulated.height}@${fitted.scale.toFixed(4)}` : ''}`
    if (tab.emulatedKey === key) return Promise.resolve()
    tab.emulatedKey = key
    const uaChanged = (tab.mobileUa ?? false) !== mobileUa
    tab.mobileUa = mobileUa
    return this.applyViewport(tab, fitted, mobileUa).then(() => {
      if (uaChanged) this.scheduleUaReload(tab)
    })
  }

  private scheduleUaReload(tab: BrowserTab): void {
    clearTimeout(tab.uaReloadTimer)
    tab.uaReloadTimer = setTimeout(() => {
      tab.uaReloadTimer = undefined
      const contents = tab.view.webContents
      if (this.tabs.get(tab.id) !== tab || contents.isDestroyed() || !tab.state.url) return
      if (contents.getUserAgent() === tab.loadedUa) return
      contents.reload()
    }, UA_RELOAD_DELAY_MS)
  }

  private async applyViewport(tab: BrowserTab, fitted: ViewportFit, mobileUa: boolean): Promise<void> {
    const viewport = tab.state.viewport ?? 'responsive'
    const preset = fitted.emulated
    const userAgent = mobileUa ? mobileUserAgent() : tab.view.webContents.session.getUserAgent()
    tab.view.webContents.setUserAgent(userAgent)
    await tab.cdp.send('Emulation.setUserAgentOverride', mobileUa ? { userAgent, platform: 'Android' } : { userAgent }).catch(() => undefined)
    if (!preset) {
      await tab.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined)
      await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => undefined)
      return
    }
    const mobile = viewport === 'mobile'
    await tab.cdp.send('Emulation.setDeviceMetricsOverride', { width: preset.width, height: preset.height, deviceScaleFactor: mobile ? 2 : 0, mobile, scale: fitted.scale }).catch(() => undefined)
    await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 }).catch(() => undefined)
  }

  async setViewport(value: unknown): Promise<void> {
    const viewport = isBrowserViewport(value) ? value : 'responsive'
    const viewerActive = this.activeBySession.get(this.viewerSessionId) ?? null
    const tab = viewerActive ? this.tabs.get(viewerActive) ?? null : null
    if (!tab || (tab.state.viewport ?? 'responsive') === viewport) return
    tab.state.viewport = viewport
    this.updateState()
    await this.placeTab(tab)
  }

  async snapshot(): Promise<string | null> {
    if (this.external && this.activeMode === 'external') return null
    const viewerActive = this.activeBySession.get(this.viewerSessionId) ?? null
    const tab = viewerActive ? this.tabs.get(viewerActive) ?? null : null
    if (!tab || tab.borrowedBy || tab.view.webContents.isDestroyed()) return null
    const image = await tab.view.webContents.capturePage().catch(() => null)
    if (!image || image.isEmpty()) return null
    return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`
  }

  runScript(code: string, signal?: AbortSignal): Promise<ScriptResult> {
    return runBrowserScript(code, {
      navigate: (url) => this.navigate(url),
      observe: () => this.observe(),
      click: (ref, options) => this.click(ref, options),
      type: (ref, text, options) => this.type(ref, text, options),
      select: (ref, value, options) => this.select(ref, value, options),
      press: (key, options) => this.press(key, options),
      scroll: (deltaX, deltaY) => this.scroll(deltaX, deltaY),
      back: () => this.back(),
      forward: () => this.forward(),
      reload: () => this.reload(),
      state: () => {
        const state = this.getState()
        return { url: state.url, title: state.title, activeTabId: state.activeTabId, tabs: state.tabs }
      },
      newTab: (url) => this.newTab(url),
      switchTab: (id) => this.switchTab(id),
      closeTab: (id) => this.closeTab(id)
    }, {
      signal,
      beforeAction: () => {
        if (this.userControl) throw new ScriptError('USER_CONTROL_ACTIVE', 'USER_CONTROL_ACTIVE: 浏览器当前由用户接管，请等待用户交还 Agent 控制。')
      }
    })
  }

  async guide(): Promise<string> {
    return SCRIPT_GUIDE
  }

  async dispose(): Promise<void> {
    await this.close()
  }

  async observe(): Promise<BrowserObservation> {
    const p = this.parts()
    if (!p) throw new Error(pick('浏览器尚未打开', 'Browser is not open'))
    if (!this.userControl) await p.input.showActivity(pick('读取页面', 'Reading page'))
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
    await this.layoutHiddenTab(tab!)
    return p.observer.capture(tab!.state.url, tab!.state.title)
  }

  private async layoutHiddenTab(tab: BrowserTab, repaint = false): Promise<void> {
    const win = this.getWindow()
    const contents = tab.view.webContents
    if (!win || win.isDestroyed() || tab.borrowedBy || contents.isDestroyed() || tab.view.getVisible()) return
    const viewport = async (): Promise<[number, number]> => {
      const size = await contents.executeJavaScript('[innerWidth, innerHeight]', true).catch(() => [0, 0])
      return Array.isArray(size) ? [Number(size[0]) || 0, Number(size[1]) || 0] : [0, 0]
    }
    const [width, height] = await viewport()
    const sized = width >= HIDDEN_LAYOUT_MIN_WIDTH && height >= HIDDEN_LAYOUT_MIN_HEIGHT
    if (sized && !repaint) return
    const target = sized ? tab.view.getBounds() : HIDDEN_LAYOUT_SIZE
    const parking = new View()
    parking.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    win.contentView.addChildView(parking)
    try {
      parking.addChildView(tab.view)
      tab.view.setBounds({ x: 0, y: 0, width: target.width, height: target.height })
      tab.view.setVisible(true)
      const deadline = Date.now() + HIDDEN_LAYOUT_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if ((await viewport())[0] >= HIDDEN_LAYOUT_MIN_WIDTH) break
      }
      await Promise.race([
        contents.executeJavaScript(HIDDEN_PAINT_SCRIPT, true).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, HIDDEN_PAINT_TIMEOUT_MS))
      ])
    } finally {
      if (!win.isDestroyed()) {
        tab.view.setVisible(false)
        if (this.tabs.get(tab.id) === tab && !tab.borrowedBy) win.contentView.addChildView(tab.view)
        else parking.removeChildView(tab.view)
        win.contentView.removeChildView(parking)
        if (this.activeTabId === tab.id && this.viewVisibleRequested && this.activeMode === 'embedded') this.showOnlyOwnedView(tab.id)
      }
    }
  }

  async network(): Promise<BrowserNetworkSnapshot> {
    const p = this.parts()
    if (!p) throw new Error(pick('浏览器尚未打开', 'Browser is not open'))
    await p.network.start()
    return p.network.snapshot()
  }

  async click(ref: string, options: BrowserActionOptions = {}): Promise<BrowserActionOutcome> {
    return this.act(async (p) => {
      const { obscuredBy } = await p.input.click(p.registry.resolve(ref))
      return obscuredBy ? { receipt: { obscuredBy } } : {}
    }, options)
  }

  async type(ref: string, text: string, options: BrowserActionOptions = {}): Promise<BrowserActionOutcome> {
    return this.act(async (p) => {
      const typed = await p.input.type(p.registry.resolve(ref), text)
      return { receipt: { value: typed.value, ...(typed.picker ? { picker: typed.picker } : {}) } }
    }, options)
  }

  async press(key: string, options: BrowserActionOptions = {}): Promise<BrowserActionOutcome> {
    return this.act(async (p) => {
      await p.input.press(key)
      return {}
    }, options)
  }

  async select(ref: string, value: string, options: BrowserActionOptions = {}): Promise<BrowserActionOutcome & { chosen?: SelectOutcome }> {
    return this.act(async (p) => ({ chosen: await p.input.select(p.registry.resolve(ref), value) }), options)
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserActionOutcome> {
    return this.act(async (p) => {
      const position = await p.input.scroll(deltaX, deltaY)
      return position ? { receipt: { scroll: position } } : {}
    })
  }

  private async act(
    work: (p: TargetParts) => Promise<{ receipt?: BrowserActionReceipt; chosen?: SelectOutcome }>,
    options: BrowserActionOptions = {}
  ): Promise<BrowserActionOutcome & { chosen?: SelectOutcome }> {
    const p = this.parts()
    if (!p) return { ok: false, error: pick('浏览器尚未打开', 'Browser is not open') }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    const tab = [...this.tabs.values()].find((candidate) => candidate.cdp === p.cdp)
    const tabsBefore = new Set(this.tabs.keys())
    const startedAt = Date.now()
    if (tab) {
      tab.dialogs = []
      tab.dialogPolicy = options
      tab.acting = true
    }
    try {
      const { receipt: workReceipt, chosen } = await work(p)
      await this.waitForPage()
      const observation = await this.observeTarget(p)
      const receipt: BrowserActionReceipt = { ...workReceipt }
      if (tab?.dialogs.length) receipt.dialogs = [...tab.dialogs]
      const opened = [...this.tabs.values()].filter((candidate) => !tabsBefore.has(candidate.id))
      if (opened.length) receipt.openedTabs = opened.map((candidate) => ({ id: candidate.id, url: candidate.state.url }))
      if (this.downloadStarted && this.downloadStarted.at >= startedAt) receipt.downloadStarted = this.downloadStarted.name
      return { ok: true, ...(chosen ? { chosen } : {}), observation, receipt }
    } catch (error) {
      return this.actionError(error)
    } finally {
      if (tab) {
        tab.dialogPolicy = undefined
        tab.acting = false
      }
    }
  }

  private answerDialog(tab: BrowserTab, params: Record<string, unknown>): void {
    if (!tab.acting && tab.view.getVisible() && !tab.borrowedBy) return
    const type = String(params.type ?? 'alert')
    const policy = tab.dialogPolicy
    const accepted = type === 'alert' || type === 'beforeunload' || policy?.dialog === 'accept'
    tab.dialogs.push({ type, message: String(params.message ?? '').slice(0, 300), accepted })
    if (tab.dialogs.length > 10) tab.dialogs.shift()
    void tab.cdp.send('Page.handleJavaScriptDialog', { accept: accepted }).catch(() => undefined)
  }

  private navigationSettled(tab: BrowserTab, timeoutMs = 10_000): Promise<void> {
    const contents = tab.view.webContents
    return new Promise((resolve) => {
      const events = ['did-stop-loading', 'did-navigate-in-page', 'did-fail-load', 'destroyed'] as const
      const done = (): void => {
        clearTimeout(timer)
        for (const name of events) contents.removeListener(name as 'destroyed', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      for (const name of events) contents.once(name as 'destroyed', done)
    })
  }

  requestUserControl(request: { reason?: string; sessionId?: string } = {}): BrowserState {
    void this.parts()?.input.hideActivity()
    this.userControl = true
    this.userControlRequest = { reason: request.reason ?? '', sessionId: request.sessionId ?? '', at: Date.now() }
    this.updateState()
    return this.getState()
  }

  releaseUserControlFor(sessionId: string): void {
    if (!this.userControl) return
    const owner = this.userControlRequest?.sessionId
    if (owner && owner !== sessionId) return
    this.setUserControl(false)
  }

  async screenshot(): Promise<{ mimeType: string; data: Buffer }> {
    const p = this.parts()
    if (!p) throw new Error(pick('浏览器尚未打开', 'Browser is not open'))
    const tab = [...this.tabs.values()].find((candidate) => candidate.cdp === p.cdp)
    if (tab) await this.layoutHiddenTab(tab, true)
    return { mimeType: 'image/png', data: await p.cdp.screenshot() }
  }

  setUserControl(value: boolean): BrowserState {
    if (value) void this.parts()?.input.hideActivity()
    this.userControl = value
    if (!value) this.userControlRequest = null
    this.updateState()
    return this.getState()
  }

  setPermission(permission: string, origin: string, allowed: boolean): BrowserActionResult {
    const name = typeof permission === 'string' ? permission.trim() : ''
    const normalizedOrigin = normalizePermissionOrigin(origin)
    if (!name) return { ok: false, error: pick('权限名称不能为空', 'Permission name cannot be empty') }
    if (!normalizedOrigin) return { ok: false, error: pick('权限只接受 http/https origin', 'Permissions only accept http/https origins') }
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
    this.downloadsInProgress.set(item, filename)
    item.once('done', () => this.downloadsInProgress.delete(item))
    let asked = false
    const confirmIfLarge = (bytes: number): void => {
      if (asked || bytes <= DOWNLOAD_CONFIRM_BYTES) return
      asked = true
      item.pause()
      void this.approveLargeDownload({ filename, bytes: Math.max(item.getTotalBytes(), bytes), source: origin })
        .catch(() => false)
        .then((allowed) => {
          if (item.getState() !== 'progressing') return
          if (allowed) {
            item.resume()
            return
          }
          item.cancel()
          this.pushError(pick(`已取消下载 ${filename}：文件超过 ${DOWNLOAD_CONFIRM_BYTES / 1024 / 1024} MB，没有得到确认`, `Download of ${filename} canceled: file exceeds ${DOWNLOAD_CONFIRM_BYTES / 1024 / 1024} MB and was not confirmed`))
        })
    }
    confirmIfLarge(item.getTotalBytes())
    item.on('updated', () => confirmIfLarge(item.getReceivedBytes()))
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
