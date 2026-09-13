/*
 * 内置浏览器控制器。
 *
 * 架构：页面是主进程持有的原生 WebContentsView（不是 iframe），renderer 只画
 * 工具栏并把可见区域坐标同步过来；pi 通过一个只监听 127.0.0.1 的 loopback
 * bridge（随机端口 + 随机 token）驱动同一份视图。
 *
 *   renderer(BrowserSurface) ──IPC──► BrowserController ──CDP──► 网页
 *   pi extension(browser.js) ──HTTP──► 同一个 bridge
 *
 * 底层算法拆在 ./browser/：CDPBridge / Observer / ElementRegistry /
 * InputController / BrowserPolicy / geometry。可读性从上往下读本文件即可，
 * 细节再进子目录。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import { app, shell, WebContentsView, type BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { BrowserBounds, BrowserObservation, BrowserState, BrowserTabState, MainPush } from '../shared/ipc'
import { BrowserPolicy } from './browser/BrowserPolicy'
import { CDPBridge } from './browser/CDPBridge'
import type { CdpChannel } from './browser/CdpChannel'
import { ElementRegistry } from './browser/ElementRegistry'
import { InputController } from './browser/InputController'
import { Observer } from './browser/Observer'
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
import { YAN_DIR } from './paths'

type Push = (msg: MainPush) => void
type BrowserActionResult = { ok: boolean; error?: string; code?: string }
const INITIAL_URL = 'about:blank'
/** 接入本机 Chrome 时默认打开的页面（用户要操作的 ChatGPT 网页版） */
const EXTERNAL_CHROME_URL = 'https://chatgpt.com'
const MAX_BODY = 1024 * 1024

function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim()
  if (value === 'about:blank') return value
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

interface BrowserTab {
  id: string
  view: WebContentsView
  cdp: CDPBridge
  registry: ElementRegistry
  observer: Observer
  input: InputController
  state: BrowserTabState
}

/**
 * 外部（本机）Chrome 的当前页面目标。
 *
 * 没有 WebContentsView —— 页面是 Chrome 自己的窗口；这里只持有 CDP 连接
 * 与复用同一套观察/输入算法。`registry`/`observer`/`input` 在切换目标
 * （新建标签页）时会整体重建，因为 ref 绑定在具体 CDP 会话上。
 */
interface ExternalTarget {
  cdp: RawCdp
  registry: ElementRegistry
  observer: Observer
  input: InputController
  chrome: ChildProcess | null
  port: number
  profileDir: string
  /** 当前连接的 Chrome 页面目标 id（`/json/list` 里的 id） */
  targetId: string
  url: string
  title: string
  loading: boolean
  /** 页面历史状态（同步给工具栏的前进/后退按钮） */
  canGoBack: boolean
  canGoForward: boolean
  /** Chrome 当前所有可切换的页面标签（供工具栏渲染） */
  chromeTabs: BrowserTabState[]
}

/** 两种渲染模式共用的「可观察目标」抽象 */
interface TargetParts {
  cdp: CdpChannel
  registry: ElementRegistry
  observer: Observer
  input: InputController
}

/** Electron-owned browser runtime. Pi only sees the authenticated loopback API. */
export class BrowserController {
  private readonly tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private server: Server | null = null
  private token = randomBytes(24).toString('hex')
  private port = 0
  private userControl = false
  private lastDownload: BrowserState['lastDownload']
  private nativeBounds: BrowserBounds | undefined
  private downloadSessionAttached = false
  /** 外部 Chrome 目标（null = 用内嵌 WebContentsView） */
  private external: ExternalTarget | null = null
  /** 外部 Chrome 下载：guid → 文件名（downloadWillBegin 先到，进度事件用 guid 关联） */
  private readonly externalDownloadNames = new Map<string, string>()
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
    private readonly push: Push
  ) {}

  async startBridge(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => void this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server?.off('error', onError)
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      }
      this.server!.once('error', onError)
      this.server!.once('listening', onListening)
      this.server!.listen(0, '127.0.0.1')
    })
  }

  bridgeEnv(): NodeJS.ProcessEnv {
    return {
      YAN_BROWSER_BRIDGE_URL: `http://127.0.0.1:${this.port}`,
      YAN_BROWSER_BRIDGE_TOKEN: this.token
    }
  }

  getState(): BrowserState {
    const ext = this.external
    const active = this.activeTab()
    return {
      open: Boolean(active) || Boolean(ext),
      url: ext?.url ?? active?.state.url ?? '',
      title: ext?.title ?? active?.state.title ?? '',
      loading: ext?.loading ?? active?.state.loading ?? false,
      canGoBack: ext ? ext.canGoBack : active?.state.canGoBack ?? false,
      canGoForward: ext ? ext.canGoForward : active?.state.canGoForward ?? false,
      tabs: ext
        ? ext.chromeTabs.map((tab) => ({ ...tab }))
        : [...this.tabs.values()].map((tab) => ({ ...tab.state })),
      activeTabId: ext ? ext.targetId : this.activeTabId ?? undefined,
      userControl: this.userControl,
      lastDownload: this.lastDownload,
      nativeBounds: this.nativeBounds,
      mode: ext ? 'external' : 'embedded',
      external: ext
        ? {
            url: ext.url,
            title: ext.title,
            loading: ext.loading,
            profileDir: ext.profileDir,
            debuggingPort: ext.port
          }
        : undefined
    }
  }

  private publish(): void {
    this.push({ ch: 'browser-state', payload: this.getState() })
  }

  private updateState(): void {
    this.state = this.getState()
    this.publish()
  }

  /**
   * 取当前可观察目标：外部 Chrome 优先，否则是内嵌活动标签页。
   * 两种目标都提供 cdp / registry / observer / input，调用方不用分叉。
   */
  private parts(): TargetParts | null {
    if (this.external) return this.external
    const tab = this.activeTab()
    return tab ? { cdp: tab.cdp, registry: tab.registry, observer: tab.observer, input: tab.input } : null
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
      state: { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    }
    view.webContents.on('did-start-loading', () => {
      tab.state.loading = true
      this.updateState()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.state.loading = false
      this.syncTabNavigation(tab)
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-navigate', (_event, url) => {
      tab.state.url = url
      tab.state.canGoBack = view.webContents.canGoBack()
      tab.state.canGoForward = view.webContents.canGoForward()
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      tab.state.url = url
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
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (safeUrl(url)) void this.newTab(url)
      return { action: 'deny' }
    })
    view.webContents.on('will-navigate', (event, url) => {
      if (!safeUrl(url)) event.preventDefault()
    })
    view.webContents.debugger.on('message', (_event, method) => {
      /*
       * 只在**整篇文档被替换**时作废旧引用。
       *
       * 不能监听 DOM.childNodeInserted / childNodeRemoved：观察时用了
       * `DOM.getDocument({depth:-1})`，整棵树都被推送给客户端，之后页面上
       * **任何**节点增删都会触发这两个事件 —— 一个时钟、一条广告、一次
       * React 重渲染，甚至改一次 document.title，就会把整张注册表清空，
       * 让刚刚 observe 出来的 ref 立刻变成 STALE_ELEMENT。
       *
       * 被移除的节点由 DOM 自己报「Node is detached」，我们在 actionError
       * 里翻译成 STALE_ELEMENT，精度比「一刀切清空」高得多。
       */
      if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated') {
        tab.registry.clear()
      }
    })
    if (!this.downloadSessionAttached) {
      this.downloadSessionAttached = true
      view.webContents.session.on('will-download', (_event, item) => void this.handleDownload(item))
    }
    void cdp.attach().catch((error) => {
      /*
       * 「目标已关闭」是**良性**的：标签在 attach 过程中被关/被替换
       * （例如紧接着切到外部 Chrome、重复 open），Page.enable 这类命令
       * 撞上已销毁的目标就会报它。这不该弹错误条。
       */
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

  /**
   * HMR / 旧版本热重载后，BrowserWindow 可能还挂着上一代 BrowserView。
   * 它不在当前 tabs Map 里，却仍会作为原生层绘制在 renderer 上方，表现为
   * 页面被画到旧位置、右侧出现白色空洞。只移除属于本窗口且不属于当前
   * controller 的 web-content view，保留 BrowserWindow 自己的 renderer view。
   */
  private removeForeignBrowserViews(win: BrowserWindow): void {
    const owned = new Set([...this.tabs.values()].map((tab) => tab.view))
    // 迭代副本：removeChildView 会改变 children，边删边遍历会漏掉后面的视图。
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
    // 两种模式互斥：开内嵌浏览时先断开外部 Chrome
    await this.closeExternalChrome()
    let tab = this.activeTab()
    if (!tab) {
      tab = this.createTab()
      this.activeTabId = tab.id
    }
    const win = this.getWindow()
    if (!win) return this.getState()
    this.removeForeignBrowserViews(win)
    for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === tab.id)
    if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view)
    if (next !== tab.view.webContents.getURL()) {
      tab.state.url = next
      tab.state.title = ''
      tab.state.loading = true
      this.updateState()
      await tab.view.webContents.loadURL(next)
    }
    this.syncTabNavigation(tab)
    this.updateState()
    return this.getState()
  }

  async newTab(rawUrl = INITIAL_URL): Promise<BrowserState> {
    const url = safeUrl(rawUrl)
    if (!url) throw new Error('只允许打开 http(s) 网页')
    // 外部 Chrome：新建一个真实标签页，并把 CDP 连接切过去
    if (this.external) {
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
    for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === tab.id)
    tab.state.url = url
    tab.state.loading = true
    this.updateState()
    await tab.view.webContents.loadURL(url)
    this.syncTabNavigation(tab)
    this.updateState()
    return this.getState()
  }

  async switchTab(id: string): Promise<BrowserState> {
    // 外部 Chrome：把 CDP 连接切到那个页面目标
    if (this.external) {
      const target = (await listTargets(this.external.port)).find(
        (t) => t.id === id && !!t.webSocketDebuggerUrl
      )
      if (!target) throw new Error('找不到浏览器标签页')
      await this.attachExternalTarget(target)
      return this.getState()
    }
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('找不到浏览器标签页')
    this.activeTabId = id
    for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === id)
    this.updateState()
    return this.getState()
  }

  async closeTab(id = this.activeTabId ?? ''): Promise<BrowserState> {
    // 外部 Chrome：关掉那个真实标签页
    if (this.external) {
      const ext = this.external
      const targetId = id || ext.targetId
      await closeCdpTarget(ext.port, targetId)
      if (targetId === ext.targetId) {
        // 当前目标被关掉：切到剩下的第一个页面，没有就整体断开
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
    const win = this.getWindow()
    if (win && win.contentView.children.includes(tab.view)) win.contentView.removeChildView(tab.view)
    await tab.cdp.detach().catch(() => undefined)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(id)
    if (this.activeTabId === id) {
      const next = [...this.tabs.values()].at(-1)
      this.activeTabId = next?.id ?? null
      for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === this.activeTabId)
    }
    this.updateState()
    return this.getState()
  }

  async close(): Promise<BrowserState> {
    const ids = [...this.tabs.keys()]
    for (const id of ids) await this.closeTab(id)
    await this.closeExternalChrome()
    this.userControl = false
    this.nativeBounds = undefined
    this.updateState()
    return this.getState()
  }

  async navigate(raw: string): Promise<BrowserActionResult> {
    const url = safeUrl(raw)
    if (!url) return { ok: false, error: '只允许打开 http(s) 网页' }
    try {
      if (this.external) await this.navigateExternal(url)
      else await this.open(url)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async back(): Promise<BrowserActionResult> {
    if (this.external) return this.externalHistory(-1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoBack()) return { ok: false, error: '没有可返回的页面' }
    tab.view.webContents.goBack()
    return { ok: true }
  }

  async forward(): Promise<BrowserActionResult> {
    if (this.external) return this.externalHistory(1)
    const tab = this.activeTab()
    if (!tab?.view.webContents.canGoForward()) return { ok: false, error: '没有可前进的页面' }
    tab.view.webContents.goForward()
    return { ok: true }
  }

  async reload(): Promise<BrowserActionResult> {
    if (this.external) {
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

  /**
   * 用系统默认浏览器打开给定地址（不传则用当前标签页）。
   * 给 renderer 的「在外部浏览器打开」按钮用：内置视图受限于登录态，
   * 用户想拿自己的 Chrome（带 cookie / 账号）继续看时走这里。
   */
  openExternal(raw?: string): BrowserActionResult {
    const tab = this.activeTab()
    const value = raw && raw.trim() ? raw.trim() : tab?.state.url ?? ''
    const url = safeUrl(value)
    if (!url || url === 'about:blank') return { ok: false, error: '没有可打开的外部地址' }
    void shell.openExternal(url)
    return { ok: true }
  }

  /* ================================================================
     外部 Chrome（本机已安装的浏览器）
     ================================================================ */

  /**
   * 接入本机 Chrome。
   *
   * 为什么用独立 profile：Chrome 136 起，**默认配置目录**会被拒绝开
   * `--remote-debugging-port`（安全策略）。独立 profile 需要用户
   * **登录一次**目标站点；之后这个 profile 会一直保留登录态。
   *
   * `YAN_CHROME_HEADLESS=1` 时用无头模式（自动化测试用，不弹窗口）。
   */
  async openExternalChrome(rawUrl = EXTERNAL_CHROME_URL): Promise<BrowserActionResult> {
    const url = safeUrl(rawUrl)
    if (!url) return { ok: false, error: '只允许打开 http(s) 网页' }
    if (this.external) {
      await this.navigateExternal(url)
      return { ok: true }
    }

    const port = await pickFreePort()
    const profileDir = defaultProfileDir(YAN_DIR)
    let chrome: ChildProcess | null = null
    try {
      await mkdir(profileDir, { recursive: true })
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
      await this.setupExternalDownloads(cdp)
      /*
       * 连接成功后再关内嵌标签页。
       * 之前是「先关内嵌再启动」，一旦 Chrome 启动失败，用户已打开的内嵌页
       * 被清空而外部又没接上 —— 看起来就像界面卡死。
       */
      for (const id of [...this.tabs.keys()]) await this.closeTab(id)
      this.external = {
        cdp,
        registry,
        observer: new Observer(cdp, registry),
        input: new InputController(cdp),
        chrome,
        port,
        profileDir,
        targetId: page.id,
        url: page.url || url,
        title: page.title || '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        chromeTabs: []
      }
      // 用户自己关掉 Chrome 时同步清状态
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

  /**
   * 外部 Chrome 的下载：CDP 允许下载到系统下载目录，并监听完成事件。
   *
   * ⚠️ 浏览器级 setDownloadBehavior 只在**当前连接**上生效；切目标后
   * 重连（attachExternalTarget）要重新调一次，否则下载会被 Chrome 默认阻止。
   */
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
        // 旧版本不接受 eventsEnabled，退回基础参数（至少不阻断下载）
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory })
      }
    } catch {
      return
    }
    cdp.on('Browser.downloadWillBegin', (params) => {
      const guid = String(params.guid ?? '')
      const name = String(params.suggestedFilename ?? '')
      if (guid && name) this.externalDownloadNames.set(guid, name)
    })
    cdp.on('Browser.downloadProgress', (params) => {
      if (String(params.state ?? '') !== 'completed') return
      const guid = String(params.guid ?? '')
      const filename = this.externalDownloadNames.get(guid) ?? `download-${Date.now()}`
      this.externalDownloadNames.delete(guid)
      const size = Number(params.receivedBytes ?? 0)
      this.lastDownload = {
        path: join(directory, filename),
        filename,
        size: Number.isFinite(size) && size > 0 ? size : undefined
      }
      this.updateState()
    })
  }

  /** 断开外部 Chrome，并关掉我们拉起的那个进程 */
  async closeExternalChrome(): Promise<BrowserState> {
    const ext = this.external
    if (!ext) return this.getState()
    this.external = null
    await ext.cdp.detach().catch(() => undefined)
    stopChrome(ext.chrome)
    this.userControl = false
    this.updateState()
    return this.getState()
  }

  /** 把一个 Chrome 页面目标接成当前目标（重建 registry/observer/input） */
  private async attachExternalTarget(target: CdpTarget): Promise<void> {
    if (!this.external || !target.webSocketDebuggerUrl) return
    await this.external.cdp.detach().catch(() => undefined)
    const cdp = new RawCdp(target.webSocketDebuggerUrl)
    await cdp.attach()
    const registry = new ElementRegistry()
    this.external.cdp = cdp
    this.external.registry = registry
    this.external.observer = new Observer(cdp, registry)
    this.external.input = new InputController(cdp)
    this.external.targetId = target.id
    this.external.url = target.url
    this.external.title = target.title
    await this.setupExternalDownloads(cdp)
    await this.syncExternalTabs()
    await this.syncExternalHistory()
    this.updateState()
  }

  /** 同步外部 Chrome 的前进/后退可用状态（页面自身跳转后也要刷） */
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
      /* 目标可能已关闭，保持旧值 */
    }
  }

  /** 同步外部 Chrome 的页面标签列表（供工具栏渲染可切换标签） */
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
      /* 浏览器可能已退出 */
    }
  }

  private async navigateExternal(url: string): Promise<void> {
    const ext = this.external
    if (!ext) return
    ext.loading = true
    this.updateState()
    try {
      await ext.cdp.send('Page.navigate', { url })
      ext.url = url
      await this.syncExternalHistory()
    } finally {
      ext.loading = false
      this.updateState()
    }
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

  setBounds(bounds: BrowserBounds): void {
    // 外部 Chrome 是独立窗口，没有原生视图要摆位置
    if (this.external) return
    const tab = this.activeTab()
    if (!tab || !this.state.open) return
    /*
     * 渲染端给的是**主窗口渲染进程的 CSS 像素**，而 `WebContentsView.setBounds`
     * 收的是窗口内容区的 **DIP**。两者只在界面缩放 = 100% 时相等：
     * 1 CSS px = zoom DIP（zoom 来自 applyZoom 设到主 webContents 上的倍率）。
     *
     * 不换算的后果：原生页面整体偏左上、而且比面板窄一圈 ——
     * 偏多少正好等于 (zoom - 1) × 面板坐标，自动缩放 125% 下就有一百多 px，
     * 看起来像“浏览器跑到中栏去了”。缩放越大偏得越狠。
     */
    const win = this.getWindow()
    const zoom = win && !win.isDestroyed() ? win.webContents.getZoomFactor() || 1 : 1
    const clean = {
      x: Math.max(0, Math.round(bounds.x * zoom)),
      y: Math.max(0, Math.round(bounds.y * zoom)),
      width: Math.max(1, Math.round(bounds.width * zoom)),
      height: Math.max(1, Math.round(bounds.height * zoom))
    }
    this.nativeBounds = clean
    tab.view.setBounds(clean)
    /*
     * ⚠️ 这里**不** push 状态。
     *
     * 渲染端 BrowserSurface 有一个常驻的逐帧「测量视口 → setBounds」循环
     * （几何一变就发 IPC）。如果 setBounds 每次都 updateState→push，那么
     * 面板宽度过渡 / 缩放动画期间（几何每帧都在变）就会变成
     * 「每帧 push → React 每帧重渲染」的推送风暴，界面直接卡死。
     * nativeBounds 只是诊断字段，渲染端不响应它 —— 不需要推送；
     * getState() 会返回它，探针也依旧能读到。
     */
  }

  async dispose(): Promise<void> {
    await this.close()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server = null
    })
  }

  async observe(): Promise<BrowserObservation> {
    const p = this.parts()
    if (!p) throw new Error('浏览器尚未打开')
    await p.cdp.attach()
    if (this.external) {
      const observation = await this.external.observer.capture(this.external.url, this.external.title)
      // 页面自己跳转（或标题变化）时同步状态与可切换标签
      this.external.url = observation.url
      this.external.title = observation.title
      await this.syncExternalHistory()
      await this.syncExternalTabs()
      this.updateState()
      return observation
    }
    const tab = this.activeTab()!
    return tab.observer.capture(tab.state.url, tab.state.title)
  }

  private async click(ref: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      const element = p.registry.resolve(ref)
      const policy = this.policy.checkAction('click', `${element.role} ${element.name}`)
      if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
      await p.input.click(element)
      await this.waitForPage()
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      return this.actionError(error)
    }
  }

  private async type(ref: string, text: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      const element = p.registry.resolve(ref)
      const policy = this.policy.checkAction('type', `${element.role} ${element.name}`)
      if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
      await p.input.type(element, text)
      await this.waitForPage()
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      return this.actionError(error)
    }
  }

  private async press(key: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    const policy = this.policy.checkAction('press', key)
    if (!policy.ok) return { ok: false, code: policy.code, error: policy.message }
    try {
      await p.input.press(key)
      await this.waitForPage()
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      return this.actionError(error)
    }
  }

  private async scroll(deltaX: number, deltaY: number): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
    const p = this.parts()
    if (!p) return { ok: false, error: '浏览器尚未打开' }
    if (this.userControl) return { ok: false, code: 'USER_CONTROL_ACTIVE', error: '浏览器当前由用户接管，请先由用户完成敏感操作并恢复 Agent 控制。' }
    try {
      await p.input.scroll(deltaX, deltaY)
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      return this.actionError(error)
    }
  }

  private requestUserControl(): BrowserState {
    this.userControl = true
    this.updateState()
    return this.getState()
  }

  setUserControl(value: boolean): BrowserState {
    this.userControl = value
    this.updateState()
    return this.getState()
  }

  private actionError(error: unknown): BrowserActionResult {
    const message = error instanceof Error ? error.message : String(error)
    if (/detached|Could not find node|No node with given id|Cannot find context/i.test(message)) {
      return { ok: false, code: 'STALE_ELEMENT', error: `元素引用已失效，请重新调用 browser_observe。（${message}）` }
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

  private async handleDownload(item: Electron.DownloadItem): Promise<void> {
    const directory = app.getPath('downloads')
    await mkdir(directory, { recursive: true })
    const filename = item.getFilename().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `download-${Date.now()}`
    const path = join(directory, filename)
    item.setSavePath(path)
    item.once('done', (_event, state) => {
      if (state !== 'completed') return
      this.lastDownload = { path, filename, size: item.getReceivedBytes() }
      this.updateState()
    })
  }

  private pushError(detail: string): void {
    this.push({ ch: 'notify', payload: { id: `browser-${Date.now()}`, method: 'notify', notifyType: 'error', message: detail } })
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.byteLength
      if (size > MAX_BODY) throw new Error('请求过大')
      chunks.push(buf)
    }
    if (!chunks.length) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-yan-browser-token'] !== this.token) return json(res, 401, { ok: false, error: '未授权' })
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    try {
      const body = req.method === 'POST' ? await this.readBody(req) : {}
      if (req.method === 'GET' && path === '/state') return json(res, 200, this.getState())
      if (req.method === 'POST' && path === '/navigate') return json(res, 200, await this.navigate(String(body.url ?? '')))
      if (req.method === 'POST' && path === '/new-tab') return json(res, 200, await this.newTab(String(body.url ?? INITIAL_URL)))
      if (req.method === 'POST' && path === '/switch-tab') return json(res, 200, await this.switchTab(String(body.id ?? '')))
      if (req.method === 'POST' && path === '/close-tab') return json(res, 200, await this.closeTab(String(body.id ?? '')))
      if (req.method === 'POST' && path === '/back') return json(res, 200, await this.back())
      if (req.method === 'POST' && path === '/forward') return json(res, 200, await this.forward())
      if (req.method === 'POST' && path === '/reload') return json(res, 200, await this.reload())
      if (req.method === 'GET' && path === '/observe') return json(res, 200, await this.observe())
      if (req.method === 'POST' && path === '/click') return json(res, 200, await this.click(String(body.ref ?? '')))
      if (req.method === 'POST' && path === '/type') return json(res, 200, await this.type(String(body.ref ?? ''), String(body.text ?? '')))
      if (req.method === 'POST' && path === '/press') return json(res, 200, await this.press(String(body.key ?? '')))
      if (req.method === 'POST' && path === '/scroll') return json(res, 200, await this.scroll(Number(body.deltaX ?? 0), Number(body.deltaY ?? 0)))
      if (req.method === 'GET' && path === '/screenshot') {
        const p = this.parts()
        if (!p) return json(res, 409, { ok: false, error: '浏览器尚未打开' })
        const data = (await p.cdp.screenshot()).toString('base64')
        return json(res, 200, { ok: true, mimeType: 'image/png', data })
      }
      // 外部 Chrome（本机已安装的浏览器）——供 pi 扩展主动接入/断开
      if (req.method === 'POST' && path === '/external/open') {
        return json(res, 200, await this.openExternalChrome(String(body.url ?? EXTERNAL_CHROME_URL)))
      }
      if (req.method === 'POST' && path === '/external/close') {
        return json(res, 200, await this.closeExternalChrome())
      }
      if (req.method === 'POST' && path === '/request-user-control') return json(res, 200, this.requestUserControl())
      if (req.method === 'POST' && path === '/set-user-control') return json(res, 200, this.setUserControl(Boolean(body.value)))
      if (req.method === 'POST' && path === '/evaluate') {
        // 不提供任意页面 JavaScript：能力面只保留结构化的 observe/click/type/…，
        // 避免把“执行任意脚本”变成一个隐式工具。
        return json(res, 403, { ok: false, error: '默认禁止任意页面 JavaScript；请使用结构化浏览器工具' })
      }
      return json(res, 404, { ok: false, error: '未知浏览器操作' })
    } catch (error) {
      json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
