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
  respondToPi(res: Record<string, unknown>): void
}

export class UiRequests {
  constructor(private readonly host: UiRequestsHost) {}

  readonly seen = new Set<string>()
  readonly pending = new Set<string>()
  readonly payloads = new Map<string, ExtensionUiRequest>()
  private readonly pendingHostUi = new Map<string, PendingHostUi>()

  requestHostUi(request: {
    method: 'select' | 'input'
    title: string
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
      request.signal?.addEventListener('abort', () => this.respondUi({ id, cancelled: true }), { once: true })
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
    this.pendingHostUi.delete(id)
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    clearTimeout(pending.hardTimer)
    this.payloads.delete(id)
    this.host.push({ ch: 'ui-resolved', payload: { id, by: 'timeout' } })
    pending.reject(new CapabilityCommandError(
      'question_timeout',
      pending.started
        ? '问题等待超时，未猜测用户答案'
        : '问题等待超时：问题面板始终没有显示给用户（用户很可能没看到），未猜测用户答案'
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
      this.host.push({ ch: 'title', payload: String(req.title ?? '砚') })
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
    return [...this.payloads.values()]
  }

  answerUiRemotely(
    id: string,
    answer: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): { ok: true } | { ok: false; code: 'question_not_pending' | 'sensitive_confirmation_requires_desktop' } {
    const request = this.pendingUiRequests().find((item) => item.id === id)
    if (!request) return { ok: false, code: 'question_not_pending' }
    if ((request.sensitive === true || request.purpose === 'approval') && !('cancelled' in answer)) {
      return { ok: false, code: 'sensitive_confirmation_requires_desktop' }
    }
    this.respondUi({ id, ...answer } as HostUiResponse & { id: string }, 'remote')
    return { ok: true }
  }

  respondUi(res: HostUiResponse & { id: string }, by: 'desktop' | 'remote' = 'desktop'): void {
    const wasPending = !!res.id && this.pending.has(res.id)
    const hostPending = this.pendingHostUi.get(res.id)
    if (res.id?.startsWith('yan-question-') && !hostPending) return
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

  cancelPending(): void {
    for (const id of [...this.pending]) this.respondUi({ id, cancelled: true })
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
      pending.reject(error)
    }
  }
}
