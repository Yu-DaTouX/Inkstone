/**
 * `yan browser …` 的实现：观察、截图、等待与各类页面动作。
 *
 * 浏览器控制器归宿主独占（BrowserController），这里直接调宿主服务，不经网络；
 * 参数兼容 CLI 字符串与请求文件里的 JSON 原生类型。控制器状态经 `BrowserCommandsHost` 读取。
 */
import type { BrowserCommandHost, BrowserObservationResult, CapabilityRunOptions } from './agent'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilityCommandError } from './capability-server'
import { WAIT_POLL_MS, describeWait, parseWaitCondition, waitSatisfied } from '../shared/browser-wait'
import { YAN_DIR } from './paths'
import type { BrowserObservation, BrowserNetworkSnapshot, BrowserState } from '../shared/ipc'
import { sharedResources, INTERACTIVE_RESOURCE } from './agent-hub/resources'

export interface BrowserCommandsHost {
  /** 宿主浏览器服务；还在启动或未初始化时为 null */
  browserHostOrNull(): BrowserCommandHost | null
  capabilityOpts(): CapabilityRunOptions | undefined
  isActive?(): boolean
}

export class BrowserCommands {
  private readonly owner = `browser-${randomUUID()}`
  private refs = new Set<string>()
  private targetId: string | undefined
  private identity?: string
  constructor(private readonly ctl: BrowserCommandsHost) {}


  /**
   * `yan browser <动作>` 的实现点。
   *
   * ── 为什么直接调宿主服务，而不是复用旧的 loopback bridge ──
   *   浏览器控制器归宿主独占（01-S5d 已删掉只服务于旧 `browser.js` 扩展的
   *   HTTP bridge）。再绕一层网络调用只会多一个失败点与一次序列化，
   *   安全上不多一分。
   *
   * ── 失败分两类（见 capability-server.ts 的注释）──
   *   · 「浏览器没开 / 地址不是 http(s) / 正在由用户接管」= **业务失败**，
   *     模型能改参数重试 → `CapabilityCommandError`（带 code，可分支）；
   *   · 协议版本 / token / 身份不匹配 = **端点级错误**，在进到这里之前就被
   *     能力服务拦掉了，不会落到本方法里。
   *
   * ── 结果形状 ──
   *   大对象（观察 / 状态 / 截图路径）走 `data` → 由能力服务落文件；
   *   `summary` 只放能一眼读完的几个字段（它才是进模型上下文的那段）。
   */
  async runBrowserCommand(
    action: string,
    params: Record<string, unknown>
  ): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const opts = this.ctl.capabilityOpts()
    const identity = `${opts?.sessionId ?? 'host'}:${opts?.runnerGeneration ?? 0}`
    if (this.identity !== identity) { this.refs.clear(); this.targetId = undefined; this.identity = identity }
    const owner = `${identity}:${this.owner}`
    try {
      return await sharedResources.run(INTERACTIVE_RESOURCE, owner, async () => {
        const current = this.ctl.capabilityOpts()
        if (this.ctl.isActive?.() === false || `${current?.sessionId ?? 'host'}:${current?.runnerGeneration ?? 0}` !== identity) throw new CapabilityCommandError('run_expired', '运行已改变，旧排队操作未执行')
        const state = this.browserHost().getState()
        const userMutations = new Set(['navigate', 'open', 'back', 'forward', 'reload', 'new-tab', 'switch-tab', 'close-tab', 'connect-chrome', 'disconnect-chrome', 'click', 'type', 'select', 'press', 'scroll'])
        if (state.userControl && userMutations.has(action)) {
          throw new CapabilityCommandError('USER_CONTROL_ACTIVE', '浏览器当前由用户接管，请等待用户恢复 Agent 控制。')
        }
        if (['click', 'type', 'select'].includes(action)) {
          const ref = this.browserText(params, 'ref')
          if (ref && !this.refs.has(ref)) throw new CapabilityCommandError('STALE_ELEMENT', '元素引用不属于本次运行的最新观察，请重新 observe。')
        }
        if (['click', 'type', 'select', 'press', 'scroll'].includes(action) && this.targetId !== state.activeTabId) {
          throw new CapabilityCommandError('STALE_TARGET', '浏览器目标已改变，请重新 observe 后继续。')
        }
        let result: { data?: unknown; summary: Record<string, unknown> }
        const host = this.browserHost()
        if (userMutations.has(action)) host.setAutomationOwner?.(owner)
        try { result = await this.execute(action, params) }
        catch (error) {
          if (userMutations.has(action) && !(error instanceof CapabilityCommandError)) sharedResources.markUncertain(INTERACTIVE_RESOURCE)
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
          this.targetId = this.browserHost().getState().activeTabId
        } else if (userMutations.has(action)) {
          this.refs.clear()
          this.targetId = undefined
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

  private async execute(action: string, params: Record<string, unknown>): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
    const host = this.browserHost()
    switch (action) {
      /* 打开 / 导航：`open` 是历史别名（旧 browser_open 与 browser_navigate 等价） */
      case 'navigate':
      case 'open': {
        const url = this.browserText(params, 'url')
        if (!url) {
          throw new CapabilityCommandError(
            'missing_url',
            `${action} 需要一个 http(s) 地址（about:blank 也可以）：yan browser ${action} --url <地址>`
          )
        }
        const res = await host.navigate(url)
        if (!res.ok) this.browserFailure(action, res)
        const state = host.getState()
        return { data: state, summary: this.browserSummary(action, state) }
      }

      /* 当前状态：标签 id 的唯一来源（旧工具链里 switch_tab 要的 id 无处可得） */
      case 'state': {
        const state = host.getState()
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            tabs: (state.tabs ?? []).map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
          })
        }
      }

      /* 观察当前页面：URL / 标题 / 可交互元素 ref / 可见文本 */
      case 'observe': {
        const observation = await this.browserObserve(action)
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      /* 只读网络账本（实施-27 S5）：有界且去掉 query / fragment / 凭证。 */
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

      /*
       * 等待条件成立（实施-27 S5）。
       *
       * 为什么用轮询 `observe()` 而不是 CDP 的等待原语：observe 已经是宿主
       * 与页面之间**唯一**的稳定读口（它自己处理了 frame、可交互性过滤与 ref 生成），
       * 另开一条等待通道会出现「等到的元素 observe 里却没有 ref」这种错配。
       * 代价是轮询开销 —— 所以间隔取 250ms，且给明确的上限。
       */
      case 'wait': {
        const observation = await this.browserWaitCommand(params)
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      /* 会带回新观察的四个动作 */
      case 'click':
      case 'type':
      case 'press':
      case 'scroll': {
        const res = await this.browserActionCommand(host, action, params)
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
      }

      /*
       * 下拉框选值。`--value` 允许空串（“选空白项”是合法操作），
       * 所以这里不看 browserText 的 trim 结果，而看**参数在不在**。
       */
      case 'select': {
        const ref = this.browserText(params, 'ref')
        if (!ref) {
          throw new CapabilityCommandError('missing_ref', 'select 需要元素引用：先 yan browser observe 拿 ref，再 yan browser select --ref <ref> --value <值>')
        }
        const raw = params.value
        if (raw === undefined || raw === null || typeof raw === 'object') {
          throw new CapabilityCommandError('missing_value', 'select 需要选中值：yan browser select --ref <ref> --value <值>')
        }
        const res = await host.select(ref, String(raw))
        if (!res.ok) this.browserFailure(action, res)
        const observation = res.observation ?? (await this.browserObserve(action))
        return { data: observation, summary: this.browserObservationSummary(action, observation) }
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
        const state =
          action === 'new-tab'
            ? await host.newTab(this.browserText(params, 'url'))
            : action === 'switch-tab'
              ? await host.switchTab(id as string)
              : await host.closeTab(id)
        return { data: state, summary: this.browserSummary(action, state) }
      }

      /*
       * 截图：PNG **落盘**，摘要里只给路径与字节数。
       *
       * 为什么不把 base64 塞进结果文件：一张 1080p 截图的 base64 是几 MB，
       * 写进 JSON 后模型还得把整个 JSON 读一遍才能拿到它；落成 .png 后
       * pi 的原生 read 能直接看图，路径也不占上下文。
       */
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

      /* 最近一次完成的下载（旧 browser_download 的等价物，数据来自宿主 state） */
      case 'download': {
        const opts = this.ctl.capabilityOpts()
        const owner = `${opts?.sessionId ?? 'host'}:${opts?.runnerGeneration ?? 0}:${this.owner}`
        const download = host.getOwnedDownload?.(owner) ?? null
        return {
          data: { download },
          summary: {
            kind: 'browser',
            action,
            ok: true,
            has: Boolean(download),
            ...(download ? { filename: download.filename, path: download.path } : {})
          }
        }
      }

      /* 把页面交给用户：后续 click / type / press / scroll 一律被拒 */
      case 'request-user-control': {
        const state = host.requestUserControl()
        const reason = this.browserText(params, 'reason')
        return {
          data: state,
          summary: this.browserSummary(action, state, {
            userControl: state.userControl === true,
            ...(reason ? { reason } : {})
          })
        }
      }

      /* 接入 / 断开本机已安装的 Chrome（需要登录态的站点） */
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

      /*
       * 兜底：命令名已过 KNOWN_COMMANDS，能到这里只可能是「登记了但没实现」。
       * 不静默成功（01-S2 的约定）。
       *
       * 注：bridge 的 `/evaluate`（任意页面 JavaScript）**有意不登记**，
       * 它返回 403；这里也不给出口。
       */
      default:
        throw new CapabilityCommandError(
          'browser_action_not_implemented',
          `浏览器动作已登记但尚未实现：${action}`
        )
    }
  }

  /** 取浏览器宿主服务；没注入（或宿主还没起来）时给可读的失败。 */
  browserHost(): BrowserCommandHost {
    const host = this.ctl.browserHostOrNull() ?? null
    if (!host) {
      throw new CapabilityCommandError(
        'browser_unavailable',
        '内置浏览器服务不可用（宿主还在启动或未初始化）；请稍后在会话里重试'
      )
    }
    return host
  }

  /**
   * 参数取值。
   *
   * `yan` 走 flag 时所有值都是**字符串**（`--delta-y 300`），走
   * `--request-file` 时才是 JSON 原生类型 —— 两种都接受，不猜默认值。
   * 空串按「没给」处理，避免 `--ref ''` 变成一次无意义调用。
   */
  browserText(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key]
    if (typeof value === 'string') return value.trim() ? value.trim() : undefined
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return undefined
  }

  /** 数值参数（`--delta-y` / `--delta-x`）：认不出数字就报可读错误，不传 NaN 给 CDP。 */
  browserNumber(params: Record<string, unknown>, key: string): number | undefined {
    const raw = params[key]
    if (raw === undefined || raw === '' || raw === true) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      throw new CapabilityCommandError(
        'invalid_number',
        `${key} 需要数字，收到的是 ${JSON.stringify(raw)}`
      )
    }
    return value
  }

  /** click / type / press / scroll 的参数读取与调用（四个动作的参数面各不相同）。 */
  /**
   * `wait`：等到条件成立（或超时）。
   *
   * 支持的条件（至少给一个，可以叠加 —— 叠加是**且**）：
   *   · `--ref <ref>`  这个元素出现（配合 `--gone` 变成“消失”）；
   *   · `--text <文本>`  可见文本里出现这段字；
   *   · `--url <子串>`  当前地址里出现这段字。
   *
   * 为什么要明确报 `wait_timeout`：模型最常犯的错是“等一个永远不会出现的东西”，
   * 而含糊的失败会让它反复重试。超时信息里带上**最后看到的样子**
   * （url / 元素数 / 文本片段），模型就能自己判断是选择器写错了还是页面变了。
   */
  async browserWaitCommand(params: Record<string, unknown>): Promise<BrowserObservation> {
    const parsed = parseWaitCondition(params)
    if (!parsed.ok) throw new CapabilityCommandError(parsed.code, parsed.message)
    const { condition, timeoutMs } = parsed
    const deadline = Date.now() + timeoutMs
    let last: BrowserObservation | null = null

    while (Date.now() <= deadline) {
      last = await this.browserObserve('wait')
      if (waitSatisfied(condition, last)) return last
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
      return host.press(key)
    }

    const ref = this.browserText(params, 'ref')
    if (!ref) {
      throw new CapabilityCommandError(
        'missing_ref',
        `${action} 需要元素 ref：yan browser ${action} --ref <ref>（ref 来自 yan browser observe）`
      )
    }
    if (action === 'click') return host.click(ref)

    const text = typeof params.text === 'string' ? params.text : undefined
    if (text === undefined) {
      throw new CapabilityCommandError(
        'missing_text',
        'type 需要文本：yan browser type --ref <ref> --text <文本>'
      )
    }
    return host.type(ref, text)
  }

  /** observe：把「还没打开」单独归一个 code，其余如实带原话。 */
  async browserObserve(action: string): Promise<BrowserObservation> {
    try {
      return await this.browserHost().observe()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('浏览器尚未打开')) {
        throw new CapabilityCommandError(
          'browser_not_open',
          '内置浏览器还没打开：先用 `yan browser navigate --url <地址>` 打开一个页面'
        )
      }
      throw new CapabilityCommandError('browser_observe_failed', `${action} 失败：${this.cliHint(message)}`)
    }
  }

  /** 截图落盘（宿主能力服务的结果目录），只回路径与字节数。 */
  async browserScreenshot(): Promise<{ mimeType: string; path: string; bytes: number }> {
    let shot: { mimeType: string; data: Buffer }
    try {
      shot = await this.browserHost().screenshot()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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

  /**
   * 兜底：把文案里残留的旧工具名换成现在真的能用的 CLI 写法。
   *
   * 浏览器服务内部文案已在 01-S5d 收尾时统一成 `yan browser …` 写法
   * （见 `browser.ts` / `browser/ElementRegistry.ts`）；这里保留一道改写，
   * 防止以后新增的错误提示又写出 `browser_observe` 这种不存在的工具名。
   */
  cliHint(message: string): string {
    return message.replace(/\bbrowser_([a-z_]+)\b/g, (_all, action: string) => {
      return `yan browser ${action.replace(/_/g, '-')}`
    })
  }

  /**
   * 动作失败 → 业务错误。
   *
   * 「浏览器尚未打开」单独归 `browser_not_open`：它是最常见的一种，模型
   * 看到这个 code 就知道该先 navigate，而不用去读中文。其余错误沿用宿主给的
   * `code`（如权限策略的 `USER_CONTROL_ACTIVE`），没有就用 `browser_<动作>_failed`。
   */
  browserFailure(action: string, res: { error?: string; code?: string }): never {
    const message = this.cliHint(res.error ?? '浏览器操作失败')
    const code =
      res.code ?? (message.includes('浏览器尚未打开') ? 'browser_not_open' : `browser_${action.replace(/-/g, '_')}_failed`)
    throw new CapabilityCommandError(code, message)
  }

  /** 动作后的状态摘要（进上下文的那一小段）。 */
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

  /** 观察摘要：元素/文本的**全文**在结果文件里，这里只给规模与定位。 */
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
