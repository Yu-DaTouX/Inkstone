import type { BrowserNetworkSnapshot, BrowserObservation, BrowserState, BrowserTabState } from '../../shared/ipc'
import type { BrowserCommandHost, BrowserObservationResult } from '../agent'
import type { BrowserActionOptions, BrowserActionReceipt, BrowserObserveOptions } from '../browser/receipt'
import type { ScrollPosition } from '../browser/InputController'
import { pressKey } from '../browser/driver/keyboard'
import { CURSOR_MARKUP, CURSOR_STYLE } from '../browser/AgentCursor'
import { BridgeCallError, type BridgeConnection } from './bridge-server'

export const USER_TAB_PREFIX = 'user:'
const SETTLE_MS = 250
const ACTION_LOAD_WAIT_MS = 10_000
const SCREENSHOT_TIMEOUT_MS = 60_000
const NAVIGATE_TIMEOUT_MS = 45_000

export class UserBrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'UserBrowserError'
  }
}

interface TabInfo {
  tabId: number
  url: string
  title: string
  status: string
  active?: boolean
  incognito?: boolean
}

interface TrackedTab {
  tabId: number
  owned: boolean
  url: string
  title: string
  loading: boolean
}

interface ObservedPage {
  url: string
  title: string
  text: string
  elements: BrowserObservation['elements']
  viewport?: { width: number; height: number }
  frameCount?: number
  observedFrameCount?: number
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export function userTabId(tabId: number): string {
  return `${USER_TAB_PREFIX}${tabId}`
}

export function parseUserTabId(id: string | undefined): number | null {
  if (!id?.startsWith(USER_TAB_PREFIX)) return null
  const value = Number(id.slice(USER_TAB_PREFIX.length))
  return Number.isInteger(value) && value >= 0 ? value : null
}

export function browserLabel(info: BridgeConnection['info']): string {
  const name = info.browser === 'firefox' ? 'Firefox' : info.browser === 'edge' ? 'Edge' : 'Chrome'
  const major = info.browserVersion.split('.')[0]
  return major ? `${name} ${major}` : name
}

function checkUrl(raw: string): string {
  if (raw === 'about:blank') return raw
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UserBrowserError('invalid_url', `不是有效地址：${raw}`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new UserBrowserError('unsupported_url', `用户浏览器只打开 http(s) 地址，收到 ${url.protocol}`)
  return url.href
}

function failure(error: unknown): BrowserObservationResult {
  if (error instanceof UserBrowserError || error instanceof BridgeCallError) return { ok: false, code: error.code, error: error.message }
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export class UserBrowserSession implements BrowserCommandHost {
  private readonly tabs = new Map<number, TrackedTab>()
  private active: number | null = null
  private generation = 0

  constructor(readonly sessionId: string, private connection: BridgeConnection) {}

  get info(): BridgeConnection['info'] {
    return this.connection.info
  }

  get connected(): boolean {
    return this.connection.open
  }

  rebind(connection: BridgeConnection): void {
    this.connection = connection
  }

  ownsTab(tabId: number): boolean {
    return this.tabs.has(tabId)
  }

  tabRemoved(tabId: number): void {
    this.tabs.delete(tabId)
    if (this.active === tabId) this.active = [...this.tabs.keys()].at(-1) ?? null
  }

  async pruneClosedTabs(): Promise<void> {
    for (const tabId of [...this.tabs.keys()]) {
      const info = await this.call<TabInfo | null>('tab.info', { tabId }).catch(() => null)
      if (!info) this.tabRemoved(tabId)
      else this.remember(info)
    }
  }

  private async call<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (!this.connection.open) {
      throw new UserBrowserError('user_browser_disconnected', '用户浏览器已断开（浏览器或扩展已关闭）。请用户确认浏览器与砚扩展在运行；或用 yan browser disconnect-user 切回内置浏览器。')
    }
    return this.connection.call<T>(cmd, args, timeoutMs)
  }

  private remember(info: TabInfo, owned?: boolean): TrackedTab {
    const previous = this.tabs.get(info.tabId)
    const tab: TrackedTab = {
      tabId: info.tabId,
      owned: owned ?? previous?.owned ?? false,
      url: info.url,
      title: info.title,
      loading: info.status === 'loading'
    }
    this.tabs.set(info.tabId, tab)
    return tab
  }

  private requireActive(): number {
    if (this.active === null || !this.tabs.has(this.active)) {
      throw new UserBrowserError('browser_not_open', '用户浏览器里还没有砚的标签：先用 yan browser navigate --url <地址> 打开页面，或用 use-current-tab 接管用户当前标签')
    }
    return this.active
  }

  get trustedInput(): boolean {
    return this.connection.info.debugger && this.connection.info.browser !== 'firefox'
  }

  getState(): BrowserState {
    const active = this.active !== null ? this.tabs.get(this.active) : undefined
    const tabs: BrowserTabState[] = [...this.tabs.values()].map((tab) => ({
      id: userTabId(tab.tabId),
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: false,
      canGoForward: false
    }))
    return {
      sessionId: this.sessionId,
      open: tabs.length > 0,
      url: active?.url ?? '',
      title: active?.title ?? '',
      loading: active?.loading ?? false,
      canGoBack: false,
      canGoForward: false,
      tabs,
      ...(active ? { activeTabId: userTabId(active.tabId) } : {}),
      mode: 'user'
    }
  }

  shareTab(info: TabInfo): BrowserState {
    this.remember(info, this.tabs.get(info.tabId)?.owned ?? false)
    this.active = info.tabId
    return this.getState()
  }

  async currentTab(): Promise<TabInfo | null> {
    return this.call<TabInfo | null>('tab.current')
  }

  async tabInfo(tabId: number): Promise<TabInfo | null> {
    return this.call<TabInfo | null>('tab.info', { tabId })
  }

  async navigate(raw: string): Promise<{ ok: boolean; error?: string; code?: string }> {
    try {
      const url = checkUrl(raw)
      const current = this.active !== null ? this.tabs.get(this.active) : undefined
      if (!current?.owned) {
        const info = await this.call<TabInfo>('tab.create', { url }, NAVIGATE_TIMEOUT_MS)
        this.remember(info, true)
        this.active = info.tabId
      } else {
        this.remember(await this.call<TabInfo>('tab.navigate', { tabId: current.tabId, url }, NAVIGATE_TIMEOUT_MS))
      }
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  }

  private async history(cmd: 'tab.back' | 'tab.forward' | 'tab.reload'): Promise<{ ok: boolean; error?: string; code?: string }> {
    try {
      const tabId = this.requireActive()
      this.remember(await this.call<TabInfo>(cmd, { tabId }, NAVIGATE_TIMEOUT_MS))
      return { ok: true }
    } catch (error) {
      return failure(error)
    }
  }

  back(): Promise<{ ok: boolean; error?: string; code?: string }> {
    return this.history('tab.back')
  }

  forward(): Promise<{ ok: boolean; error?: string; code?: string }> {
    return this.history('tab.forward')
  }

  reload(): Promise<{ ok: boolean; error?: string; code?: string }> {
    return this.history('tab.reload')
  }

  async newTab(url?: string): Promise<BrowserState> {
    const info = await this.call<TabInfo>('tab.create', { url: url ? checkUrl(url) : 'about:blank' }, NAVIGATE_TIMEOUT_MS)
    this.remember(info, true)
    this.active = info.tabId
    return this.getState()
  }

  async switchTab(id: string): Promise<BrowserState> {
    const tabId = parseUserTabId(id)
    if (tabId === null || !this.tabs.has(tabId)) throw new UserBrowserError('tab_not_found', `没有标签 ${id}；用 yan browser state 查看砚在用户浏览器里的标签`)
    const info = await this.call<TabInfo | null>('tab.info', { tabId })
    if (!info) {
      this.tabRemoved(tabId)
      throw new UserBrowserError('tab_not_found', `标签 ${id} 已被关闭`)
    }
    this.remember(info)
    this.active = tabId
    return this.getState()
  }

  async closeTab(id?: string): Promise<BrowserState> {
    const tabId = id ? parseUserTabId(id) : this.active
    if (tabId === null || !this.tabs.has(tabId)) throw new UserBrowserError('tab_not_found', `没有标签 ${id ?? ''}；用 yan browser state 查看砚在用户浏览器里的标签`)
    const tab = this.tabs.get(tabId)!
    if (tab.owned) await this.call('tab.close', { tabId }).catch(() => undefined)
    else await this.call('cdp.detach', { tabId }).catch(() => undefined)
    this.tabRemoved(tabId)
    return this.getState()
  }

  async release(): Promise<void> {
    for (const tabId of this.tabs.keys()) await this.call('cdp.detach', { tabId }).catch(() => undefined)
    this.tabs.clear()
    this.active = null
  }

  async openExternalChrome(): Promise<{ ok: boolean; error?: string; code?: string }> {
    return { ok: false, code: 'user_browser_mode', error: '当前在操作用户浏览器；先 yan browser disconnect-user 切回内置浏览器，再 connect-chrome' }
  }

  async closeExternalChrome(): Promise<BrowserState> {
    return this.getState()
  }

  async observe(options: BrowserObserveOptions = {}): Promise<BrowserObservation> {
    const tabId = this.requireActive()
    const page = await this.call<ObservedPage>('page.observe', { tabId })
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.url = page.url || tab.url
      tab.title = page.title
    }
    this.generation += 1
    const observation: BrowserObservation = {
      generationId: `${userTabId(tabId)}:${this.generation}`,
      url: page.url,
      title: page.title,
      text: page.text,
      elements: page.elements,
      accessibilityNodeCount: page.elements.length,
      ...(page.frameCount !== undefined ? { frameCount: page.frameCount } : {}),
      ...(page.observedFrameCount !== undefined ? { observedFrameCount: page.observedFrameCount } : {}),
      ...(page.viewport ? { viewport: page.viewport } : {})
    }
    if (options.scope) observation.scopeRefs = await this.call<string[]>('page.scope', { tabId, ref: options.scope })
    return observation
  }

  async text(): Promise<{ text: string; url: string; title: string }> {
    return this.call<{ text: string; url: string; title: string }>('page.text', { tabId: this.requireActive() })
  }

  async network(): Promise<BrowserNetworkSnapshot> {
    throw new UserBrowserError('user_browser_unsupported', '用户浏览器不提供网络记录；需要时用 yan browser disconnect-user 切回内置浏览器')
  }

  private async settle(tabId: number, receipt: BrowserActionReceipt = {}): Promise<BrowserObservationResult> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    const info = await this.call<TabInfo | null>('tab.wait', { tabId, timeoutMs: ACTION_LOAD_WAIT_MS }, ACTION_LOAD_WAIT_MS + 5_000).catch(() => null)
    if (info) this.remember(info)
    const observation = await this.observe()
    return { ok: true, observation, ...(Object.keys(receipt).length ? { receipt } : {}) }
  }

  private cdp(tabId: number) {
    return (method: string, params?: Record<string, unknown>) => this.call<Record<string, unknown>>('cdp', { tabId, method, params: params ?? {} })
  }

  private async cursor(tabId: number, label: string, point?: { x: number; y: number } | null, tap = true): Promise<void> {
    try {
      const ms = await this.call<number>('page.cursor', { tabId, label, point: point ?? null, tap, style: CURSOR_STYLE, markup: CURSOR_MARKUP }, 5_000)
      if (typeof ms === 'number' && ms > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 450)))
    } catch {}
  }

  private async aim(tabId: number, ref: string, label: string): Promise<void> {
    const point = await this.call<{ x: number; y: number } | null>('page.point', { tabId, ref }).catch(() => null)
    await this.cursor(tabId, label, point)
  }

  async click(ref: string, _options?: BrowserActionOptions): Promise<BrowserObservationResult> {
    try {
      const tabId = this.requireActive()
      const point = await this.call<{ x: number; y: number; obscuredBy?: string }>('page.point', { tabId, ref })
      if (point.obscuredBy) {
        return { ok: false, code: 'ELEMENT_OBSCURED', error: `元素 ${ref} 被 ${point.obscuredBy} 挡住，没有点击。先处理遮挡层（点它的关闭 / 同意按钮或按 Escape），再 observe 后重试。` }
      }
      await this.cursor(tabId, '点击', point)
      if (this.trustedInput) {
        const send = this.cdp(tabId)
        const at = { x: point.x, y: point.y }
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', clickCount: 1 })
      } else {
        await this.call('page.click', { tabId, ref })
      }
      return await this.settle(tabId)
    } catch (error) {
      return failure(error)
    }
  }

  async type(ref: string, text: string, _options?: BrowserActionOptions): Promise<BrowserObservationResult> {
    try {
      const tabId = this.requireActive()
      let value: string | null = null
      await this.aim(tabId, ref, '输入')
      if (this.trustedInput && text) {
        await this.call('page.focus', { tabId, ref })
        await this.cdp(tabId)('Input.insertText', { text })
        value = await this.call<string | null>('page.readValue', { tabId, ref }).catch(() => null)
      } else {
        const result = await this.call<{ ok?: boolean; error?: string; tag?: string; value?: string }>('page.type', { tabId, ref, text })
        if (result?.error === 'not_editable') return { ok: false, code: 'NOT_EDITABLE', error: `元素 ${ref} 不能输入（<${result.tag ?? '?'}>）。输入框才能用 type；下拉框用 select，按钮用 click。` }
        value = result?.value ?? null
      }
      return await this.settle(tabId, { value })
    } catch (error) {
      return failure(error)
    }
  }

  async select(ref: string, value: string, _options?: BrowserActionOptions): Promise<BrowserObservationResult & { chosen?: { value: string; label: string } }> {
    try {
      const tabId = this.requireActive()
      await this.aim(tabId, ref, '选择')
      const result = await this.call<{ ok?: boolean; error?: string; tag?: string; value?: string; label?: string; options?: string[] }>('page.select', { tabId, ref, value })
      if (result?.error === 'not_select') return { ok: false, code: 'NOT_SELECT', error: `元素 ${ref} 不是下拉框（<${result.tag ?? '?'}>）。下拉框才能用 select；文本框用 type，按钮用 click。` }
      if (result?.error === 'option_not_found') {
        const list = (result.options ?? []).slice(0, 20).join(' / ')
        return { ok: false, code: 'OPTION_NOT_FOUND', error: `下拉框 ${ref} 里没有「${value}」。可选值：${list || '（空）'}` }
      }
      const outcome = await this.settle(tabId)
      return { ...outcome, chosen: { value: String(result?.value ?? ''), label: String(result?.label ?? '') } }
    } catch (error) {
      return failure(error)
    }
  }

  async press(key: string, _options?: BrowserActionOptions): Promise<BrowserObservationResult> {
    try {
      const tabId = this.requireActive()
      const chord = String(key ?? '').trim()
      if (!chord) return { ok: false, code: 'INVALID_KEY', error: '缺少按键' }
      await this.cursor(tabId, '按键')
      if (this.trustedInput) {
        try {
          await pressKey({ cdp: this.cdp(tabId), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, chord)
        } catch (error) {
          if (error instanceof TypeError) return { ok: false, code: 'INVALID_KEY', error: error.message }
          throw error
        }
      } else {
        await this.call('page.press', { tabId, key: chord })
      }
      return await this.settle(tabId)
    } catch (error) {
      return failure(error)
    }
  }

  async scroll(deltaX: number, deltaY: number): Promise<BrowserObservationResult> {
    try {
      const tabId = this.requireActive()
      await this.cursor(tabId, '滚动')
      const scroll = await this.call<ScrollPosition>('page.scroll', { tabId, dx: deltaX, dy: deltaY })
      return await this.settle(tabId, scroll ? { scroll } : {})
    } catch (error) {
      return failure(error)
    }
  }

  requestUserControl(): BrowserState {
    return this.getState()
  }

  async screenshot(): Promise<{ mimeType: string; data: Buffer }> {
    const shot = await this.call<{ data: string }>('page.screenshot', { tabId: this.requireActive() }, SCREENSHOT_TIMEOUT_MS)
    return { mimeType: 'image/png', data: Buffer.from(shot.data, 'base64') }
  }
}
