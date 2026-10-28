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
import { sharedResources, INTERACTIVE_RESOURCE } from './interactive-resources'
import { receiptSummary, type BrowserActionOptions } from './browser/receipt'

const ACTION_TIMEOUT_MS = 60_000
const CONFIRMING_ACTIONS = new Set(['state', 'observe', 'wait', 'screenshot'])
let browserUncertain = false

class ActionTimeoutError extends Error {}

function withActionTimeout<T>(action: string, work: Promise<T>): Promise<T> {
  if (action === 'wait' || action === 'run') return work
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
}

export class BrowserCommands {
  private readonly owner = `browser-${randomUUID()}`
  private refs = new Set<string>()
  private lastElements = new Map<string, WaitElement>()
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
      const resourceId = INTERACTIVE_RESOURCE
      if (browserUncertain && CONFIRMING_ACTIONS.has(action)) {
        browserUncertain = false
        sharedResources.resolveUncertain(resourceId)
      }
      return await sharedResources.run(resourceId, owner, async () => {
        if (this.identity !== identity) {
          this.refs.clear()
          this.targetId = undefined
          this.identity = identity
        }
        const current = this.ctl.capabilityOpts()
        if (this.ctl.isActive?.() === false || `${current?.sessionId ?? 'host'}:${current?.runnerGeneration ?? 0}` !== identity) throw new CapabilityCommandError('run_expired', '运行已改变，旧排队操作未执行')
        const state = this.browserHost().getState()
        const userMutations = new Set(['run', 'navigate', 'open', 'back', 'forward', 'reload', 'new-tab', 'switch-tab', 'close-tab', 'connect-chrome', 'disconnect-chrome', 'click', 'type', 'select', 'press', 'scroll'])
        if (state.userControl && userMutations.has(action)) {
          throw new CapabilityCommandError('USER_CONTROL_ACTIVE', '浏览器当前由用户接管，请等待用户恢复 Agent 控制。')
        }
        if (['click', 'type', 'select'].includes(action)) {
          const ref = this.browserText(params, 'ref')
          if (ref && !this.refs.has(ref)) throw new CapabilityCommandError('STALE_ELEMENT', `元素引用 ${ref} 不在最新一次观察里：元素已经消失，或页面已导航 / 换了文档。用上一条回执 resultFile 里 elements 的 ref（同一页面上没变的元素 ref 保持不变），或重新 observe。`)
        }
        if (['click', 'type', 'select', 'press', 'scroll'].includes(action) && this.targetId !== state.activeTabId) {
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
            browserUncertain = true
            sharedResources.markUncertain(resourceId)
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
            this.targetId = undefined
            throw new CapabilityCommandError('STALE_TARGET', '操作期间显示目标发生变化，动作可能已完成，请核对结果并重新 observe；不要重放动作。')
          }
          this.refs = new Set(observation.elements.map((e) => e.ref))
          this.lastElements = new Map(observation.elements.map((e) => [e.ref, e]))
          this.targetId = this.browserHost().getState().activeTabId
        } else if (userMutations.has(action)) {
          this.refs.clear()
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
    const host = this.browserHost()
    switch (action) {
      case 'api': {
        const guide = await host.guide?.()
        if (!guide) throw new CapabilityCommandError('browser_script_unavailable', '当前浏览器不支持脚本')
        return { data: { guide }, summary: { kind: 'browser', action, ok: true, guide } }
      }
      case 'run': {
        const file = this.browserText(params, 'file')
        if (!file) throw new CapabilityCommandError('missing_file', 'run 需要 UTF-8 JavaScript 文件：yan browser run --file <路径>')
        if (!host.runScript) throw new CapabilityCommandError('browser_script_unavailable', '当前浏览器不支持脚本')
        const path = resolve(this.ctl.cwd?.() ?? process.cwd(), file)
        if ((await stat(path)).size > 1024 * 1024) throw new CapabilityCommandError('script_too_large', '浏览器脚本不能超过 1 MiB')
        let data: unknown
        try {
          data = await host.runScript(await readFile(path, 'utf8'), signal)
        } catch (error) {
          if (error instanceof Error && 'code' in error) {
            const logs = (error as { logs?: string[] }).logs ?? []
            throw new CapabilityCommandError(String(error.code), `${error.message}${logs.length ? `\n脚本输出（最后 ${Math.min(logs.length, 20)} 行）：\n${logs.slice(-20).join('\n')}` : ''}`)
          }
          throw error
        }
        const out = (data ?? {}) as { result?: unknown; logs?: string[]; url?: string; title?: string }
        const preview = out.result === null || out.result === undefined ? undefined : JSON.stringify(out.result).slice(0, 300)
        return {
          data,
          summary: {
            kind: 'browser', action, ok: true, url: out.url, title: out.title,
            ...(preview ? { result: preview } : {}),
            logs: out.logs?.length ?? 0,
            ...(out.logs?.length ? { logTail: out.logs.slice(-5) } : {})
          }
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
            tabs: (state.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
          })
        }
      }

      case 'observe': {
        const observation = await this.browserObserve(action)
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
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
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      case 'click':
      case 'type':
      case 'press':
      case 'scroll': {
        const res = await this.browserActionCommand(host, action, params)
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        const target = action === 'click' ? observation.elements.find((element) => element.ref === this.browserText(params, 'ref')) : undefined
        return { data: res.receipt ? { ...observation, receipt: res.receipt } : observation, summary: { ...this.browserObservationSummary(action, observation), ...receiptSummary(res.receipt), ...(target?.value !== undefined ? { value: target.value } : {}) } }
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
        return { data: res.receipt ? { ...observation, receipt: res.receipt } : observation, summary: { ...this.browserObservationSummary(action, observation), ...receiptSummary(res.receipt), ...(res.chosen ? { value: res.chosen.value, label: res.chosen.label } : {}) } }
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
        const state =
          action === 'new-tab'
            ? await host.newTab(this.browserText(params, 'url') || this.browserText(params, 'file') ? await this.navigationTarget(action, params) : undefined)
            : action === 'switch-tab'
              ? await host.switchTab(id as string)
              : await host.closeTab(id)
        return { data: state, summary: this.browserSummary(action, state, closing ? { closed: closing } : {}) }
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

  async browserObserve(action: string): Promise<BrowserObservation> {
    try {
      return await this.browserHost().observe()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof CapabilityCommandError) throw err
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
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_screenshot_failed', `截图失败：${message}`)
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

  browserObservationSummary(
    action: string,
    observation: BrowserObservation
  ): Record<string, unknown> {
    return {
      kind: 'browser',
      action,
      ok: true,
      url: observation.url,
      title: observation.title,
      generationId: observation.generationId,
      elements: observation.elements.length,
      accessibilityNodes: observation.accessibilityNodeCount,
      textChars: observation.text.length
    }
  }
}
