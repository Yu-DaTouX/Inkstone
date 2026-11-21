import { EventEmitter } from 'node:events'
import { ANTIGRAVITY_PROMPT_LIMIT, ANTIGRAVITY_PROVIDER } from '../shared/antigravity'
import { pick } from '../shared/ui-lang'
import type { UIToolCall } from '../shared/ui-message'
import { launchAntigravity, type AntigravitySession } from './antigravity'
import type { SubagentRpc } from './subagents'

type Approval = (request: { detail: string; title: string }, signal: AbortSignal) => Promise<boolean>

export class AntigravitySubagentRpc implements SubagentRpc {
  private readonly events = new EventEmitter()
  private session?: AntigravitySession
  private ready?: Promise<void>
  private failure?: string
  private active = false
  private closed = false
  private exited = false
  private runningTurn?: Promise<void>
  private readonly model

  constructor(private readonly cwd: string, modelId: string, private readonly approve: Approval) {
    this.model = { provider: ANTIGRAVITY_PROVIDER, api: 'antigravity-acp', id: modelId }
  }

  on(event: string, listener: (...args: never[]) => void): void {
    this.events.on(event, listener as (...args: unknown[]) => void)
  }

  get running(): boolean { return !this.closed && !this.exited && !!this.ready }

  private handleClosed(error: string): void {
    if (this.exited) return
    this.exited = true
    this.active = false
    this.failure ??= error
    if (!this.closed) this.events.emit('exit', 1, null)
  }

  spawn(): void {
    if (this.ready || this.closed) return
    this.ready = (async () => {
      const session = this.session = launchAntigravity(this.cwd)
      session.onEvent = (event) => {
        if (event.type === 'closed') this.handleClosed(event.error)
      }
      const models = await session.start(this.cwd)
      const selected = models.current === this.model.id ? models : await session.selectModel(this.model.id)
      if (selected.current !== this.model.id || !selected.available.some(({ id }) => id === this.model.id)) throw new Error(pick('CLI 未切到指定模型。', 'The CLI did not select the requested model.'))
      this.active = true
    })().catch((error: unknown) => {
      this.failure = error instanceof Error ? error.message : String(error)
      this.active = false
      if (!this.closed && !this.exited) {
        this.exited = true
        this.events.emit('spawn-error', new Error(this.failure))
      }
    })
  }

  async command(type: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string; data?: unknown }> {
    if (type === 'abort') {
      this.session?.cancel()
      return { success: true }
    }
    if (!this.running) return { success: false, error: pick('Antigravity 未启动。', 'Antigravity not running.') }
    if (type === 'get_state' && options?.timeoutMs && this.ready) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.ready, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.timeoutMs) })])
      clearTimeout(timer)
      if (!this.active) return { success: false, error: this.failure }
    }
    if (this.failure) return { success: false, error: this.failure }
    if (type === 'get_state') return { success: this.active, data: { model: this.model, thinkingLevel: 'off' } }
    if (type === 'set_model') return { success: this.active && params?.provider === ANTIGRAVITY_PROVIDER && params?.modelId === this.model.id }
    if (type === 'get_session_stats') return { success: true, data: {} }
    if (type !== 'prompt') return { success: false, error: pick('Antigravity 不支持这项子代理操作。', 'This subagent operation is not supported by Antigravity.') }
    const message = params?.message
    if (typeof message !== 'string' || !message.trim() || message.length > ANTIGRAVITY_PROMPT_LIMIT || !this.session || !this.active || this.runningTurn) return { success: false, error: pick('Antigravity 正忙或任务太长。', 'Antigravity is busy or the task is too long.') }
    this.runningTurn = this.prompt(this.session, message).finally(() => { this.runningTurn = undefined })
    return { success: true, data: { disposition: 'started' } }
  }

  private async prompt(session: AntigravitySession, message: string): Promise<void> {
    const user = { role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() }
    const assistant = { role: 'assistant', model: this.model.id, provider: this.model.provider, content: [{ type: 'text', text: '' }], timestamp: Date.now() }
    const calls = new Map<string, UIToolCall>()
    const approvals = new Map<number, AbortController>()
    this.events.emit('event', { type: 'agent_start' })
    this.events.emit('event', { type: 'message_start', message: user })
    this.events.emit('event', { type: 'message_end', message: user })
    this.events.emit('event', { type: 'message_start', message: assistant })
    const update = () => this.events.emit('event', { type: 'message_update', message: { ...assistant, yanAntigravityTools: [...calls.values()] } })
    session.onEvent = (event) => {
      if (this.closed) return
      if (event.type === 'text') {
        assistant.content[0].text += event.text
        update()
      } else if (event.type === 'tool') {
        const old = calls.get(event.id)
        const status = event.status === 'completed' ? 'ok' : event.status === 'failed' ? 'error' : event.status === 'in_progress' ? 'running' : 'pending'
        const call: UIToolCall = { id: event.id, name: event.title || old?.name || 'Antigravity', status, args: event.args ?? old?.args ?? {}, details: { antigravity: true, kind: event.kind } }
        calls.set(event.id, call)
        if (!old) this.events.emit('event', { type: 'tool_execution_start', toolCallId: event.id, toolName: call.name })
        if (status === 'ok' || status === 'error') this.events.emit('event', { type: 'tool_execution_end', toolCallId: event.id, toolName: call.name })
        update()
      } else if (event.type === 'permission') {
        const allow = event.options.find((option) => option.allow)
        const deny = event.options.find((option) => !option.allow)
        if (!allow) { session.reply(event.id, deny?.id ?? null); return }
        const controller = new AbortController()
        approvals.set(event.id, controller)
        void this.approve(event, controller.signal).then(
          (approved) => session.reply(event.id, approved && !controller.signal.aborted ? allow.id : deny?.id ?? null),
          () => session.reply(event.id, deny?.id ?? null)
        )
      } else if (event.type === 'permission-cleared') {
        approvals.get(event.id)?.abort()
        approvals.delete(event.id)
      } else if (event.type === 'closed') {
        this.handleClosed(event.error)
      }
    }
    let stopReason = 'stop'
    let errorMessage: string | undefined
    try {
      const reason = await session.prompt(message)
      if (reason === 'cancelled') stopReason = 'aborted'
      else if (reason !== 'end_turn') { stopReason = 'error'; errorMessage = `Antigravity: ${reason || 'missing stop reason'}` }
    } catch (error) {
      stopReason = 'error'
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      for (const approval of approvals.values()) approval.abort()
    }
    this.events.emit('event', { type: 'message_end', message: { ...assistant, stopReason, errorMessage, yanAntigravityTools: [...calls.values()] } })
    this.events.emit('event', { type: 'agent_settled' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.session?.close()
  }
}
