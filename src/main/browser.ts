/*
 * 内置浏览器控制器。
 *
 * 架构：页面是主进程持有的原生 WebContentsView（不是 iframe），renderer 只画
 * 工具栏并把可见区域坐标同步过来；模型侧入口是 `yan browser …`（01-S4b），
 * 由 `AgentController.runBrowserCommand` 直接调本类方法。
 *
 *   renderer(BrowserSurface) ──IPC──► BrowserController ──CDP──► 网页
 *   pi ──bash──► `yan browser …` ──能力服务──► 同一个 BrowserController
 *
 * 01-S5d（2026-09-23）删掉了 `browser.js` 空壳扩展与只服务于它的 loopback
 * HTTP bridge：宿主自己在同一进程里，不需要网络层与 token。
 *
 * 底层算法拆在 ./browser/：CDPBridge / Observer / ElementRegistry /
 * InputController / BrowserPolicy / geometry。可读性从上往下读本文件即可，
 * 细节再进子目录。
 */
import type { ChildProcess } from 'node:child_process'
import { app, shell, WebContentsView, type BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  BrowserBlockedRequest,
  BrowserBounds,
  BrowserObservation,
  BrowserPermissionRecord,
  BrowserState,
  BrowserTabState,
  MainPush
} from '../shared/ipc'
import { BrowserPolicy } from './browser/BrowserPolicy'
import { failureUrl, shouldSurfaceLoadError } from '../shared/browser-navigation'
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
import { syncLocalChromeData, type ChromeSyncReport } from './chrome-profile'
import { YAN_DIR } from './paths'
import { transferCookies } from './browser/cookie-transfer'
import { transferPageStorage } from './browser/storage-transfer'
import { resolvesToPrivateAddress } from './browser/network-policy'
import { decideRequestBoundary } from './browser/network-boundary'

type Push = (msg: MainPush) => void
type BrowserActionResult = { ok: boolean; error?: string; code?: string }
const INITIAL_URL = 'https://www.google.com/'
/** 接入本机 Chrome 时默认打开的页面（用户要操作的 ChatGPT 网页版） */
const EXTERNAL_CHROME_URL = 'https://chatgpt.com'

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

/*
 * 网络边界判定（`isPrivateHost` / `isLoopbackOrigin` / `decideRequestBoundary`）
 * 住在 `browser/network-boundary.ts` —— 纯函数，有单测；这里只负责把判定结果
 * 落成「放行 / 拦下并记账 / 再解析一次」。
 */

/**
 * 权限只按 origin 判断，不把页面路径/查询参数当成权限范围。
 * `about:blank`、file 和自定义协议没有可授予的远程站点 origin。
 */
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
  /** 界面用的状态（`url` 会在导航发起时乐观写入，见 `open()`） */
  state: BrowserTabState
  /**
   * **已提交**的文档地址（`did-navigate` 才更新）。
   *
   * 为什么要跟 `state.url` 分开：网络边界判定要看“谁在发这个请求”，
   * 而 `state.url` 是导航一开始就写进去的**期望值** —— 拿它判发起方，
   * 目标地址会被当成发起方自己，判定直接失效（2026-09-16 实测：
   * 远程页面 → 127.0.0.1 的顶层导航因此没被拦住）。
   */
  committedUrl: string
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
  /** 本次接入时从真实 Chrome 同步数据的结果（供界面如实展示哪几项没同步） */
  syncReport?: ChromeSyncReport
}

/** 两种渲染模式共用的「可观察目标」抽象 */
interface TargetParts {
  cdp: CdpChannel
  registry: ElementRegistry
  observer: Observer
  input: InputController
}

/** 浏览器运行时（**宿主独占**）。模型侧入口是 `yan browser …`，不再提供 HTTP bridge。 */
export class BrowserController {
  private readonly tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private userControl = false
  private lastDownload: BrowserState['lastDownload']
  private nativeBounds: BrowserBounds | undefined
  private downloadSessionAttached = false
  /** 权限管理器是否已挂（session 是共享的，只能挂一次） */
  private permissionHandlerAttached = false
  /**
   * 被拒绝的权限请求（方案 9.2）。
   * 为什么要记：默认拒绝是安全默认，但用户得**能看到**自己网站要过什么、
   * 被拒了什么，否则遇到“摄像头点了没反应”只能猜。
   */
  private permissionLog: BrowserPermissionRecord[] = []
  /**
   * 被网络边界拦下的请求（本地预览 / DNS 重绑定）。
   *
   * 拦截是静默发生的（请求直接 cancel），所以不给记录的话，用户只会看到
   * “这个页面就是打不开”。只留主机名与原因，不带路径/查询参数/页面内容。
   */
  private blockedRequests: BrowserBlockedRequest[] = []
  /** 逐站权限是临时的：进程退出即清空，不写入设置或浏览器 profile。 */
  private readonly permissionGrants = new Set<string>()
  /** DNS 只短暂缓存，避免每个图片/字体请求都重复解析而留下长窗口。 */
  private readonly privateDnsCache = new Map<string, { private: boolean; expiresAt: number }>()
  /**
   * 我们自己（用户敲地址栏 / agent 调 `browser_open`）正在发起的顶层导航。
   *
   * 有什么用：内网地址的顶层导航放不放行，取决于“是用户/agent 明确要求，
   * 还是远程页面想借道”—— 后者在 `details` 里没有 initiator 字段，
   * 只能靠“这次导航是不是我们发起的”来区分（见 onBeforeRequest 的注释）。
   */
  private pendingMainFrameUrl: string | null = null
  /** 外部 Chrome 目标；可与内嵌标签同时存在 */
  private external: ExternalTarget | null = null
  private activeMode: 'embedded' | 'external' = 'embedded'

  private externalTabId(targetId: string): string {
    return `chrome:${targetId}`
  }

  private externalTargetId(tabId: string): string | null {
    return tabId.startsWith('chrome:') ? tabId.slice('chrome:'.length) : null
  }
  /** 外部 Chrome 下载：guid → 文件名（downloadWillBegin 先到，进度事件用 guid 关联） */
  /** 外部 Chrome 下载：guid → 建议文件名 + 源 URL（来源要能显示给用户） */
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
    private readonly push: Push
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
      /* 外部 Chrome 的失败不在这里表达（它有自己的同步报告） */
      loadError: activeIsExternal ? undefined : active?.state.loadError,
      permissions: this.permissionLog,
      blockedRequests: this.blockedRequests,
      nativeBounds: this.nativeBounds,
      mode: ext ? 'external' : 'embedded',
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
    this.state = this.getState()
    this.publish()
  }

  /**
   * 取当前可观察目标：外部 Chrome 优先，否则是内嵌活动标签页。
   * 两种目标都提供 cdp / registry / observer / input，调用方不用分叉。
   */
  private parts(): TargetParts | null {
    if (this.external && this.activeMode === 'external') return this.external
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
      state: { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
      committedUrl: ''
    }
    view.webContents.on('did-start-loading', () => {
      tab.state.loading = true
      /* 新一次导航开始：上一次的失败提示到此为止 */
      tab.state.loadError = undefined
      this.updateState()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.state.loading = false
      this.pendingMainFrameUrl = null
      this.syncTabNavigation(tab)
      tab.registry.clear()
      this.updateState()
    })
    view.webContents.on('did-navigate', (_event, url) => {
      tab.state.url = url
      tab.committedUrl = url
      tab.state.loadError = undefined
      this.pendingMainFrameUrl = null
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
    /*
     * 导航失败（含被网络边界拦住）也要把在途标记清掉，别让它留到下一次导航。
     *
     * H-9 第二阶段：主框架失败要把原因**推给界面** —— 否则用户看到的就是
     * “点了没反应”，只能自己猜。子框架失败（广告 iframe）不打扰用户，
     * 被取消的导航（ERR_ABORTED）也不算失败。
     */
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.pendingMainFrameUrl = null
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
      if (safeUrl(url)) void this.openBackgroundTab(url)
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
    if (!this.permissionHandlerAttached) {
      this.permissionHandlerAttached = true
      /*
       * 远程网页的权限一律**默认拒绝**（方案 9.1/9.2）。
       *
       * 摄像头 / 麦克风 / 定位 / 通知 / 剪贴板这些在 agent 场景里基本没有
       * 正当用途，而一旦放行，网页就拿到了真实设备能力。
       * 这里不用关键词猜“这个站点看起来可不可信”—— 一律拒绝，并把
       * 请求记下来给用户看；要放开时应该由用户显式授权（后续能力）。
       */
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

      /*
       * 本地预览边界（方案 9.2 第 4 点）。
       *
       * 编码场景需要 localhost 预览（dev server），但**远程页面**没理由
       * 去访问用户机器上的本地服务（那是一个常见的探测/攻击路径）。
       *
       * 三条策略（2026-09-16 改成显式判定，见 `pendingMainFrameUrl`）：
       *
       *   ① 地址本身就是内网（127/8、RFC1918、::1 …）
       *      · 由**用户/agent 明确要求**的顶层导航 → 放行（这就是本地预览）；
       *      · 其余（页面自己发起的导航、子资源、XHR）→ 拦。
       *   ② 地址看着像公网域名、解析后却落在内网（DNS 重绑定）→ **一律拦**，
       *      连我们自己发起的导航也不放行 —— 那时用户以为自己在开一个外部地址，
       *      而 agent 可能只是被页面上的一句话诱导，真放行等于给它一个
       *       “读本机服务”的原语。
       *
       * 为什么不用 `state.url` 判发起方：它是导航发起时就写进去的**期望值**，
       * 判定会变成拿目标地址跟自己比，于是远程页面 → 127.0.0.1 的顶层导航
       * 反而被放过（现已由 `committedUrl` + `pendingMainFrameUrl` 取代）。
       *
       * ⚠️ 已知局限（如实写在代码里，不假装完备）：
       *   · 拿不到已提交文档（新标签第一次导航）时一律放行 —— 宁可少拦，
       *     也不把正常请求误杀；
       *   · 判定用 Node 的解析器，而真正发请求的是 Chromium。正常配置下两者
       *     看到同一份 DNS，但它不是网络栈级别的隔离（彻底封住需要单独代理）。
       */
      ses.webRequest.onBeforeRequest((details, callback) => {
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
        /* 发起方 = **已提交**的文档；拿不到已提交文档时判定会放行（宁可少拦） */
        const initiator = owner?.committedUrl ?? ''
        const decision = decideRequestBoundary({
          targetHost: target.hostname,
          initiatorUrl: initiator,
          resourceType: details.resourceType,
          requestedByUs:
            details.resourceType === 'mainFrame' && this.pendingMainFrameUrl === details.url
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
        /*
         * URL 仍然是公网域名时也不能直接放过：域名可能在解析后切到
         * 127/8、RFC1918、IPv6 ULA 或 link-local。每个短缓存周期重新查，
         * 把 DNS rebinding 的目标挡在 Chromium 请求真正发出之前。
         *
         * 这一支**不看 `requestedByUs`**：地址看着是外部、实际落到内网，
         * 放行等于给 agent 一个「读本机服务」的原语（详见函数注释）。
         */
        void this.resolvesToPrivateTarget(target.hostname)
          .then((privateTarget) => {
            if (privateTarget) this.recordBlockedRequest(target.hostname, 'dns-rebind', initiator)
            callback(privateTarget ? { cancel: true } : {})
          })
          .catch(() => callback({}))
      })
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
    // 统一标签栏：切回内嵌标签，不断开外部 Chrome
    this.activeMode = 'embedded'
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
      /* 明确记下“这次导航是我们发起的”，供网络边界判定区分用户/页面发起 */
      this.pendingMainFrameUrl = next
      this.updateState()
      await tab.view.webContents.loadURL(next)
    }
    this.syncTabNavigation(tab)
    this.updateState()
    return this.getState()
  }

  /**
   * 网页自己开的窗口（`window.open` / `target=_blank`）。
   *
   * H-9 第二阶段：新标签要真建出来（内容不丢），但**不能夺走**用户
   * 正在阅读的那一页 —— 广告或授权弹窗把页面切走，用户会以为“点坏了”。
   * 与 `newTab()` 的区别只有一条：不改 `activeTabId`、新视图不设为可见。
   */
  private async openBackgroundTab(rawUrl: string): Promise<void> {
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
    this.pendingMainFrameUrl = url
    this.updateState()
    try {
      await tab.view.webContents.loadURL(url)
    } catch {
      /* 后台页加载失败只留在它自己的标签里（loadError），不打断当前阅读 */
    }
    this.syncTabNavigation(tab)
    this.updateState()
  }

  async newTab(rawUrl = INITIAL_URL): Promise<BrowserState> {
    const url = safeUrl(rawUrl)
    if (!url) throw new Error('只允许打开 http(s) 网页')
    // 外部 Chrome：新建一个真实标签页，并把 CDP 连接切过去
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
    for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === tab.id)
    tab.state.url = url
    tab.state.loading = true
    /* 同 `open()`：这是**我们**（用户/agent）发起的顶层导航 */
    this.pendingMainFrameUrl = url
    this.updateState()
    await tab.view.webContents.loadURL(url)
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
      this.activeMode = 'external'
      for (const tab of this.tabs.values()) tab.view.setVisible(false)
      await this.attachExternalTarget(target)
      return this.getState()
    }
    const tab = this.tabs.get(id)
    if (!tab) throw new Error('找不到浏览器标签页')
    this.activeMode = 'embedded'
    this.activeTabId = id
    for (const candidate of this.tabs.values()) candidate.view.setVisible(candidate.id === id)
    this.updateState()
    return this.getState()
  }

  async closeTab(id = this.activeTabId ?? ''): Promise<BrowserState> {
    // 外部 Chrome：关掉那个真实标签页
    const externalTargetId = this.externalTargetId(id)
    if (externalTargetId && this.external) {
      const ext = this.external
      const targetId = externalTargetId
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

  /* 外部 Chrome（本机已安装的浏览器） */

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
      this.activeMode = 'external'
      await this.navigateExternal(url)
      return { ok: true }
    }

    const port = await pickFreePort()
    const profileDir = defaultProfileDir(YAN_DIR)
    let chrome: ChildProcess | null = null
    try {
      await mkdir(profileDir, { recursive: true })
      /*
       * 先把真实 Chrome 的登录态与历史导入托管 profile ——
       * 否则这个 profile 是空白的，用户会看到「cookie 和历史没有共享」。
       * 逐项容错：cookie 在 Chrome 开着时拿不到，但历史/书签照样能同步；
       * 具体结果存进 syncReport 交给界面如实展示，不在这里决定成败。
       */
      const syncReport = existsSync(join(profileDir, 'Local State'))
        ? undefined
        : await syncLocalChromeData(profileDir)
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
        chromeTabs: [],
        syncReport
      }
      this.activeMode = 'external'
      for (const tab of this.tabs.values()) tab.view.setVisible(false)
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
      /*
       * `url` 是发起下载的地址 —— 存下来才能在界面上显示来源。
       * 以前只记文件名，于是外部 Chrome 的下载在界面上是个“无来源文件”，
       * 用户无从判断它来自哪个网站（内置浏览器的下载则是带来源的）。
       */
      const url = String(params.url ?? '')
      if (guid && name) this.externalDownloads.set(guid, { filename: name, url })
    })
    cdp.on('Browser.downloadProgress', (params) => {
      if (String(params.state ?? '') !== 'completed') return
      const guid = String(params.guid ?? '')
      const begun = this.externalDownloads.get(guid)
      const filename = begun?.filename ?? `download-${Date.now()}`
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

  /**
   * 手动重新同步本机 Chrome 数据。
   *
   * 场景：用户先点了「接入」但当时 Chrome 还开着（cookie 没同步到），
   * 后来退出了 Chrome 再点这个 —— 此时 cookie 能拷了。
   * 因为托管 Chrome 已经把旧 cookie 读进内存，**必须重启才能生效**，
   * 所以同步到 cookie 且当前已连接时自动重开一次（否则用户会以为又没生效）。
   */
  async syncLocalProfile(): Promise<ChromeSyncReport> {
    // A connected managed Chrome is a live session, never a file-copy target.
    // Copy from the active browser to the other browser using Chromium's API.
    if (this.external) {
      const embedded = this.activeTab() ?? this.createTab()
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
    const embedded = this.activeTab() ?? this.createTab()
    const externalUrl = this.external.url
    const embeddedUrl = embedded.state.url
    if (new URL(externalUrl).origin !== new URL(embeddedUrl).origin) throw new Error('两个页面必须处于同一网站，才能复制当前页面存储')
    const from = this.activeMode === 'external' ? this.external.cdp : embedded.cdp
    const to = this.activeMode === 'external' ? embedded.cdp : this.external.cdp
    const results = await Promise.all([transferPageStorage(from, to, 'localStorage'), transferPageStorage(from, to, 'sessionStorage')])
    const report: ChromeSyncReport = { found: true, chromeRunning: true, cookiesSynced: false, source: this.activeMode === 'external' ? 'Chrome 当前页面' : '内置浏览器当前页面', target: this.activeMode === 'external' ? '内置浏览器当前页面' : 'Chrome 当前页面', copied: results.map((r) => `${r.kind}: ${r.copied}`), failed: results.flatMap((r) => r.failed ? [{ item: r.kind, reason: `${r.failed} 项未能复制` }] : []) }
    this.external.syncReport = report
    this.updateState()
    return report
  }

  /** 断开外部 Chrome，并关掉我们拉起的那个进程 */
  async closeExternalChrome(): Promise<BrowserState> {
    const ext = this.external
    if (!ext) return this.getState()
    this.external = null
    await ext.cdp.detach().catch(() => undefined)
    stopChrome(ext.chrome)
    this.activeMode = 'embedded'
    const active = this.activeTab()
    for (const tab of this.tabs.values()) tab.view.setVisible(tab.id === active?.id)
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

  /**
   * 临时隐藏 / 恢复原生网页视图。
   *
   * 为什么需要：`WebContentsView` 是**原生视图**，永远盖在 DOM 之上。
   * 文件预览/其它详情要占用同一块区域时，只用 CSS 是藏不住的（方案 5.2）；
   * 必须显式 setVisible(false)，关掉预览时再按当前模式恢复。
   */
  setViewVisible(visible: boolean): void {
    if (!visible) {
      for (const tab of this.tabs.values()) tab.view.setVisible(false)
      return
    }
    /* 外部 Chrome 是独立窗口，没有内嵌视图要恢复 */
    if (this.activeMode !== 'embedded') return
    for (const tab of this.tabs.values()) tab.view.setVisible(tab.id === this.activeTabId)
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
  }

  async observe(): Promise<BrowserObservation> {
    const p = this.parts()
    if (!p) throw new Error('浏览器尚未打开')
    await p.cdp.attach()
    if (this.external && this.activeMode === 'external') {
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

  /*
   * 下面四个动作（click / type / press / scroll）与 requestUserControl、
   * screenshot 从 private 改为 public（01-S4b）。
   *
   * 原因：模型工具 `browser_*` 已移除，宿主能力服务（agent.ts 的
   * `runBrowserCommand`）要**直接调这些服务方法** —— 它们以前只服务于
   * loopback bridge 的内部 HTTP 路由，所以是 private。
   * 注意权限 / 网络边界**一点没动**：BrowserPolicy、resolve()、userControl
   * 门禁、safeUrl、网络边界判定全部原样生效，改的只是方法可见性。
   */
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
      return { ok: true, observation: await this.observe() }
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
      return { ok: true, observation: await this.observe() }
    } catch (error) {
      return this.actionError(error)
    }
  }

  async press(key: string): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
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

  async scroll(deltaX: number, deltaY: number): Promise<BrowserActionResult & { observation?: BrowserObservation }> {
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

  /**
   * 把页面交给用户（密码 / 验证码 / 支付等敏感步骤）。
   *
   * 只翻转 `userControl` 门禁并广播状态：后续 click / type / press / scroll
   * 一律被拒（code `USER_CONTROL_ACTIVE`），直到用户或界面恢复。
   * `reason` **不在这里记**：旧路径（HTTP bridge）也从未把它落盘或展示，
   * 本次迁移不为它新增用户可见功能（01-S4b 的边界）。
   */
  requestUserControl(): BrowserState {
    this.userControl = true
    this.updateState()
    return this.getState()
  }

  /**
   * 当前页面截图（PNG 原始字节）。
   *
   * 以前只有 bridge 路由用得到，所以 base64 编码写在路由里；现在宿主能力服务
   * 自己调用，就直接返回 Buffer，由调用方决定怎么落盘 ——
   * 这里**不写文件**，路径决策不归控制器。
   */
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

  /**
   * 临时允许/撤销某站点的一项权限。撤销会立即影响后续 check/request；
   * 页面若已经拿到设备流，仍须由网页自身停止，不能假装这里能回收系统资源。
   */
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

  /**
   * 记下一次被网络边界拦下的请求。
   *
   * 去重规则：同一「目标主机 + 原因」只留一条，`count` 累加、`from` 更新为
   * 最近一次发起方 —— 一个页面往往会在同一 host 上撞好几次
   *（导航 + favicon + 子资源），逐条堆叠只会把列表冲成一堵墙。
   */
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
    this.updateState()
  }

  private async resolvesToPrivateTarget(hostname: string): Promise<boolean> {
    const key = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    const cached = this.privateDnsCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.private
    const privateTarget = await resolvesToPrivateAddress(key)
    this.privateDnsCache.set(key, { private: privateTarget, expiresAt: Date.now() + 2000 })
    return privateTarget
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

  private async handleDownload(item: Electron.DownloadItem): Promise<void> {
    const directory = app.getPath('downloads')
    await mkdir(directory, { recursive: true })
    const filename = item.getFilename().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `download-${Date.now()}`
    const path = join(directory, filename)
    /*
     * 下载**不自动执行**（方案 9.2）：只落盘到系统下载目录并告知来源，
     * 是否打开由用户自己决定。
     */
    const origin = item.getURL()
    item.setSavePath(path)
    item.once('done', (_event, state) => {
      if (state !== 'completed') return
      /* 带上来源：用户要能看出「这个文件是从哪来的」（方案 9.2） */
      this.lastDownload = { path, filename, size: item.getReceivedBytes(), source: origin }
      this.updateState()
    })
  }

  private pushError(detail: string): void {
    this.push({ ch: 'notify', payload: { id: `browser-${Date.now()}`, method: 'notify', notifyType: 'error', message: detail } })
  }
}
