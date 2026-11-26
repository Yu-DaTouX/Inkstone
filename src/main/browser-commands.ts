import type { BrowserCommandHost, BrowserObservationResult, CapabilityRunOptions } from './agent'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveLocalFile } from './browser/local-file-server'
import { CapabilityCommandError } from './capability-server'
import { WAIT_POLL_MS, describeWait, parseWaitCondition, sameWaitElement, waitSatisfied, type WaitElement } from '../shared/browser-wait'
import { YAN_DIR } from './paths'
import type { BrowserObservation, BrowserNetworkSnapshot, BrowserState } from '../shared/ipc'
import { browserLocks } from './browser/browser-locks'
import { receiptSummary, type BrowserActionOptions } from './browser/receipt'
import { ALL_ITEM_LIMIT, ITEM_LIMIT, diffObservations, elementLine, filterElements, textMatches, type ObservedPage } from './browser/observation-format'
import { hostname } from 'node:os'
import { normalizeConsentParts, type ConsentAnswer, type ConsentKeyParts, type ConsentVerdict } from '../shared/tool-consent'
import { userBrowser } from './user-browser/service'
import { UserBrowserError, browserLabel } from './user-browser/session-host'
import { BRIDGE_REVISION, BridgeCallError } from './user-browser/bridge-server'

const ACTION_TIMEOUT_MS = 60_000
const CONFIRMING_ACTIONS = new Set(['state', 'observe', 'wait', 'screenshot', 'text'])
const USER_BROWSER_REASON = '会使用你在这个浏览器里的真实登录状态和数据'
const SCRIPT_MAX_BYTES = 1024 * 1024
const RESULT_PREVIEW_CHARS = 4000
const LOG_TAIL_LINES = 20
const LOG_LINE_CHARS = 300
const TEXT_DEFAULT_CHARS = 4000
const TEXT_MAX_CHARS = 20_000

function flag(value: unknown): boolean {
  return value === true || value === 'true' || value === '' || value === '1'
}

class ActionTimeoutError extends Error {}

function userBrowserFailure(error: unknown): unknown {
  if (error instanceof UserBrowserError || error instanceof BridgeCallError) return new CapabilityCommandError(error.code, error.message)
  return error
}

function withActionTimeout<T>(action: string, work: Promise<T>): Promise<T> {
  if (action === 'wait' || action === 'run' || action === 'connect-user' || action === 'use-current-tab') return work
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ActionTimeoutError(action)), ACTION_TIMEOUT_MS)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

export interface BrowserCommandsHost {
  browserHostOrNull(): BrowserCommandHost | null
  capabilityOpts(): CapabilityRunOptions | undefined
  conversationId?(): string | undefined
  cwd?(): string
  isActive?(): boolean
  confirmToolConsent?(request: { parts: ConsentKeyParts; purpose: string; verdict: ConsentVerdict; sessionGrant?: false }): Promise<ConsentAnswer | null>
}

export class BrowserCommands {
  private readonly owner = `browser-${randomUUID()}`
  private refs = new Set<string>()
  private lastElements = new Map<string, WaitElement>()
  private lastObservation: ObservedPage | undefined
  private targetId: string | undefined
  private identity?: string
  constructor(private readonly ctl: BrowserCommandsHost) {}


  async runBrowserCommand(
    action: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const opts = this.ctl.capabilityOpts()
    const identity = `${opts?.sessionId ?? 'host'}:${opts?.runnerGeneration ?? 0}`
    const owner = `${identity}:${this.owner}`
    try {
      const external = (): boolean => {
        const current = this.browserHost().getState()
        return Boolean(current.external) || current.mode === 'external' || current.mode === 'user'
      }
      return await browserLocks.run({ sessionId: this.browserSessionId(), owner, external, connecting: action === 'connect-chrome', confirming: CONFIRMING_ACTIONS.has(action) }, async (resourceId) => {
        if (this.identity !== identity) {
          this.refs.clear()
          this.lastObservation = undefined
          this.targetId = undefined
          this.identity = identity
        }
        const current = this.ctl.capabilityOpts()
        if (this.ctl.isActive?.() === false || `${current?.sessionId ?? 'host'}:${current?.runnerGeneration ?? 0}` !== identity) throw new CapabilityCommandError('run_expired', '运行已改变，旧排队操作未执行')
        const state = this.browserHost().getState()
        const userMutations = new Set(['run', 'navigate', 'open', 'back', 'forward', 'reload', 'new-tab', 'switch-tab', 'close-tab', 'connect-chrome', 'disconnect-chrome', 'connect-user', 'disconnect-user', 'use-current-tab', 'click', 'type', 'select', 'press', 'scroll'])
        if (state.userControl && userMutations.has(action)) {
          throw new CapabilityCommandError('USER_CONTROL_ACTIVE', '浏览器当前由用户接管，请等待用户恢复 Agent 控制。')
        }
        if (['click', 'type', 'select'].includes(action) || (action === 'observe' && this.browserText(params, 'in'))) {
          const ref = this.browserText(params, action === 'observe' ? 'in' : 'ref')
          if (ref && !this.refs.has(ref)) throw new CapabilityCommandError('STALE_ELEMENT', `元素引用 ${ref} 不在最新一次观察里：元素已经消失，或页面已导航 / 换了文档。重新 observe（或 observe --find <文字>）拿新的 ref；同一页面上没变的元素 ref 保持不变。`)
        }
        if ((['click', 'type', 'select', 'press', 'scroll'].includes(action) || (action === 'observe' && this.browserText(params, 'in'))) && this.targetId !== state.activeTabId) {
          throw new CapabilityCommandError('STALE_TARGET', '浏览器目标已改变，请重新 observe 后继续。')
        }
        let result: { data?: unknown; summary: Record<string, unknown> }
        const host = this.browserHost()
        if (userMutations.has(action)) {
          host.setAutomationOwner?.(owner)
          host.setAgentSession?.(this.browserSessionId())
        }
        try { signal?.throwIfAborted(); result = await withActionTimeout(action, this.execute(action, params, signal)) }
        catch (error) {
          const timedOut = error instanceof ActionTimeoutError
          if (timedOut || (userMutations.has(action) && !(error instanceof CapabilityCommandError))) {
            browserLocks.markUncertain(resourceId)
          }
          if (timedOut) throw new CapabilityCommandError('browser_action_timeout', `${action} ${ACTION_TIMEOUT_MS / 1000} 秒没有完成，结果未确认。先用 observe 或 state 核对页面，再决定下一步；不要直接重放。`)
          throw error
        }
        finally { if (userMutations.has(action)) host.setAutomationOwner?.() }
        if (result.data && typeof result.data === 'object' && 'lastDownload' in result.data) result.data = { ...result.data, lastDownload: host.getOwnedDownload?.(owner) }
        const observation = result.data as BrowserObservation | undefined
        if (observation && Array.isArray(observation.elements)) {
          if (state.activeTabId !== this.browserHost().getState().activeTabId) {
            this.refs.clear()
            this.lastObservation = undefined
            this.targetId = undefined
            throw new CapabilityCommandError('STALE_TARGET', '操作期间显示目标发生变化，动作可能已完成，请核对结果并重新 observe；不要重放动作。')
          }
          this.refs = new Set(observation.elements.map((e) => e.ref))
          this.lastElements = new Map(observation.elements.map((e) => [e.ref, e]))
          this.lastObservation = { url: observation.url, title: observation.title, text: observation.text, elements: observation.elements }
          this.targetId = this.browserHost().getState().activeTabId
        } else if (userMutations.has(action)) {
          this.refs.clear()
          this.lastObservation = undefined
          this.targetId = this.browserHost().getState().activeTabId ?? undefined
        }
        return result
      })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'waiting_resource') {
        throw new CapabilityCommandError('waiting_resource', error.message)
      }
      throw error
    }
  }

  private async execute(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    try {
      if (action === 'connect-user' || action === 'disconnect-user' || action === 'use-current-tab') return await this.userBrowserAction(action, params)
      return await this.executeAction(action, params, signal)
    } catch (error) {
      throw userBrowserFailure(error)
    }
  }

  private async askUser(capability: string, action: string, resource: string, purpose: string): Promise<boolean> {
    if (!this.ctl.confirmToolConsent) return false
    const normalized = normalizeConsentParts({ capability, action, resource: resource.slice(0, 200) }, `host:${hostname().toLowerCase()}`, 'local')
    if (!normalized.ok) return false
    const answer = await this.ctl.confirmToolConsent({ parts: normalized.parts, purpose: purpose.slice(0, 500), verdict: { danger: null, reason: USER_BROWSER_REASON }, sessionGrant: false })
    return answer?.decision === 'allow'
  }

  private async userBrowserAction(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const sessionId = this.browserSessionId()
    const reason = this.browserText(params, 'reason') ?? ''
    if (action === 'disconnect-user') {
      const had = await userBrowser.detach(sessionId)
      const builtIn = this.ctl.browserHostOrNull()
      const state = builtIn ? (builtIn.forSession?.(sessionId) ?? builtIn).getState() : { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
      return { data: state, summary: this.browserSummary(action, state, { disconnected: had, mode: state.mode ?? 'embedded' }) }
    }
    if (action === 'connect-user') {
      const connection = userBrowser.pick(this.browserText(params, 'browser'))
      const label = browserLabel(connection.info)
      const existing = userBrowser.hostFor(sessionId)
      if (!existing || existing.info.id !== connection.info.id) {
        const allowed = await this.askUser(`你的浏览器（${label}）`, '连接并替你操作网页', '使用你在这个浏览器里的登录状态', reason)
        if (!allowed) throw new CapabilityCommandError('user_browser_denied', '用户没有批准连接他的浏览器。改用内置浏览器，或先问用户。')
      }
      const host = userBrowser.attach(sessionId, connection)
      const state = host.getState()
      return {
        data: state,
        summary: this.browserSummary(action, state, {
          browser: label,
          trustedInput: host.trustedInput,
          ...(connection.info.revision < BRIDGE_REVISION ? { extensionStale: '用户浏览器里的扩展还在跑旧脚本（代理光标等新功能不可用），请用户在扩展管理页点一次「重新加载」' } : {}),
          hint: '之后的 yan browser 动作都作用于用户浏览器：navigate 在没有自己的标签或当前是共享标签时会在「砚」标签组里新开标签，否则在当前标签跳转；use-current-tab 接管用户正在看的标签；用完 disconnect-user 切回内置浏览器'
        })
      }
    }
    const host = userBrowser.hostFor(sessionId)
    if (!host) throw new CapabilityCommandError('user_browser_not_attached', '先用 yan browser connect-user 连接用户浏览器')
    const tab = await host.currentTab()
    if (!tab) throw new CapabilityCommandError('no_current_tab', '用户浏览器里没有当前标签')
    if (!/^https?:/i.test(tab.url)) throw new CapabilityCommandError('unsupported_url', `用户当前标签不是网页（${tab.url || '空白'}），不能接管`)
    let target = tab
    if (!host.ownsTab(tab.tabId)) {
      const allowed = await this.askUser(`你的浏览器（${browserLabel(host.info)}）`, '操作你当前打开的标签', `${tab.title} · ${tab.url}`, reason)
      if (!allowed) throw new CapabilityCommandError('user_browser_denied', '用户没有批准接管当前标签。')
      const latest = await host.tabInfo(tab.tabId)
      if (!latest) throw new CapabilityCommandError('tab_changed', '等待批准期间该标签已关闭，未接管。')
      if (latest.url !== tab.url) throw new CapabilityCommandError('tab_changed', `等待批准期间该标签地址已变化（从 ${tab.url} 变为 ${latest.url || '空白'}），未接管。`)
      target = latest
    }
    const state = host.shareTab(target)
    return { data: state, summary: this.browserSummary(action, state, { activeTabId: state.activeTabId, hint: '已接管用户当前标签：先 observe 再操作；close-tab 只是放开它，不会关闭用户的标签' }) }
  }

  private async executeAction(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const host = this.browserHost()
    switch (action) {
      case 'api': {
        const guide = await host.guide?.()
        if (!guide) throw new CapabilityCommandError('browser_script_unavailable', '当前浏览器不支持脚本')
        return { data: { guide }, summary: { kind: 'browser', action, ok: true, guide } }
      }
      case 'run': {
        const file = this.browserText(params, 'file')
        const inline = typeof params.code === 'string' && params.code.trim() ? params.code : undefined
        if (!file && !inline) throw new CapabilityCommandError('missing_code', 'run 需要 JavaScript：yan browser run --code - （从标准输入读，配 heredoc）、--code "<代码>" 或 --file <路径>')
        if (!host.runScript) throw new CapabilityCommandError('browser_script_unavailable', '当前浏览器不支持脚本')
        let code: string
        if (inline) {
          if (Buffer.byteLength(inline, 'utf8') > SCRIPT_MAX_BYTES) throw new CapabilityCommandError('script_too_large', '浏览器脚本不能超过 1 MiB')
          code = inline
        } else {
          const path = resolve(this.ctl.cwd?.() ?? process.cwd(), file!)
          if ((await stat(path)).size > SCRIPT_MAX_BYTES) throw new CapabilityCommandError('script_too_large', '浏览器脚本不能超过 1 MiB')
          code = await readFile(path, 'utf8')
        }
        let data: unknown
        try {
          data = await host.runScript(code, signal)
        } catch (error) {
          if (error instanceof Error && 'code' in error) {
            const logs = (error as { logs?: string[] }).logs ?? []
            throw new CapabilityCommandError(String(error.code), `${error.message}${logs.length ? `\n脚本输出（最后 ${Math.min(logs.length, 20)} 行）：\n${logs.slice(-20).join('\n')}` : ''}`)
          }
          throw error
        }
        const out = (data ?? {}) as { result?: unknown; logs?: string[]; url?: string; title?: string; runtime?: string }
        const full = out.result === null || out.result === undefined ? undefined : typeof out.result === 'string' ? out.result : JSON.stringify(out.result)
        const logs = out.logs ?? []
        return {
          data,
          summary: {
            kind: 'browser', action, ok: true, url: out.url, title: out.title,
            ...(out.runtime ? { runtime: out.runtime } : {}),
            ...(full !== undefined ? { result: full.slice(0, RESULT_PREVIEW_CHARS) } : {}),
            ...(full !== undefined && full.length > RESULT_PREVIEW_CHARS ? { resultTruncated: true, resultChars: full.length } : {}),
            ...(logs.length ? { logs: logs.length, logTail: logs.slice(-LOG_TAIL_LINES).map((line) => line.slice(0, LOG_LINE_CHARS)) } : {})
          }
        }
      }

      case 'text': {
        if (!host.text) throw new CapabilityCommandError('browser_text_unavailable', '当前浏览器不支持读取正文')
        let page: { text: string; url: string; title: string }
        try {
          page = await host.text()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('浏览器尚未打开')) throw new CapabilityCommandError('browser_not_open', '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面')
          throw error
        }
        const total = page.text.length
        const find = this.browserText(params, 'find')
        if (find) {
          const matches = textMatches(page.text, find, 20, 100)
          return { data: { ...page, find, matches }, summary: { kind: 'browser', action, ok: true, url: page.url, title: page.title, totalChars: total, find, count: matches.length, matches } }
        }
        const offset = Math.min(Math.max(Math.floor(this.browserNumber(params, 'offset') ?? 0), 0), total)
        const size = Math.min(Math.max(Math.floor(this.browserNumber(params, 'max-chars') ?? this.browserNumber(params, 'maxChars') ?? TEXT_DEFAULT_CHARS), 200), TEXT_MAX_CHARS)
        const endOffset = Math.min(offset + size, total)
        return {
          data: page,
          summary: { kind: 'browser', action, ok: true, url: page.url, title: page.title, totalChars: total, offset, endOffset, ...(endOffset < total ? { nextOffset: endOffset } : {}), text: page.text.slice(offset, endOffset) }
        }
      }
      case 'navigate':
      case 'open': {
        const url = await this.navigationTarget(action, params)
        const res = await host.navigate(url)
        if (!res.ok) this.browserFailure(action, res)
        const state = host.getState()
        return { data: state, summary: this.browserSummary(action, state) }
      }

      case 'state': {
        const state = host.getState()
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            ...(state.activeTabId ? { activeTabId: state.activeTabId } : {}),
            tabList: (state.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
          })
        }
      }

      case 'observe': {
        const scope = this.browserText(params, 'in')
        const all = flag(params.all) || Boolean(this.browserText(params, 'find'))
        const observation = await this.browserObserve(action, { ...(all ? { all } : {}), ...(scope ? { scope } : {}) })
        return { data: observation, summary: this.observeSummary(action, observation, params) }
      }

      case 'network': {
        let snapshot: BrowserNetworkSnapshot
        try {
          snapshot = await host.network()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (message.includes('浏览器尚未打开')) throw new CapabilityCommandError('browser_not_open', message)
          throw error
        }
        return {
          data: snapshot,
          summary: {
            kind: 'browser', action, ok: true,
            capturedAt: snapshot.capturedAt,
            count: snapshot.entries.length,
            limit: snapshot.limit,
            latest: snapshot.entries.slice(-8)
          }
        }
      }

      case 'wait': {
        const observation = await this.browserWaitCommand(params)
        return { data: observation, summary: this.observeSummary(action, observation, {}) }
      }

      case 'click':
      case 'type':
      case 'press':
      case 'scroll': {
        const res = await this.browserActionCommand(host, action, params)
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        const target = action === 'click' ? observation.elements.find((element) => element.ref === this.browserText(params, 'ref')) : undefined
        return { data: res.receipt ? { ...observation, receipt: res.receipt } : observation, summary: { ...this.actionSummary(action, observation), ...receiptSummary(res.receipt), ...(target?.value !== undefined ? { value: target.value } : {}) } }
      }

      case 'select': {
        const ref = this.browserText(params, 'ref')
        if (!ref) {
          throw new CapabilityCommandError('missing_ref', 'select 需要元素引用：先 yan browser observe 拿 ref，再 yan browser select --ref <ref> --value <值>')
        }
        const raw = params.value
        if (raw === undefined || raw === null || typeof raw === 'object') {
          throw new CapabilityCommandError('missing_value', 'select 需要选中值：yan browser select --ref <ref> --value <值>')
        }
        const res = await host.select(ref, String(raw), this.actionOptions(params)) as BrowserObservationResult & { chosen?: { value: string; label: string } }
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        return { data: res.receipt ? { ...observation, receipt: res.receipt } : observation, summary: { ...this.actionSummary(action, observation), ...receiptSummary(res.receipt), ...(res.chosen ? { value: res.chosen.value, label: res.chosen.label } : {}) } }
      }

      case 'back':
      case 'forward':
      case 'reload': {
        const res = await (action === 'back'
          ? host.back()
          : action === 'forward'
            ? host.forward()
            : host.reload())
        if (!res.ok) this.browserFailure(action, res)
        const state = host.getState()
        return { data: state, summary: this.browserSummary(action, state) }
      }

      case 'new-tab':
      case 'switch-tab':
      case 'close-tab': {
        const id = this.browserText(params, 'id')
        if (action === 'switch-tab' && !id) {
          throw new CapabilityCommandError(
            'missing_tab_id',
            'switch-tab 需要标签 id：yan browser switch-tab --id <标签id>（id 从 yan browser state 里取）'
          )
        }
        const closing = action === 'close-tab' ? id ?? host.getState().activeTabId : undefined
        let state: BrowserState
        try {
          state =
            action === 'new-tab'
              ? await host.newTab(this.browserText(params, 'url') || this.browserText(params, 'file') ? await this.navigationTarget(action, params) : undefined)
              : action === 'switch-tab'
                ? await host.switchTab(id as string)
                : await host.closeTab(id)
        } catch (error) {
          if (error instanceof Error && (error as { code?: unknown }).code === 'tab_not_found') throw new CapabilityCommandError('tab_not_found', error.message)
          throw error
        }
        return { data: state, summary: this.browserSummary(action, state, { ...(closing ? { closed: closing } : {}), activeTabId: state.activeTabId ?? null, refsReset: true, hint: '标签已变，之前的元素 ref 全部失效，先 yan browser observe 再操作' }) }
      }

      case 'screenshot': {
        const shot = await this.browserScreenshot()
        return {
          data: { mimeType: shot.mimeType, path: shot.path, bytes: shot.bytes },
          summary: {
            kind: 'browser',
            action,
            ok: true,
            mimeType: shot.mimeType,
            savedTo: shot.path,
            bytes: shot.bytes
          }
        }
      }

      case 'download': {
        const opts = this.ctl.capabilityOpts()
        const owner = `${opts?.sessionId ?? 'host'}:${opts?.runnerGeneration ?? 0}:${this.owner}`
        const wait = params.wait === true || params.wait === 'true' || params.wait === ''
        if (wait) {
          const timeoutMs = Math.min(Math.max(this.browserNumber(params, 'timeout') ?? 30_000, 1_000), 120_000)
          const deadline = Date.now() + timeoutMs
          while ((host.pendingDownloads?.() ?? []).length && Date.now() < deadline) {
            signal?.throwIfAborted()
            await new Promise((resolve) => setTimeout(resolve, 250))
          }
        }
        const download = host.getOwnedDownload?.(owner) ?? null
        const pending = host.pendingDownloads?.() ?? []
        return {
          data: { download, pending },
          summary: {
            kind: 'browser',
            action,
            ok: true,
            has: Boolean(download),
            ...(download ? { filename: download.filename, path: download.path } : {}),
            ...(pending.length ? { pending } : {})
          }
        }
      }

      case 'request-user-control': {
        const reason = this.browserText(params, 'reason')
        const state = await host.requestUserControl({ reason, sessionId: this.browserSessionId() })
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            userControl: state.userControl === true,
            ...(reason ? { reason } : {}),
            next: '浏览器已交给用户，界面上有卡片说明原因。请在回复里告诉用户要做什么，然后结束本轮；用户做完会发消息（或点卡片按钮），那时控制已交还，再继续。'
          })
        }
      }

      case 'connect-chrome':
      case 'disconnect-chrome': {
        if (action === 'connect-chrome') {
          const res = await host.openExternalChrome(this.browserText(params, 'url'))
          if (!res.ok) this.browserFailure(action, res)
        } else {
          await host.closeExternalChrome()
        }
        const state = host.getState()
        return {
          data: state,
          summary: this.browserSummary(action, state, { mode: state.mode ?? 'embedded' })
        }
      }

      default:
        throw new CapabilityCommandError(
          'browser_action_not_implemented',
          `浏览器动作已登记但尚未实现：${action}`
        )
    }
  }

  browserHost(): BrowserCommandHost {
    const user = userBrowser.hostFor(this.browserSessionId())
    if (user) return user
    const host = this.ctl.browserHostOrNull() ?? null
    if (!host) {
      throw new CapabilityCommandError(
        'browser_unavailable',
        '内置浏览器服务不可用（宿主还在启动或未初始化）；请稍后在会话里重试'
      )
    }
    return host.forSession?.(this.browserSessionId()) ?? host
  }

  private browserSessionId(): string {
    return this.ctl.conversationId?.() || this.ctl.capabilityOpts()?.sessionId || 'workspace'
  }

  private async navigationTarget(action: string, params: Record<string, unknown>): Promise<string> {
    const file = this.browserText(params, 'file')
    const url = this.browserText(params, 'url')
    const local = file ?? (url && /^file:/i.test(url) ? fileURLToPath(url) : undefined)
    if (local) {
      const path = process.platform === 'win32' ? local.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : local
      try {
        return await serveLocalFile(path, this.ctl.cwd?.())
      } catch (error) {
        throw new CapabilityCommandError('local_file_unavailable', error instanceof Error ? error.message : String(error))
      }
    }
    if (!url) {
      throw new CapabilityCommandError(
        'missing_url',
        `${action} 需要 http(s) 地址或本地文件：yan browser ${action} --url <地址> 或 --file <路径>`
      )
    }
    return url
  }

  browserText(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key]
    if (typeof value === 'string') return value.trim() ? value.trim() : undefined
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
  }

  browserNumber(params: Record<string, unknown>, key: string): number | undefined {
    const raw = params[key]
    if (raw === undefined) return undefined
    if (typeof raw !== 'number' && typeof raw !== 'string') throw new CapabilityCommandError('invalid_number', `${key} 需要数字，收到的是 ${JSON.stringify(raw)}`)
    if (typeof raw === 'string' && !raw.trim()) throw new CapabilityCommandError('invalid_number', `${key} 需要数字，收到的是空白`)
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      throw new CapabilityCommandError(
        'invalid_number',
        `${key} 需要数字，收到的是 ${JSON.stringify(raw)}`
      )
    }
    return value
  }

  async browserWaitCommand(params: Record<string, unknown>): Promise<BrowserObservation> {
    const parsed = parseWaitCondition(params)
    if (!parsed.ok) throw new CapabilityCommandError(parsed.code, parsed.message)
    const { condition, timeoutMs } = parsed
    const target = condition.ref ? this.lastElements.get(condition.ref) : undefined
    if (condition.ref && !target) throw new CapabilityCommandError('STALE_ELEMENT', `元素引用已失效：${condition.ref}。请重新调用 yan browser observe 后用新的 ref。`)
    const matches = target ? sameWaitElement(target) : undefined
    const deadline = Date.now() + timeoutMs
    let last: BrowserObservation | null = null

    while (Date.now() <= deadline) {
      last = await this.browserObserve('wait')
      if (waitSatisfied(condition, last, matches)) return last
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
    }

    const seen = last
      ? `最后看到：url=${last.url} 元素 ${last.elements.length} 个，文本 ${last.text.slice(0, 120)}`
      : '一次也没读到页面'
    throw new CapabilityCommandError(
      'wait_timeout',
      `等了 ${timeoutMs}ms 还不满足（${describeWait(condition)}）。${seen}`
    )
  }

  async browserActionCommand(
    host: BrowserCommandHost,
    action: 'click' | 'type' | 'press' | 'scroll',
    params: Record<string, unknown>
  ): Promise<BrowserObservationResult> {
    if (action === 'scroll') {
      const deltaY = this.browserNumber(params, 'deltaY') ?? this.browserNumber(params, 'delta-y')
      if (deltaY === undefined) {
        throw new CapabilityCommandError(
          'missing_delta',
          'scroll 需要滚动像素：yan browser scroll --delta-y <像素> [--delta-x <像素>]'
        )
      }
      const deltaX = this.browserNumber(params, 'deltaX') ?? this.browserNumber(params, 'delta-x') ?? 0
      return host.scroll(deltaX, deltaY)
    }

    if (action === 'press') {
      const key = this.browserText(params, 'key')
      if (!key) {
        throw new CapabilityCommandError('missing_key', 'press 需要按键名：yan browser press --key Enter')
      }
      return host.press(key, this.actionOptions(params))
    }

    const ref = this.browserText(params, 'ref')
    if (!ref) {
      throw new CapabilityCommandError(
        'missing_ref',
        `${action} 需要元素 ref：yan browser ${action} --ref <ref>（ref 来自 yan browser observe）`
      )
    }
    if (action === 'click') return host.click(ref, this.actionOptions(params))

    const text = typeof params.text === 'string' ? params.text : undefined
    if (text === undefined) {
      throw new CapabilityCommandError(
        'missing_text',
        'type 需要文本：yan browser type --ref <ref> --text <文本>'
      )
    }
    return host.type(ref, text, this.actionOptions(params))
  }

  private actionOptions(params: Record<string, unknown>): BrowserActionOptions {
    const dialog = this.browserText(params, 'dialog')
    if (dialog !== undefined && dialog !== 'accept' && dialog !== 'dismiss') {
      throw new CapabilityCommandError('invalid_dialog', '--dialog 只接受 accept 或 dismiss')
    }
    return dialog ? { dialog } : {}
  }

  async browserObserve(action: string, options?: { all?: boolean; scope?: string }): Promise<BrowserObservation> {
    try {
      return await (options ? this.browserHost().observe(options) : this.browserHost().observe())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof CapabilityCommandError) throw err
      if (err instanceof UserBrowserError || err instanceof BridgeCallError) throw userBrowserFailure(err)
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'STALE_ELEMENT') throw new CapabilityCommandError('STALE_ELEMENT', message)
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_observe_failed', `${action} 失败：${this.cliHint(message)}`)
    }
  }

  async browserScreenshot(): Promise<{ mimeType: string; path: string; bytes: number }> {
    let shot: { mimeType: string; data: Buffer }
    try {
      shot = await this.browserHost().screenshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof CapabilityCommandError) throw err
      if (err instanceof UserBrowserError || err instanceof BridgeCallError) throw userBrowserFailure(err)
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_screenshot_failed', `截图失败：${message}。不必重试截图：用 yan browser observe 看元素、yan browser text 读正文。`)
    }
    const dir = this.ctl.capabilityOpts()?.opsDir ?? join(YAN_DIR, 'ops')
    const path = join(dir, `screenshot-${randomUUID()}.png`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, shot.data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new CapabilityCommandError('browser_screenshot_failed', `截图写盘失败：${message}`)
    }
    return { mimeType: shot.mimeType, path, bytes: shot.data.byteLength }
  }

  cliHint(message: string): string {
    return message.replace(/\bbrowser_([a-z_]+)\b/g, (_all, action: string) => {
      return `yan browser ${action.replace(/_/g, '-')}`
    })
  }

  browserFailure(action: string, res: { error?: string; code?: string }): never {
    const message = this.cliHint(res.error ?? '浏览器操作失败')
    const code =
      res.code ?? (message.includes('浏览器尚未打开') ? 'browser_not_open' : `browser_${action.replace(/-/g, '_')}_failed`)
    throw new CapabilityCommandError(code, message)
  }

  browserSummary(
    action: string,
    state: BrowserState,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      kind: 'browser',
      action,
      ok: true,
      open: state.open,
      url: state.url,
      title: state.title,
      mode: state.mode ?? 'embedded',
      tabs: (state.tabs ?? []).length,
      ...(state.userControl ? { userControl: true } : {}),
      ...extra
    }
  }

  observeSummary(action: string, observation: BrowserObservation, params: Record<string, unknown>): Record<string, unknown> {
    const find = this.browserText(params, 'find')
    const role = this.browserText(params, 'role')
    const scope = this.browserText(params, 'in')
    const all = flag(params.all)
    const widened = all || Boolean(find) || Boolean(scope)
    const matched = filterElements(observation.elements, { find, role, all, ...(scope ? { scopeRefs: observation.scopeRefs ?? [] } : {}) })
    const limit = widened ? ALL_ITEM_LIMIT : ITEM_LIMIT
    const offscreen = widened ? 0 : observation.elements.filter((element) => element.offscreen).length
    const found = find ? textMatches(observation.text, find, 10, 60) : []
    return {
      kind: 'browser',
      action,
      ok: true,
      url: observation.url,
      title: observation.title,
      elements: observation.elements.length,
      textChars: observation.text.length,
      ...(offscreen ? { offscreen, hint: `视口外还有 ${offscreen} 个元素：--all 列出，--find <文字> 查找` } : {}),
      items: matched.slice(0, limit).map(elementLine),
      ...(matched.length > limit ? { more: matched.length - limit } : {}),
      ...(find ? { textMatches: found.map((match) => match.snippet) } : {})
    }
  }

  actionSummary(action: string, observation: BrowserObservation): Record<string, unknown> {
    const changes = diffObservations(this.lastObservation, observation)
    return {
      kind: 'browser',
      action,
      ok: true,
      url: observation.url,
      title: observation.title,
      elements: observation.elements.length,
      changes: changes.length ? changes : ['页面元素、地址与文字都没有变化']
    }
  }
}
