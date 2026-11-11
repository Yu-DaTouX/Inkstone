import { pick } from '../shared/ui-lang'
import type { ExtensionUiRequest, MainPush } from '../shared/ipc'
import { randomUUID } from 'node:crypto'
import { CapabilityCommandError } from './capability-server'
import { extendDeadline, UI_TIMEOUT_HARD } from '../shared/ui-timeout'

export type HostUiResponse = { value?: string; confirmed?: boolean; cancelled?: boolean }

type PendingHostUi = {
  resolve: (response: HostUiResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  hardTimer: ReturnType<typeof setTimeout>
  timeout: number
  deadline: number
  started: boolean
}

export function questionToolCallId(params: Record<string, unknown>): string | undefined {
  const nested = params.toolCall && typeof params.toolCall === 'object' ? (params.toolCall as { id?: unknown }).id : undefined
  const id = typeof nested === 'string' && nested ? nested : params.toolCallId
  return typeof id === 'string' && id ? id.slice(0, 200) : undefined
}

export interface UiRequestsHost {
  push(msg: MainPush): void
  respondToPi(res: Record<string, unknown>): boolean | Promise<boolean> | undefined
}

export type UiAnswerResult = { ok: true } | { ok: false; code: 'not_pending' | 'pi_down' }

export type RemoteUiAnswerResult =
  | { ok: true }
  | { ok: false; code: 'question_not_pending' | 'sensitive_confirmation_requires_desktop' | 'pi_down' }

export class UiRequests {
  constructor(private readonly host: UiRequestsHost) {}

  readonly seen = new Set<string>()
  readonly pending = new Set<string>()
  readonly payloads = new Map<string, ExtensionUiRequest>()
  private readonly pendingHostUi = new Map<string, PendingHostUi>()

  requestHostUi(request: {
    method: 'select' | 'input'
    title?: string
    message: string
    options?: string[]
    form?: import('../shared/question-form').QuestionField[]
    placeholder?: string
    purpose?: 'approval'
    sensitive?: boolean
    toolCallId?: string
    timeout: number
    signal?: AbortSignal
  }): Promise<HostUiResponse> {
    const id = `yan-question-${randomUUID()}`
    if (request.signal?.aborted) return Promise.resolve({ cancelled: true })
    return new Promise<HostUiResponse>((resolve, reject) => {
      const pending: PendingHostUi = {
        resolve,
        reject,
        timeout: request.timeout,
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
        deadline: 0,
        ...(request.options ? { options: request.options } : {}),
        ...(request.form ? { form: request.form } : {}),
        ...(request.placeholder ? { placeholder: request.placeholder } : {}),
        ...(request.purpose ? { purpose: request.purpose } : {}),
        ...(request.sensitive ? { sensitive: true } : {}),
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {})
      } as unknown as ExtensionUiRequest
      this.payloads.set(id, payload)
      this.host.push({ ch: 'ui-request', payload })
      request.signal?.addEventListener('abort', () => this.deliverUi({ id, cancelled: true }, 'desktop'), { once: true })
    })
  }

  startHostUiTimer(id: string): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return { ok: false, error: 'question_not_pending' }
    if (pending.started) return { ok: true, timeout: pending.timeout, deadline: pending.deadline }
    const deadline = Date.now() + pending.timeout
    pending.started = true
    pending.deadline = deadline
    pending.timer = setTimeout(() => this.expireHostUi(id), pending.timeout)
    clearTimeout(pending.hardTimer)
    pending.hardTimer = setTimeout(() => this.expireHostUi(id), pending.timeout + UI_TIMEOUT_HARD)
    this.host.push({ ch: 'ui-deadline', payload: { id, timeout: pending.timeout, deadline } })
    return { ok: true, timeout: pending.timeout, deadline }
  }

  private expireHostUi(id: string): void {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return
    const payload = this.payloads.get(id)
    const authorization = payload?.purpose === 'approval' || payload?.sensitive === true
    this.pendingHostUi.delete(id)
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    clearTimeout(pending.hardTimer)
    this.payloads.delete(id)
    this.host.push({ ch: 'ui-resolved', payload: { id, by: 'timeout' } })
    pending.reject(new CapabilityCommandError(
      'question_timeout',
      authorization
        ? pick('等待确认超时：没有人批准，没有获得授权，审批仍然有效。', 'Timed out waiting for confirmation: nobody approved, so authorization was not granted; the approval request is still valid.')
        : pending.started
          ? pick('提问等待超时，用户可能不在。请根据现有上下文按最佳判断继续，在最终回复中写明你作的假设；之后仍需要时再问；审批与高风险确认仍然有效。', 'The question timed out; the user may be away. Continue with your best judgment from the current context, state your assumptions in the final reply, ask again later if still needed; approvals and high-risk confirmations remain required.')
          : pick('提问面板始终没有显示给用户（用户很可能没看到）。请按最佳判断继续并在最终回复写明假设；审批与高风险确认仍然有效。', 'The question panel never reached the user (they likely did not see it). Continue with your best judgment and state your assumptions in the final reply; approvals and high-risk confirmations remain required.')
    ))
  }

  extendHostUi(id: string, extraMs?: unknown): { ok: boolean; timeout?: number; deadline?: number; error?: string } {
    const pending = this.pendingHostUi.get(id)
    if (!pending) return { ok: false, error: 'question_not_pending' }
    if (!pending.started) this.startHostUiTimer(id)
    const now = Date.now()
    const deadline = extendDeadline(pending.deadline, now, extraMs)
    const timeout = deadline - now
    if (pending.timer) clearTimeout(pending.timer)
    pending.timeout = timeout
    pending.deadline = deadline
    pending.timer = setTimeout(() => this.expireHostUi(id), timeout)
    clearTimeout(pending.hardTimer)
    pending.hardTimer = setTimeout(() => this.expireHostUi(id), timeout + UI_TIMEOUT_HARD)
    this.host.push({ ch: 'ui-deadline', payload: { id, timeout, deadline } })
    return { ok: true, timeout, deadline }
  }


  handleUi(req: Record<string, unknown>): void {
    const id = String(req.id ?? '')
    const method = String(req.method ?? '')

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
      this.host.push({ ch: 'title', payload: String(req.title ?? pick('砚', 'Inkstone')) })
      return
    }
    if (method === 'set_editor_text') {
      this.host.push({ ch: 'editor-text', payload: String(req.text ?? '') })
      return
    }
    if (method === 'setWidget') {
      const lines = Array.isArray(req.widgetLines) ? req.widgetLines.map((x) => String(x)) : undefined
      const placement: 'aboveEditor' | 'belowEditor' = req.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor'
      const payload = { key: String(req.widgetKey ?? 'ext'), lines, placement }
      this.host.push({ ch: 'widget', payload })
      return
    }

    if (id && this.seen.has(id)) return
    if (id) this.seen.add(id)
    if (id) this.pending.add(id)
    const payload = { id, method, sensitive: req.sensitive === true, ...req } as unknown as ExtensionUiRequest
    if (id) this.payloads.set(id, payload)
    this.host.push({ ch: 'ui-request', payload })
  }

  pendingUiRequests(): ExtensionUiRequest[] {
    for (const id of this.payloads.keys()) {
      if (!this.pending.has(id)) this.payloads.delete(id)
    }
    return [...this.payloads.entries()].map(([id, payload]) => {
      const host = this.pendingHostUi.get(id)
      return host?.started ? { ...payload, timeout: host.timeout, deadline: host.deadline } as ExtensionUiRequest : payload
    })
  }

  private deliverUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote'): void {
    void this.respondUi(res, by)
  }

  async answerUiRemotely(
    id: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): Promise<RemoteUiAnswerResult> {
    const request = this.pendingUiRequests().find((item) => item.id === id)
    if (!request) return { ok: false, code: 'question_not_pending' }
    if ((request.sensitive === true || request.purpose === 'approval') && !('cancelled' in answer)) {
      return { ok: false, code: 'sensitive_confirmation_requires_desktop' }
    }
    const result = await this.respondUi({ id, ...answer } as HostUiResponse & { id: string }, 'remote')
    if (result.ok) return { ok: true }
    return { ok: false, code: result.code === 'pi_down' ? 'pi_down' : 'question_not_pending' }
  }

  async respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): Promise<UiAnswerResult> {
    const hostPending = this.pendingHostUi.get(res.id)
    const wasPending = !!res.id && this.pending.has(res.id)
    if (res.id?.startsWith('yan-question-') && !hostPending) return { ok: false, code: 'not_pending' }
    if (hostPending) {
      if (hostPending.timer) clearTimeout(hostPending.timer)
      clearTimeout(hostPending.hardTimer)
      this.pendingHostUi.delete(res.id)
      this.pending.delete(res.id)
      hostPending.resolve(res)
    } else {
      let written = false
      try {
        written = (await this.host.respondToPi(res)) === true
      } catch {
        written = false
      }
      if (!written) return { ok: false, code: wasPending ? 'pi_down' : 'not_pending' }
      if (res.id) this.pending.delete(res.id)
    }
    if (res.id) this.payloads.delete(res.id)
    if (wasPending) this.host.push({ ch: 'ui-resolved', payload: { id: res.id, by } })
    return { ok: true }
  }

  cancelPending(): void {
    for (const id of [...this.pending]) this.deliverUi({ id, cancelled: true }, 'desktop')
    this.pending.clear()
    this.payloads.clear()
    this.seen.clear()
  }

  rejectPendingHostUi(reason: string): void {
    const error = new Error(reason)
    for (const [id, pending] of this.pendingHostUi) {
      if (pending.timer) clearTimeout(pending.timer)
      clearTimeout(pending.hardTimer)
      this.pendingHostUi.delete(id)
      this.pending.delete(id)
      this.payloads.delete(id)
      this.host.push({ ch: 'ui-resolved', payload: { id, by: 'timeout' } })
      pending.reject(error)
    }
  }

  discardPending(): void {
    for (const id of [...this.pending]) {
      this.payloads.delete(id)
      this.host.push({ ch: 'ui-resolved', payload: { id, by: 'timeout' } })
    }
    this.pending.clear()
  }
}
