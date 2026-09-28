/**
 * 界面请求：pi 扩展发来的对话框 / 通知，以及宿主自己发起的提问（`yan question ask`）。
 *
 * 保存「见过的请求」「还没答复的请求」及其内容；宿主提问从用户看到那一刻起计时，
 * 可加时，到点如实报超时（不猜答案）。答复可来自电脑面板或手机（敏感确认只能在电脑上答），
 * 答复后推 `ui-resolved` 让另一端移除。AgentController 只做转发。
 */
import type { ExtensionUiRequest, MainPush } from '../shared/ipc'
import { randomUUID } from 'node:crypto'
import { CapabilityCommandError } from './capability-server'
import { extendDeadline, UI_TIMEOUT_HARD } from '../shared/ui-timeout'

export type HostUiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean }

type PendingHostUi = {
  resolve: (response: HostUiResponse) => void
  reject: (error: Error) => void
  /**
   * 软计时器 —— 用户**看到这一条**之后才开始（见 `startHostUiTimer`）。
   *
   * 为什么不是发出请求就计时：多条问题同时挂着时，面板一次只能显示一条，
   * 用户在读第一条的时候，后面几条已经在扣自己的时间 —— 实测出现
   * 「翻到第三条时它已经超时」。用户 2026-09-26 要求从看到开始算。
   */
  timer: ReturnType<typeof setTimeout> | null
  /**
   * 兜底上限：用户一直不翻到这一条（甚至删掉面板）时不能让模型无限等待。
   * 开始计时后会被重设到 `deadline + UI_TIMEOUT_MAX`（给加时留余量）。
   */
  hardTimer: ReturnType<typeof setTimeout>
  /** 当前这一轮的等待时长（延长后会被改写） */
  timeout: number
  /** 截止时刻（绝对毫秒）；`0` = 还没开始计时（用户还没看到） */
  deadline: number
  /** 是否已开始计时；`startHostUiTimer` 靠它保持幂等 */
  started: boolean
}

export interface UiRequestsHost {
  push(msg: MainPush): void
  /** 把答复交还给 pi（扩展自己的请求） */
  respondToPi(res: Record<string, unknown>): void
}

export class UiRequests {
  constructor(private readonly host: UiRequestsHost) {}

  /** 见过的请求 id（去重；答复后仍保留） */
  readonly seen = new Set<string>()
  /**
   * 正在等用户回答的扩展请求（N12）。
   *
   * 与上面的 seen 不同：seen 是「这个请求见过了」的去重集合，
   * 应答后仍然留在里面；这个集合只装**还没答复**的，
   * 用来给「后台会话正在等输入」这个状态提供依据。
   */
  readonly pending = new Set<string>()
  /**
   * 待答请求的内容（按 id）：远程端（手机）要能列出「正在等什么问题」。
   * 只在读取时按 pending 过滤 —— 答复路径很多，统一以 pending 为准，不在每处单独清理。
   */
  readonly payloads = new Map<string, ExtensionUiRequest>()
  /** `yan question ask` 走同一套 UI 请求通道，但不经过 pi 的 extension_ui_request。 */
  private readonly pendingHostUi = new Map<string, PendingHostUi>()

  /** 通过现有 `ui-request` / `yan:respondUi` 桥等待一次宿主问题。 */
  requestHostUi(request: {
    method: 'select' | 'input'
    title: string
    message: string
    options?: string[]
    timeout: number
  }): Promise<HostUiResponse> {
    const id = `yan-question-${randomUUID()}`
    return new Promise<HostUiResponse>((resolve, reject) => {
      const pending: PendingHostUi = {
        resolve,
        reject,
        timeout: request.timeout,
        /* 还没开始计时 —— 等渲染端确认「这一条已经显示给用户了」 */
        deadline: 0,
        started: false,
        timer: null,
        hardTimer: setTimeout(() => this.expireHostUi(id), UI_TIMEOUT_HARD)
      }
      this.pendingHostUi.set(id, pending)
      this.seen.add(id)
      this.pending.add(id)
      const payload = {
        id,
        method: request.method,
        title: request.title,
        message: request.message,
        timeout: request.timeout,
        /*
         * `deadline: 0` = 宿主管理、但**尚未开始**倒计时。
         * 渲染端看到 0 就不显示倒计时（等 `ui-deadline` 推送）。
         * 不带这个字段的（pi 扩展自己的请求）由渲染端自己算。
         */
        deadline: 0,
        ...(request.options ? { options: request.options } : {})
      } as unknown as ExtensionUiRequest
      this.payloads.set(id, payload)
      this.host.push({ ch: 'ui-request', payload })
    })
  }

  /**
   * 用户看到这一条了 → 开始计时（幂等）。
   *
   * 渲染端在该请求成为面板当前页时调一次。多条问题同时挂着时，每条都从
   * 「它被翻到」那一刻起算完整的等待时间 —— 不再出现「还没看到就快没了」。
   */
  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return { ok: false, error: 'question_not_pending' }
    if (pending.started) return { ok: true, timeout: pending.timeout, deadline: pending.deadline }
    const deadline = Date.now() + pending.timeout
    pending.started = true
    pending.deadline = deadline
    pending.timer = setTimeout(() => this.expireHostUi(id), pending.timeout)
    /* 看到之后至少还有 10 分钟（含用户点加时的余量）—— 兜底不能在这里先到 */
    clearTimeout(pending.hardTimer)
    pending.hardTimer = setTimeout(() => this.expireHostUi(id), pending.timeout + UI_TIMEOUT_HARD)
    this.host.push({ ch: 'ui-deadline', payload: { id, timeout: pending.timeout, deadline } })
    return { ok: true, timeout: pending.timeout, deadline }
  }

  /** 等待到点：摘登记并如实报超时（**不猜答案**） */
  private expireHostUi(id: string): void {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return
    this.pendingHostUi.delete(id)
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    clearTimeout(pending.hardTimer)
    pending.reject(new CapabilityCommandError('question_timeout', '问题等待超时，未猜测用户答案'))
  }

  /**
   * 延长一次宿主提问的等待（用户在面板倒计时上点一下）。
   *
   * 为什么必须走主进程：超时是**主进程的计时器**在抱，只改渲染端的倒计时
   * 等于骗用户 —— 到点仍然会报超时。上限与夹取全在 `shared/ui-timeout.ts`。
   * 只对**宿主发起的**提问生效（`pendingHostUi`）；扩展自己的 `ui-request`
   * 超时由 pi 侧解析，这里不能替它们做主。
   */
  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return { ok: false, error: 'question_not_pending' }
    /* 还没开始计时（用户没看到过）—— 先开始，再加时 */
    if (!pending.started) this.startHostUiTimer(id)
    const now = Date.now()
    const deadline = extendDeadline(pending.deadline, now, extraMs)
    const timeout = deadline - now
    if (pending.timer) clearTimeout(pending.timer)
    pending.timeout = timeout
    pending.deadline = deadline
    pending.timer = setTimeout(() => this.expireHostUi(id), timeout)
    /* 加时也要把兜底往后推，否则点了「加 2 分钟」却仍被硬上限掐掉 */
    clearTimeout(pending.hardTimer)
    pending.hardTimer = setTimeout(() => this.expireHostUi(id), timeout + UI_TIMEOUT_HARD)
    this.host.push({ ch: 'ui-deadline', payload: { id, timeout, deadline } })
    return { ok: true, timeout, deadline }
  }


  handleUi(req: Record<string, unknown>): void {
    const id = String(req.id ?? '')
    const method = String(req.method ?? '')

    // fire-and-forget 的几种
    if (method === 'notify') {
      this.host.push({ ch: 'notify', payload: { id, method: 'notify', ...req } as never })
      return
    }
    if (method === 'setStatus') {
      this.host.push({
        ch: 'status',
        payload: {
          key: String(req.statusKey ?? 'ext'),
          text: req.statusText === undefined ? undefined : String(req.statusText)
        }
      })
      return
    }
    if (method === 'setTitle') {
      this.host.push({ ch: 'title', payload: String(req.title ?? '砚') })
      return
    }
    if (method === 'set_editor_text') {
      this.host.push({ ch: 'editor-text', payload: String(req.text ?? '') })
      return
    }
    if (method === 'setWidget') {
      // TUI 里它显示在输入框上方。桌面端把它收进右栏「扩展」分区 ——
      // 扩展写的东西（MCP/LSP 状态之类）对用户有意义，直接丢等于骗扩展。
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines.map((x) => String(x)) : undefined
      this.host.push({ ch: 'widget', payload: { key: String(req.widgetKey ?? 'ext'), lines } })
      return
    }

    // 需要应答的对话框
    if (id && this.seen.has(id)) return
    if (id) this.seen.add(id)
    if (id) this.pending.add(id)
    /*
     * `sensitive` 是**请求方声明**的安全分类（方案第 6 节）：
     * 只有它为 true 时才走模态确认（焦点圈定），其余都走非模态问题面板。
     * 不从问题措辞里推断 —— 那既不可靠也容易被绕过。
     */
    const payload = { id, method, sensitive: req.sensitive === true, ...req } as unknown as ExtensionUiRequest
    if (id) this.payloads.set(id, payload)
    this.host.push({ ch: 'ui-request', payload })
  }

  /** 当前还没答复的问题（远程端列出用；不含通知类请求） */
  pendingUiRequests(): ExtensionUiRequest[] {
    for (const id of this.payloads.keys()) {
      if (!this.pending.has(id)) this.payloads.delete(id)
    }
    return [...this.payloads.values()]
  }

  /**
   * 从手机回答一个问题。
   *
   * 敏感确认（删除、授权、付费……，由请求方声明）不接受远程答复：需求稿第 6 节要求
   * 本机危险操作由用户在这台电脑上确认。答复后推一条 `ui-resolved`，电脑上的面板随之移除。
   */
  answerUiRemotely(
    id: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): { ok: true } | { ok: false; code: 'question_not_pending' | 'sensitive_confirmation_requires_desktop' } {
    const request = this.pendingUiRequests().find((item) => item.id === id)
    if (!request) return { ok: false, code: 'question_not_pending' }
    if (request.sensitive === true && !('cancelled' in answer)) {
      return { ok: false, code: 'sensitive_confirmation_requires_desktop' }
    }
    this.respondUi({ id, ...answer } as HostUiResponse & { id: string }, 'remote')
    return { ok: true }
  }

  /**
   * 回答一个问题（渲染端经 IPC 调用；手机端经 answerUiRemotely）。
   * 答复后推 `ui-resolved`：另一端（电脑面板 / 手机）据此移除这条问题。
   */
  respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): void {
    const wasPending = !!res.id && this.pending.has(res.id)
    const hostPending = this.pendingHostUi.get(res.id)
    if (hostPending) {
      if (hostPending.timer) clearTimeout(hostPending.timer)
      clearTimeout(hostPending.hardTimer)
      this.pendingHostUi.delete(res.id)
      this.pending.delete(res.id)
      hostPending.resolve(res)
    } else {
      if (res.id) this.pending.delete(res.id)
      this.host.respondToPi(res as Record<string, unknown>)
    }
    if (res.id) this.payloads.delete(res.id)
    if (wasPending) this.host.push({ ch: 'ui-resolved', payload: { id: res.id, by } })
  }

  rejectPendingHostUi(reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pendingHostUi) {
      if (pending.timer) clearTimeout(pending.timer)
      clearTimeout(pending.hardTimer)
      this.pendingHostUi.delete(id)
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
