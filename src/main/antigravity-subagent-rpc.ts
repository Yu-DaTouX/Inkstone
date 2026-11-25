import { EventEmitter } from 'node:events'
import { ANTIGRAVITY_APPROVAL_MODE, ANTIGRAVITY_DEFAULT_MODE, ANTIGRAVITY_PROMPT_LIMIT, ANTIGRAVITY_PROVIDER } from '../shared/antigravity'
import { THINKING_LEVELS } from '../shared/thinking-levels'
import { continuationPrompt } from '../shared/continuation-prompt'
import { isAuthRejected } from '../shared/model-errors'
import { pick } from '../shared/ui-lang'
import type { UIToolCall } from '../shared/ui-message'
import { antigravityStopError, launchAntigravity, type AntigravitySession } from './antigravity'
import { splitAntigravityErrorLine } from './antigravity-error-line'
import { waitAuthBlip } from './auth-blip'
import type { SubagentRpc } from './subagents'

type Approval = (request: { detail: string; title: string }, signal: AbortSignal) => Promise<boolean>

type Options = { thinkingLevel?: string; readOnly?: boolean; resumeSessionId?: string; launch?: typeof launchAntigravity; authRetryDelayMs?: number }
type Turn = { cancelled: boolean; done?: Promise<void> }

const AUTH_RECOVERIES = 2

export class AntigravitySubagentRpc implements SubagentRpc {
  private readonly events = new EventEmitter()
  private session?: AntigravitySession
  private ready?: Promise<void>
  private failure?: string
  private thinkingLevel?: string
  private mode = ANTIGRAVITY_APPROVAL_MODE
  private active = false
  private closed = false
  private exited = false
  private closePromise?: Promise<void>
  private turn?: Turn
  private readonly model

  constructor(private readonly cwd: string, modelId: string, private readonly approve: Approval, private readonly options: Options = {}) {
    this.model = { provider: ANTIGRAVITY_PROVIDER, api: 'antigravity-acp', id: modelId }
  }

  on(event: string, listener: (...args: never[]) => void): void {
    this.events.on(event, listener as (...args: unknown[]) => void)
  }

  get running(): boolean { return !this.closed && !this.exited && !!this.ready }

  get antigravitySessionId(): string | undefined { return this.session?.acpSessionId || undefined }

  private handleClosed(error: string, from?: AntigravitySession): void {
    if (from && from !== this.session) return
    this.active = false
    this.failure ??= error
    if (this.exited || this.closed) return
    this.exited = true
    if (!this.turn) this.events.emit('exit', 1, null)
  }

  spawn(): void {
    if (this.ready || this.closed) return
    this.ready = (async () => {
      const level = this.options.thinkingLevel
      if (level !== undefined && !THINKING_LEVELS.includes(level)) throw new Error(pick('无效的 Antigravity 思考档。', 'Invalid Antigravity thinking level.'))
      const session = this.session = this.attach((this.options.launch ?? launchAntigravity)(this.cwd))
      await this.configure(session, this.options.resumeSessionId)
      if (this.closed || this.exited) return
      this.active = true
    })().catch(async (error: unknown) => {
      this.failure ??= error instanceof Error ? error.message : String(error)
      this.active = false
      const notify = !this.closed && !this.exited
      this.exited = true
      await this.session?.close()
      if (notify && !this.closed) this.events.emit('spawn-error', new Error(this.failure))
    })
  }

  private attach(session: AntigravitySession): AntigravitySession {
    session.onEvent = (event) => {
      if (event.type === 'closed') this.handleClosed(event.error, session)
      else if (event.type === 'permission' || event.type === 'question') session.reply(event.id, null)
      else if (event.type === 'elicitation') session.replyElicitation(event.id, { action: 'cancel' })
    }
    return session
  }

  private async configure(session: AntigravitySession, resumeSessionId?: string): Promise<void> {
    const level = this.options.thinkingLevel
    let models = await session.start(this.cwd, undefined, { ...(this.options.readOnly ? { mode: 'plan' } : {}), ...(resumeSessionId ? { resumeSessionId } : {}) })
    if (resumeSessionId && !session.resumed) throw new Error(pick('Antigravity 没能恢复这个子代理原来的会话；请新派任务并带上上次结论。', 'Antigravity could not restore this subagent\'s session; start a new one and include the previous result.'))
    if (models.current !== this.model.id) models = await session.selectModel(this.model.id)
    if (level !== undefined && models.thinking?.current !== level) models = await session.selectThinking(level)
    const mode = this.options.readOnly ? 'plan' : models.modes?.options.some(({ id }) => id === ANTIGRAVITY_DEFAULT_MODE) ? ANTIGRAVITY_DEFAULT_MODE : ANTIGRAVITY_APPROVAL_MODE
    models = await session.confirmPromptMode(mode)
    if (models.current !== this.model.id || !models.available.some(({ id }) => id === this.model.id)) throw new Error(pick('CLI 未切到指定模型。', 'The CLI did not select the requested model.'))
    if (level !== undefined && models.thinking?.current !== level) throw new Error(pick('CLI 未确认指定思考档。', 'The CLI did not confirm the requested thinking level.'))
    this.thinkingLevel = models.thinking?.current
    this.mode = mode
  }

  private async relaunch(resumeSessionId: string): Promise<AntigravitySession> {
    const old = this.session
    this.session = undefined
    this.exited = false
    this.failure = undefined
    await old?.close()
    if (this.closed) throw new Error(pick('子代理已关闭。', 'The subagent is closed.'))
    const session = this.session = this.attach((this.options.launch ?? launchAntigravity)(this.cwd))
    try {
      await this.configure(session, resumeSessionId)
    } catch (error) {
      await session.close()
      throw error
    }
    if (this.closed) {
      await session.close()
      throw new Error(pick('子代理已关闭。', 'The subagent is closed.'))
    }
    return session
  }

  async command(type: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string; data?: unknown }> {
    if (type === 'abort') {
      if (this.turn) {
        this.turn.cancelled = true
        this.session?.cancel()
      } else if (this.running && !this.active) await this.close()
      return { success: true }
    }
    if (!this.running) return { success: false, error: this.failure ?? pick('Antigravity 未启动。', 'Antigravity not running.') }
    if (type === 'get_state' && options?.timeoutMs && this.ready) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.ready, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.timeoutMs) })])
      clearTimeout(timer)
    }
    if (this.failure) return { success: false, error: this.failure }
    if (type === 'get_state') return { success: this.active, data: { model: this.model, thinkingLevel: this.thinkingLevel ?? 'off' } }
    if (type === 'set_model') return { success: this.active && params?.provider === ANTIGRAVITY_PROVIDER && params?.modelId === this.model.id }
    if (type === 'get_session_stats') return { success: true, data: {} }
    if (type !== 'prompt') return { success: false, error: pick('Antigravity 不支持这项子代理操作。', 'This subagent operation is not supported by Antigravity.') }
    const message = params?.message
    if (typeof message !== 'string' || !message.trim() || message.length > ANTIGRAVITY_PROMPT_LIMIT || !this.session || !this.active || this.turn) return { success: false, error: pick('Antigravity 正忙或任务太长。', 'Antigravity is busy or the task is too long.') }
    const turn: Turn = { cancelled: false }
    this.turn = turn
    turn.done = this.prompt(this.session, message, turn).finally(() => { if (this.turn === turn) this.turn = undefined })
    return { success: true, data: { disposition: 'started' } }
  }

  private async prompt(firstSession: AntigravitySession, message: string, turn: { cancelled: boolean }): Promise<void> {
    let session = firstSession
    const user = { role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() }
    const assistant = { role: 'assistant', model: this.model.id, provider: this.model.provider, timestamp: Date.now() }
    const content: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = []
    const calls = new Map<string, UIToolCall>()
    const approvals = new Map<number, AbortController>()
    const snapshot = () => ({ ...assistant, content: content.map((block) => ({ ...block })), yanAntigravityTools: [...calls.values()] })
    const emit = (event: Record<string, unknown>) => { if (!this.closed) this.events.emit('event', event) }
    const toolEvent = (type: string, call: UIToolCall) => emit({ type: `tool_execution_${type}`, toolCallId: call.id, toolName: call.name, ...(type === 'end' ? { isError: call.status === 'error' } : {}) })
    const update = () => emit({ type: 'message_update', message: snapshot() })
    let openBlock: typeof content[number] | undefined
    const wire = (session: AntigravitySession) => { session.onEvent = (event) => {
      if (event.type === 'permission-cleared' || event.type === 'elicitation-cleared') {
        approvals.get(event.id)?.abort()
        approvals.delete(event.id)
      } else if (event.type === 'closed') {
        this.handleClosed(event.error, session)
      } else if (event.type === 'question') {
        session.reply(event.id, null)
      } else if (event.type === 'elicitation') {
        session.replyElicitation(event.id, { action: 'cancel' })
      } else if (this.closed || turn.cancelled) {
        if (event.type === 'permission') session.reply(event.id, null)
      } else if (event.type === 'text') {
        if (openBlock?.type === 'text') openBlock.text += event.text
        else content.push(openBlock = { type: 'text', text: event.text })
        update()
      } else if (event.type === 'thought') {
        if (openBlock?.type === 'thinking') openBlock.thinking += event.text
        else content.push(openBlock = { type: 'thinking', thinking: event.text })
        update()
      } else if (event.type === 'tool') {
        openBlock = undefined
        const old = calls.get(event.id)
        const now = Date.now()
        const status = event.status === 'completed' ? 'ok' : event.status === 'failed' ? 'error' : event.status === 'in_progress' ? 'running' : old?.status ?? 'pending'
        const completed = status === 'ok' || status === 'error'
        const call: UIToolCall = { id: event.id, name: event.title || old?.name || 'Antigravity', status, args: event.args ?? old?.args ?? {}, output: event.output ?? old?.output,
          details: { antigravity: true, kind: event.kind }, startedAt: old?.startedAt ?? now, endedAt: completed ? old?.endedAt ?? now : undefined }
        calls.set(event.id, call)
        if (!old) toolEvent('start', call)
        if (completed && !old?.endedAt) toolEvent('end', call)
        else if (!completed && old) toolEvent('update', call)
        update()
      } else if (event.type === 'permission') {
        const allow = event.options.find((option) => option.allow)
        const deny = event.options.find((option) => !option.allow)
        if (!allow || this.options.readOnly) { session.reply(event.id, deny?.id ?? null); return }
        const controller = new AbortController()
        approvals.set(event.id, controller)
        void Promise.resolve().then(() => !controller.signal.aborted && this.approve(event, controller.signal)).then(
          (approved) => session.reply(event.id, approved && !controller.signal.aborted ? allow.id : deny?.id ?? null),
          () => session.reply(event.id, deny?.id ?? null)
        )
      }
    } }
    wire(session)
    let stopReason = 'stop'
    let errorMessage: string | undefined
    try {
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: user })
      emit({ type: 'message_end', message: user })
      emit({ type: 'message_start', message: snapshot() })
      let text = message
      let recoveries = 0
      while (!turn.cancelled && !this.closed) {
        const reason = await session.prompt(text, this.model.id, this.thinkingLevel, this.mode)
        if (reason === 'cancelled') { turn.cancelled = true; break }
        if (reason !== 'end_turn') { stopReason = 'error'; errorMessage = antigravityStopError(reason); break }
        const last = content[content.length - 1]
        const reported = last?.type === 'text' ? splitAntigravityErrorLine(last.text) : null
        if (!last || !reported || !isAuthRejected(reported.error)) break
        if (reported.text) (last as { text: string }).text = reported.text
        else content.pop()
        openBlock = undefined
        update()
        const resumeId = session.acpSessionId
        if (recoveries >= AUTH_RECOVERIES || !resumeId) { stopReason = 'error'; errorMessage = reported.error; break }
        recoveries += 1
        await waitAuthBlip(this.options.authRetryDelayMs)
        if (turn.cancelled || this.closed) break
        session = await this.relaunch(resumeId)
        wire(session)
        text = continuationPrompt('model-error', 'subagent')
      }
    } catch (error) {
      stopReason = 'error'
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      for (const approval of approvals.values()) approval.abort()
      session.clearTools()
      this.attach(session)
    }
    if (turn.cancelled || this.closed) { stopReason = 'aborted'; errorMessage = undefined }
    for (const [id, call] of calls) {
      if (call.endedAt) continue
      const ended: UIToolCall = { ...call, status: 'error', cancelled: stopReason !== 'stop', endedAt: Date.now() }
      calls.set(id, ended)
      toolEvent('end', ended)
    }
    emit({ type: 'message_end', message: { ...snapshot(), stopReason, errorMessage } })
    emit({ type: 'agent_settled' })
    if (this.exited && !this.closed) this.events.emit('exit', 1, null)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.active = false
    this.closePromise = Promise.allSettled([this.session?.close(), this.turn?.done]).then(() => undefined)
    return this.closePromise
  }
}
