import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pick } from '../shared/ui-lang'
import { ANTIGRAVITY_DEFAULT_MODE, ANTIGRAVITY_PROVIDER, isAntigravityMode, type AntigravityEvent, type AntigravityModel, type AntigravityModels } from '../shared/antigravity'
import { AntigravityHandoffLimitError, antigravityFileDiffs, antigravityPrompt, antigravityStopError, launchAntigravity, normalizeAntigravityImages, scheduleAntigravityToolIdleTimeout, type AntigravitySession, type AntigravitySteer } from './antigravity'
import {
  buildChunkCompactPrompt,
  buildCompactAppendices,
  buildLiveCompactPrompt,
  detectCompactLanguage,
  estimateAntigravityMessageTokens,
  planAntigravityCompaction,
  serializeCompactChunks,
  sliceInContextMessages,
  stripCompactAppendices
} from './antigravity-compact'
import { openAntigravityDelegation } from './antigravity-delegation'
import { antigravityMcpFingerprint, antigravityMcpServices, warmAntigravityMcp, watchAntigravityMcpFiles } from './antigravity-mcp'
import { readAntigravityPreference, saveAntigravityPreference } from './antigravity-preferences'
import { buildElicitationUi } from './antigravity-elicitation'
import { splitAntigravityErrorLine } from './antigravity-error-line'
import { loadMcpServers, mcpServersFile, mcpServersForProject } from './mcp/config'
import { isInkstoneManaged } from './mcp/app-spec'
import { McpConnectionManager } from './mcp/connection-manager'
import type { RunnerMcpConnections } from './mcp/runner-connections'
import type { McpCommandHost } from './agent-commands/mcp-command'
import { DEFAULT_AUTO_COMPACT_TOKENS, autoCompactAt } from '../shared/context-limits'
import { estimateTextTokens } from '../shared/session-metrics'
import { getSettings } from './settings'
import { trustStatus } from './project-trust'
import { PI_AGENT_DIR } from './paths'
import { modelKeyOf } from '../shared/model-capabilities'
import { continuationPrompt } from '../shared/continuation-prompt'
import { isAuthBlip, waitAuthBlip } from './auth-blip'
import { isSubagentNotice } from '../shared/subagent-notice'
import { isHostTextNotice } from '../shared/host-notice-text'
import { snapshotQueue } from './queue-items'
import { planQueueEditOp, type QueueRewriteResult } from './queue-edit'
import { GENERATION_MISMATCH_ERROR, generationMatches, type SessionOperation, type SessionOperationGate } from './session-operation-gate'
import type { NativeSessionRuntime } from './native-session-runtime'
import type { ReadResult } from './session-reader'
import type { SessionItemProjector } from './session-items/projector'
import type { TerminalNoticeDelivery } from './terminal-notice-delivery'
import type { BrowserCommands } from './browser-commands'
import type { UiRequests } from './ui-requests'
import type { CompactionState } from './compaction'
import type { PiRpc } from './protocol'
import type { RunSignal } from '../shared/runs'
import type { TitleSampleMessage } from '../shared/title-samples'
import type { QueueEditOp } from '../shared/ipc'
import type {
  ContextFrom,
  MainPush,
  ModelInfo,
  QueueItem,
  QueueSnapshot,
  QueueState,
  SessionState,
  SessionStats,
  SessionTodo,
  UIMessage,
  UIToolCall
} from '../shared/ipc'

const ANTIGRAVITY_SILENT_STALL_MS = 20_000

type Result = { ok: boolean; error?: string }

export type RunOwner = { rpc: PiRpc | null; generation: number | undefined }

export interface AntigravityRunContext {
  sessionId: string
  sessionPath?: string
  title?: string
}

export type AntigravityConnection = {
  sessionId: string
  model: ModelInfo
  thinking?: AntigravityModels['thinking']
  mode?: string
  modes?: AntigravityModels['modes']
  supportsImages?: boolean
  bridgeConfigured?: boolean
  mcpServers?: string[]
  mcpFingerprint?: string
  mcpStale?: boolean
  mcpToolsStale?: boolean
  session?: AntigravitySession
  hasContext: boolean
  acpSessionId?: string
  acpCwd?: string
  acpHeadEntryId?: string
}

export interface AntigravityHost<Ctx extends AntigravityRunContext = AntigravityRunContext> {
  state: SessionState | null
  compactionState: CompactionState
  contextFrom: ContextFrom | undefined
  runFromUser: boolean
  readonly cwd: string
  readonly stopping: boolean
  readonly rpc: PiRpc | null
  readonly agentRunning: boolean
  readonly messages: UIMessage[]
  readonly nativeRuntime: NativeSessionRuntime | null
  readonly nativeBranchView: boolean
  readonly nativeSessionExtension: string | undefined
  readonly capabilityOpts: { runnerGeneration?: number; sessionId?: string; projectId?: string } | undefined
  readonly subagentHost: { run(command: string, params: Record<string, unknown>, context: {
    cwd: string; parentSessionId?: string; parentSessionFile?: string; parentRunId?: string
    parentGeneration?: number; parentMessageId?: string; projectId?: string; fromAntigravity?: boolean
  }, signal?: AbortSignal): Promise<{ data?: unknown; summary: Record<string, unknown> }> } | undefined
  readonly operations: Pick<SessionOperationGate, 'acquire' | 'release' | 'busy'>
  readonly mcp: Pick<RunnerMcpConnections, 'connectionManager' | 'syncChanged'>
  readonly ui: Pick<UiRequests, 'requestHostUi'>
  readonly items: Pick<SessionItemProjector, 'appendMessage'>
  readonly terminalNotices: Pick<TerminalNoticeDelivery, 'flushHeld'>
  readonly browserCommands: Pick<BrowserCommands, 'runBrowserCommand'>
  readonly commandHost: McpCommandHost
  push(msg: MainPush): void
  asyncOwner(): RunOwner
  ownerCurrent(owner: RunOwner): boolean
  executionActive(): boolean
  piQueueEmpty(): boolean
  claimExecutionAdmission(): { ok: true } | { ok: false; error: string }
  confirmExecutionAdmission(): boolean
  settleExecutionAdmission(): void
  withOperation<T extends Result>(op: SessionOperation, expectGeneration: number | undefined, task: () => Promise<T>): Promise<T | { ok: false; error: string }>
  withExecutionAdmission(task: () => Promise<Result>): Promise<Result>
  enqueueCapabilityChange<T>(work: () => Promise<T>): Promise<T | { ok: false; error: string }>
  readHistoryOf(sessionFile: string, fullText?: boolean): Promise<ReadResult | null>
  hydrate(expected?: { sessionId?: string; sessionFile?: string }): Promise<unknown>
  refreshState(): Promise<unknown>
  refreshStats(): Promise<unknown>
  maybeGenerateTitle(opts?: { prompt?: TitleSampleMessage }): Promise<unknown>
  readStreamLoopAutoContinue(): Promise<boolean>
  setAgentRunning(value: boolean): void
  markStreaming(value: boolean): void
  runObserverContext(): Ctx | null
  observeRun(ctx: Ctx, signal: RunSignal): void
  releaseComputerControl(): void
  localizeHistoryImage(mimeType: string, data: string): string
}

export type AntigravityTurn<Ctx extends AntigravityRunContext = AntigravityRunContext> = {
  done: Promise<void>
  session: AntigravitySession
  stopped: boolean
  interjected: boolean
  steer?: { item: QueueItem; prompt: AntigravitySteer }
  messages: UIMessage[]
  delegation: AbortController
  startedAt: number
  runContext: Ctx | null
  cancel?: () => void
}

export class AntigravityBackend<Ctx extends AntigravityRunContext = AntigravityRunContext> {
  connection?: AntigravityConnection
  turn?: AntigravityTurn<Ctx>
  compacting: { abort: AbortController; done: Promise<void>; sessionId: string } | null = null
  queue: QueueState = { steering: [], followUp: [] }
  heldNotices: string[] = []
  todos: SessionTodo[] = []
  private preferenceSessionId?: string
  private nativeMcp?: McpConnectionManager
  private mcpRefreshTimer?: ReturnType<typeof setTimeout>
  private mcpRefreshTask?: Promise<void>
  private mcpWatcher?: { close(): void }
  private mcpWatchCwd?: string
  private compactHold?: { sessionId: string; untilTokens: number }
  private delegatedIds = new Map<string, Set<string>>()

  constructor(private readonly host: AntigravityHost<Ctx>) {}

  get pendingCount(): number {
    return this.queue.steering.length + this.queue.followUp.length
  }

  syncPreference(sessionId: string): void {
    if (this.preferenceSessionId === sessionId) return
    void this.close()
    this.preferenceSessionId = sessionId
    const saved = sessionId ? readAntigravityPreference(sessionId) : undefined
    if (saved) this.connection = {
      sessionId,
      model: this.modelInfo(saved.model, saved.thinking, saved.supportsImages),
      thinking: saved.thinking,
      modes: saved.modes,
      supportsImages: saved.supportsImages,
      ...(saved.acpSessionId ? { acpSessionId: saved.acpSessionId } : {}),
      ...(saved.acpCwd ? { acpCwd: saved.acpCwd } : {}),
      ...(saved.acpHeadEntryId ? { acpHeadEntryId: saved.acpHeadEntryId } : {}),
      hasContext: false
    }
  }

  resetScope(): void {
    this.turn?.delegation.abort()
    void this.close()
    this.preferenceSessionId = undefined
  }

  async route(lane: 'steering' | 'followUp', text: string, images: QueueItem['images'] | undefined, expectGeneration: number | undefined, fallback: () => Promise<Result>): Promise<Result> {
    if (this.turn) return this.enqueue(lane, text, images, expectGeneration)
    if (this.mcpRefreshTask) await this.mcpRefreshTask.catch(() => undefined)
    if (!this.connection) return fallback()
    if (this.turn) return this.enqueue(lane, text, images, expectGeneration)
    return this.admitSend(text, images, expectGeneration)
  }

  admitSend(text: string, images: QueueItem['images'] | undefined, expectGeneration?: number): Promise<Result> {
    return this.host.withOperation('send', expectGeneration, () => this.host.withExecutionAdmission(() => this.send(text, images)))
  }

  holdNotice(text: string): { success: boolean } {
    if (this.turn) return { success: this.enqueue('steering', text).ok }
    this.heldNotices.push(text)
    return { success: true }
  }

  queueSnapshot(): QueueSnapshot {
    return snapshotQueue(this.queue)
  }

  queueItems(): QueueState {
    return { steering: [...this.queue.steering], followUp: [...this.queue.followUp] }
  }

  restoreSnapshot(snapshot: QueueSnapshot): Result {
    const restore = (kind: 'steering' | 'followUp'): QueueItem[] => snapshot[kind].map((text, index) => {
      const images = snapshot.items?.[kind][index]?.text === text ? snapshot.items[kind][index].images : undefined
      return { id: randomUUID(), text, ...(images?.length ? { images } : {}) }
    }).filter((item) => item.text.length > 0 || item.images?.length)
    const next = { steering: restore('steering'), followUp: restore('followUp') }
    if (!next.steering.length && !next.followUp.length) return { ok: true }
    if (this.pendingCount) {
      const texts = (items: QueueItem[]) => items.map((item) => item.text)
      const same = JSON.stringify({ steering: texts(this.queue.steering), followUp: texts(this.queue.followUp) }) === JSON.stringify({ steering: texts(next.steering), followUp: texts(next.followUp) })
      return same ? { ok: true } : { ok: false, error: pick('新实例已有不同的排队消息；为避免丢失或重复，拒绝覆盖', 'The new instance already has different queued messages; overwrite refused to avoid loss or duplication') }
    }
    return this.rewriteQueue(next)
  }

  planQueue(plan: (state: QueueState) => { next: QueueState } | { error: string }): QueueRewriteResult {
    const outcome = plan(this.queueItems())
    if ('error' in outcome) return { ok: false, error: outcome.error }
    return this.rewriteQueue(outcome.next)
  }

  editQueue(op: QueueEditOp): QueueRewriteResult {
    const plan = planQueueEditOp(this.queueItems(), op)
    if ('error' in plan) return { ok: false, error: plan.error }
    return this.rewriteQueue(plan.next)
  }

  rewriteQueue(next: QueueState): QueueRewriteResult {
    this.queue = {
      steering: next.steering.map((item) => ({ ...item, ...(item.images?.length ? { images: item.images.map((img) => ({ ...img })) } : {}) })),
      followUp: next.followUp.map((item) => ({ ...item, ...(item.images?.length ? { images: item.images.map((img) => ({ ...img })) } : {}) }))
    }
    this.publishQueue()
    if (this.queue.steering.length) this.interject()
    return { ok: true }
  }

  get stopTarget(): boolean {
    return !!this.turn || !!this.compacting
  }

  async abort(): Promise<QueueSnapshot> {
    if (this.turn) {
      const turn = this.turn
      const reclaimed = snapshotQueue(this.queue)
      this.queue = { steering: [], followUp: [] }
      this.publishQueue()
      turn.interjected = false
      turn.stopped = true
      turn.delegation.abort()
      turn.session.cancel()
      turn.cancel?.()
      await turn.done
      if (turn.steer && this.turn?.stopped && this.turn.session === turn.session) await this.turn.done
      return reclaimed
    }
    if (this.compacting) {
      const reclaimed = snapshotQueue(this.queue)
      this.queue = { steering: [], followUp: [] }
      this.publishQueue()
      this.compacting.abort.abort()
      await this.compacting.done
      return reclaimed
    }
    return { steering: [], followUp: [] }
  }

  async forgetContext(): Promise<void> {
    const connection = this.connection
    if (!connection) return
    connection.acpSessionId = undefined
    connection.acpCwd = undefined
    connection.acpHeadEntryId = undefined
    connection.hasContext = false
    await this.persistPreference(connection).catch(() => undefined)
    if (connection.session) {
      const session = connection.session
      connection.session = undefined
      connection.bridgeConfigured = undefined
      connection.mode = undefined
      await session.close()
    }
  }

  async leaveFor(apply: () => Promise<Result>): Promise<Result> {
    const connection = this.connection
    const result = await apply()
    if (result.ok && connection && this.connection === connection) {
      try {
        await saveAntigravityPreference(connection.sessionId, null)
      } catch (error) {
        return { ok: false, error: String(error) }
      }
      await this.close()
      await this.host.refreshState()
    }
    return result
  }

  stateFields(): Pick<SessionState, 'antigravity'> {
    const acp = this.connection
    return acp ? { antigravity: { thinking: acp.thinking, mode: acp.mode ?? acp.modes?.current, modes: acp.modes, bridgeConfigured: acp.bridgeConfigured, mcpServers: acp.session ? acp.mcpServers : undefined } } : {}
  }

  async continueAfterAuthBlip(connection: AntigravityConnection, owner: RunOwner): Promise<void> {
    const current = () => this.host.ownerCurrent(owner) && this.connection === connection && this.host.state?.sessionId === connection.sessionId && !this.turn && !this.host.executionActive()
    if (!(await this.host.readStreamLoopAutoContinue())) return
    await waitAuthBlip()
    if (!current()) return
    const result = await this.host.withOperation('send', owner.generation, () => this.host.withExecutionAdmission(() => this.send(continuationPrompt('model-error'))))
    if (!result.ok && current()) {
      this.host.push({ ch: 'notify', payload: { id: `error-continue-${Date.now()}`, method: 'notify', notifyType: 'error',
        message: pick(`未能自动继续（${result.error ?? '发送失败'}），请手动决定。`, `Could not auto-continue (${result.error ?? 'send failed'}). Decide manually.`) } })
    }
  }

  publishQueue(): void {
    this.host.push({ ch: 'queue', payload: { steering: [...this.queue.steering], followUp: [...this.queue.followUp] } })
    if (this.host.state) {
      const pendingMessageCount = this.queue.steering.length + this.queue.followUp.length
      if (this.host.state.pendingMessageCount !== pendingMessageCount) {
        this.host.state = { ...this.host.state, pendingMessageCount }
        this.host.push({ ch: 'state', payload: this.host.state })
      }
    }
  }

  enqueue(
    lane: 'steering' | 'followUp',
    text: string,
    images?: QueueItem['images'],
    expectGeneration?: number
  ): { ok: boolean; error?: string } {
    if (!generationMatches(expectGeneration, this.host.capabilityOpts?.runnerGeneration)) return { ok: false, error: GENERATION_MISMATCH_ERROR }
    let media
    try { media = normalizeAntigravityImages(images) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    if (!text.trim() && media.length === 0) return { ok: false, error: pick('消息为空，无法发送。', 'Cannot send an empty message.') }
    if (media.length > 0 && this.connection?.supportsImages === false) {
      return { ok: false, error: pick('当前 Antigravity CLI 未声明支持图片输入。', 'The current Antigravity CLI does not advertise image input support.') }
    }
    const item: QueueItem = {
      id: randomUUID(),
      text,
      ...(media.length ? { images: media.map((img) => ({ data: img.data, mimeType: img.mimeType })) } : {})
    }
    this.queue = {
      steering: lane === 'steering' ? [...this.queue.steering, item] : this.queue.steering,
      followUp: lane === 'followUp' ? [...this.queue.followUp, item] : this.queue.followUp
    }
    this.publishQueue()
    if (lane === 'steering') this.interject()
    return { ok: true }
  }

  interject(): void {
    const turn = this.turn
    const connection = this.connection
    const item = this.queue.steering[0]
    if (!turn || !connection || !item || turn.stopped || turn.interjected || turn.steer) return
    if (turn.session.canStartSteer && connection.session === turn.session) {
      const notices = this.heldNotices
      const text = notices.length ? `${notices.join('\n\n')}\n\n${item.text}` : item.text
      let prompt: AntigravitySteer | undefined
      try {
        prompt = turn.session.steerPrompt(antigravityPrompt(text, []), connection.model.id, connection.thinking?.current, connection.mode, item.images)
      } catch {
        return
      }
      if (prompt) {
        turn.steer = { item, prompt }
        this.heldNotices = []
        this.queue.steering.shift()
        this.publishQueue()
      }
      return
    }
    turn.interjected = true
    turn.session.cancel()
    turn.cancel?.()
  }

  editQueueItem(
    queueId: string,
    steer: boolean,
    guard?: (state: QueueState) => string | null
  ): { ok: boolean; text?: string; images?: QueueItem['images']; error?: string } {
    const blocked = guard?.(this.queueItems())
    if (blocked) return { ok: false, error: blocked }
    const next: QueueState = { steering: [...this.queue.steering], followUp: [...this.queue.followUp] }
    let target: QueueItem | undefined
    for (const lane of ['steering', 'followUp'] as const) {
      const idx = next[lane].findIndex((item) => item.id === queueId)
      if (idx >= 0) {
        target = next[lane].splice(idx, 1)[0]
        break
      }
    }
    if (!target) return { ok: false, error: pick('排队消息已不存在', 'Queued message no longer exists') }
    if (steer) next.steering.push(target)
    this.queue = next
    this.publishQueue()
    if (steer) this.interject()
    return { ok: true, text: target.text, ...(target.images?.length ? { images: target.images } : {}) }
  }

  async close(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    if (this.mcpRefreshTimer) {
      clearTimeout(this.mcpRefreshTimer)
      this.mcpRefreshTimer = undefined
    }
    this.mcpWatcher?.close()
    this.mcpWatcher = undefined
    this.mcpWatchCwd = undefined
    const nativeMcp = this.nativeMcp
    this.nativeMcp = undefined
    this.compactHold = undefined
    this.heldNotices = []
    this.turn?.delegation.abort()
    this.turn?.cancel?.()
    this.compacting?.abort.abort()
    if (this.queue.steering.length || this.queue.followUp.length) {
      this.queue = { steering: [], followUp: [] }
      this.publishQueue()
    }
    if (this.todos.length) {
      this.todos = []
      this.host.push({ ch: 'todos', payload: [] })
    }
    await Promise.allSettled([connection?.session?.close(), nativeMcp?.close()])
  }

  async compact(
    reason: 'manual' | 'threshold',
    customInstructions?: string
  ): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
    return this.runCompaction(reason, customInstructions)
  }

  async runCompaction(
    reason: 'manual' | 'threshold',
    customInstructions?: string,
    options?: { holdAdmission?: boolean }
  ): Promise<{ ok: boolean; error?: string; aborted?: boolean }> {
    const initial = this.connection
    const native = this.host.nativeRuntime
    if (!this.host.rpc || !initial) return { ok: false, error: pick('Antigravity 尚未就绪', 'Antigravity is not ready') }
    if (!native?.bridgeCapabilities.includes('append_antigravity_compaction')) {
      return { ok: false, error: pick('当前 Pi 会话不支持写入 Antigravity 压缩记录。', 'This Pi session cannot save Antigravity compaction records.') }
    }
    if (this.host.executionActive()) return { ok: false, error: pick('请等当前操作结束后再压缩会话。', 'Wait for the current operation to finish before compacting.') }
    let lease: ReturnType<SessionOperationGate['acquire']> | null = null
    if (!options?.holdAdmission) {
      lease = this.host.operations.acquire('compact', this.host.capabilityOpts?.runnerGeneration)
      if (!lease.ok) return { ok: false, error: lease.error }
      const execution = this.host.claimExecutionAdmission()
      if (!execution.ok) {
        this.host.operations.release(lease.lease)
        return execution
      }
    }
    const owner = this.host.asyncOwner()
    const ownsCompact = () => this.host.ownerCurrent(owner) && this.host.state?.sessionId === initial.sessionId && this.connection === initial
    const startedAt = Date.now()
    const abort = new AbortController()
    const compacting = { abort, done: Promise.resolve(), sessionId: initial.sessionId }
    this.compacting = compacting
    this.host.compactionState = { ...this.host.compactionState, running: { status: 'running', reason, startedAt } }
    if (this.host.state) {
      this.host.state = {
        ...this.host.state,
        isCompacting: true,
        isStreaming: true,
        compaction: this.host.compactionState.running ?? undefined
      }
      this.host.push({ ch: 'state', payload: this.host.state })
    }
    const summarizeOnSession = (proc: AntigravitySession, promptText: string, expectedMode: string): Promise<string> => {
      if (abort.signal.aborted) return Promise.reject(new Error('Compaction cancelled'))
      let out = ''
      let abortedHere = false
      const onAbort = () => {
        abortedHere = true
        proc.cancel()
      }
      abort.signal.addEventListener('abort', onAbort, { once: true })
      proc.onEvent = (event) => {
        if (event.type === 'text') out += event.text
        else if (event.type === 'question') proc.reply(event.id, null)
        else if (event.type === 'permission') {
          const deny = event.options.find((option) => !option.allow)
          proc.reply(event.id, deny?.id ?? null)
        }
      }
      return proc.prompt(promptText, initial.model.id, initial.thinking?.current, expectedMode).then((stopReason) => {
        if (abortedHere || abort.signal.aborted || stopReason === 'cancelled') throw new Error('Compaction cancelled')
        if (stopReason !== 'end_turn') throw new Error(antigravityStopError(stopReason))
        return out.trim()
      }).finally(() => {
        abort.signal.removeEventListener('abort', onAbort)
      })
    }
    const releaseStaleRunning = () => {
      if (this.host.compactionState.running?.startedAt === startedAt) this.host.compactionState = { ...this.host.compactionState, running: null }
    }
    let result: { ok: boolean; error?: string; aborted?: boolean } = { ok: false }
    const task = (async () => {
      try {
        const sessionFile = this.host.state?.sessionFile
        const full = sessionFile ? await this.host.readHistoryOf(sessionFile, true) : null
        if (!ownsCompact() || abort.signal.aborted) throw new Error(abort.signal.aborted ? 'Compaction cancelled' : GENERATION_MISMATCH_ERROR)
        if (sessionFile && (!full || full.truncated || full.missing)) {
          throw new Error(pick('未能读取完整的会话历史，已取消压缩以避免遗漏上下文。', 'Could not read the full session history; compaction cancelled to avoid losing context.'))
        }
        const rawMessages = this.host.nativeBranchView && full
          ? [...full.messages.filter((message) => message.id.startsWith('history:')), ...this.host.messages.filter((message) => !message.id.startsWith('history:'))]
          : full?.messages ?? this.host.messages
        const previousSummary = full?.compaction?.summary
        const inContext = sliceInContextMessages(rawMessages, full?.compaction)
        const plan = planAntigravityCompaction(inContext, { previousSummary })
        if (!plan.ok) {
          const message = plan.reason === 'already-compacted'
            ? pick('Already compacted', 'Already compacted')
            : pick('Nothing to compact', 'Nothing to compact')
          this.host.compactionState = {
            running: null,
            last: { status: reason === 'threshold' ? 'declined' : 'failed', reason, startedAt, endedAt: Date.now(), error: message }
          }
          result = reason === 'threshold'
            ? { ok: true }
            : { ok: false, error: plan.reason === 'already-compacted' ? pick('当前会话刚刚压缩过，暂无新内容可压缩。', 'Already compacted; no new messages to compact.') : pick('当前没有可压缩的会话内容。', 'Nothing to compact in this session.') }
          return
        }
        const modelKey = modelKeyOf(initial.model)
        const lastAssistant = inContext.findLast((message) => message.role === 'assistant')
        const reportedUsed = initial.session?.context?.used
          ?? (lastAssistant?.model === modelKey ? lastAssistant?.antigravity?.context?.used : undefined)
        const tokensBefore = typeof reportedUsed === 'number' && reportedUsed > 0 ? reportedUsed : plan.estimatedTokens
        const language = detectCompactLanguage(inContext)
        let summaryBody = ''
        if (initial.hasContext && initial.session) {
          const live = initial.session
          try {
            await live.confirmPromptMode('plan')
            initial.acpSessionId = undefined
            initial.acpCwd = undefined
            initial.acpHeadEntryId = undefined
            await this.persistPreference(initial)
            if (!ownsCompact() || abort.signal.aborted) throw new Error(abort.signal.aborted ? 'Compaction cancelled' : GENERATION_MISMATCH_ERROR)
            summaryBody = await summarizeOnSession(
              live,
              buildLiveCompactPrompt({ customInstructions, language, keptCount: plan.kept.length }),
              'plan'
            )
          } catch (error) {
            if (abort.signal.aborted) throw error
          } finally {
            if (initial.session === live) {
              initial.session = undefined
              initial.hasContext = false
              initial.bridgeConfigured = undefined
              initial.mode = undefined
            }
            await live.close()
          }
        }
        if (!summaryBody) {
          if (abort.signal.aborted || !ownsCompact()) throw new Error(abort.signal.aborted ? 'Compaction cancelled' : GENERATION_MISMATCH_ERROR)
          const chunks = serializeCompactChunks(plan.toSummarize)
          if (!chunks.length) throw new Error('Nothing to compact')
          const temp = launchAntigravity(this.host.cwd)
          const onAbortTemp = () => { void temp.close() }
          abort.signal.addEventListener('abort', onAbortTemp, { once: true })
          try {
            let models = await temp.start(this.host.cwd, undefined, { discoverOnly: true })
            if (models.current !== initial.model.id) models = await temp.selectModel(initial.model.id)
            const thinking = initial.thinking?.current
            if (thinking && models.thinking?.options.some((option) => option.id === thinking) && models.thinking?.current !== thinking) {
              models = await temp.selectThinking(thinking)
            }
            models = await temp.confirmPromptMode('plan')
            if (models.current !== initial.model.id || (thinking && models.thinking?.current !== thinking)) {
              throw new Error(pick('Antigravity 未确认压缩所需的模型或思考档。', 'Antigravity did not confirm the model or effort needed for compaction.'))
            }
            let rolling = stripCompactAppendices(previousSummary)
            for (let index = 0; index < chunks.length; index++) {
              if (abort.signal.aborted || !ownsCompact()) throw new Error(abort.signal.aborted ? 'Compaction cancelled' : GENERATION_MISMATCH_ERROR)
              rolling = await summarizeOnSession(
                temp,
                buildChunkCompactPrompt(chunks[index], {
                  previousSummary: rolling,
                  customInstructions,
                  language,
                  chunkIndex: index,
                  totalChunks: chunks.length
                }),
                'plan'
              )
            }
            summaryBody = rolling
          } finally {
            abort.signal.removeEventListener('abort', onAbortTemp)
            await temp.close()
          }
        }
        if (!summaryBody.trim()) throw new Error('Compaction produced an empty summary')
        if (!ownsCompact() || abort.signal.aborted) throw new Error(abort.signal.aborted ? 'Compaction cancelled' : GENERATION_MISMATCH_ERROR)
        const finalSummary = summaryBody.trim() + buildCompactAppendices(plan.toSummarize, previousSummary)
        const { entryId } = await native.appendAntigravityCompaction({
          sessionId: initial.sessionId,
          summary: finalSummary,
          ...(plan.firstKeptEntryId ? { firstKeptEntryId: plan.firstKeptEntryId } : {}),
          tokensBefore,
          details: { antigravity: true, reason, keptCount: plan.kept.length, summarizedCount: plan.toSummarize.length }
        })
        initial.acpSessionId = undefined
        initial.acpCwd = undefined
        initial.acpHeadEntryId = undefined
        await this.persistPreference(initial).catch(() => undefined)
        if (initial.session) {
          const old = initial.session
          initial.session = undefined
          initial.hasContext = false
          initial.bridgeConfigured = undefined
          initial.mode = undefined
          await old.close()
        }
        if (!ownsCompact()) {
          releaseStaleRunning()
          result = { ok: true }
          return
        }
        const endedAt = Date.now()
        const afterTokens = estimateTextTokens(finalSummary) + plan.kept.reduce((sum, message) => sum + estimateAntigravityMessageTokens(message), 0)
        this.host.compactionState = {
          running: null,
          last: {
            status: 'completed',
            reason,
            startedAt,
            endedAt,
            entryId,
            beforeTokens: tokensBefore,
            afterTokens,
            afterMeasured: false,
            ...(plan.firstKeptEntryId ? { firstKeptEntryId: plan.firstKeptEntryId } : {})
          }
        }
        this.host.contextFrom = { firstKeptEntryId: plan.firstKeptEntryId ?? entryId, compactedAt: endedAt }
        this.compactHold = undefined
        if (this.compacting === compacting) this.compacting = null
        await this.host.hydrate({ sessionId: initial.sessionId, sessionFile: this.host.state?.sessionFile })
        await this.host.refreshStats()
        result = { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const aborted = abort.signal.aborted || /cancel/i.test(message)
        if (!ownsCompact()) releaseStaleRunning()
        else {
          this.host.compactionState = {
            running: null,
            last: {
              status: aborted ? 'cancelled' : 'failed',
              reason,
              startedAt,
              endedAt: Date.now(),
              ...(aborted ? {} : { error: message })
            }
          }
        }
        result = { ok: false, aborted, error: message }
      } finally {
        if (this.compacting === compacting) this.compacting = null
        if (this.host.state && this.host.state.sessionId === initial.sessionId) {
          this.host.state = {
            ...this.host.state,
            isCompacting: false,
            isStreaming: !!this.turn,
            compaction: this.host.compactionState.running ?? undefined,
            lastCompaction: this.host.compactionState.last ?? undefined,
            ...(this.host.contextFrom ? { contextFrom: this.host.contextFrom } : {})
          }
          this.host.push({ ch: 'state', payload: this.host.state })
        }
        if (lease?.ok) {
          this.host.operations.release(lease.lease)
          this.host.settleExecutionAdmission()
        }
      }
    })()
    compacting.done = task
    await task
    return result
  }

  modelInfo(model: AntigravityModel, thinking?: AntigravityModels['thinking'], supportsImages?: boolean): ModelInfo {
    return { ...model, provider: ANTIGRAVITY_PROVIDER, reasoning: !!thinking, input: supportsImages === false ? ['text'] : ['text', 'image'], contextWindow: 0 }
  }

  bind(connection: AntigravityConnection, session: AntigravitySession): void {
    this.ensureMcpWatcher()
    session.onEvent = (event) => {
      if (this.connection !== connection || connection.session !== session) return
      if (event.type === 'closed') {
        connection.session = undefined
        connection.bridgeConfigured = undefined
        connection.mode = undefined
        connection.hasContext = false
        void this.host.refreshState()
      } else if (event.type === 'context') {
        if (!session.busy) void this.host.refreshStats()
      } else if (event.type === 'models' && !session.busy && event.models.current === connection.model.id &&
        (!connection.thinking || event.models.thinking?.current === connection.thinking.current) &&
        (!connection.mode || event.models.mode === connection.mode)) {
        connection.thinking = event.models.thinking
        connection.mode = event.models.mode
        connection.modes = event.models.modes
        if (typeof event.models.supportsImages === 'boolean') connection.supportsImages = event.models.supportsImages
        connection.model = this.modelInfo(connection.model, connection.thinking, connection.supportsImages)
        void this.host.refreshState()
      } else if (
        (event.type === 'tool' || event.type === 'plan' || event.type === 'permission' || event.type === 'question' || event.type === 'elicitation' || ((event.type === 'text' || event.type === 'thought') && !!event.text)) &&
        connection.hasContext &&
        !session.busy &&
        !this.turn &&
        !this.compacting &&
        !this.host.executionActive() &&
        this.host.nativeRuntime &&
        this.host.state?.sessionId === connection.sessionId
      ) {
        this.startTurn({ connection, session, native: this.host.nativeRuntime, owner: this.host.asyncOwner(), firstEvent: event })
      } else if (event.type === 'question') session.reply(event.id, null)
      else if (event.type === 'elicitation') session.replyElicitation(event.id, { action: 'cancel' })
    }
  }

  sameCwd(a?: string, b?: string): boolean {
    if (!a || !b) return false
    const left = resolve(a)
    const right = resolve(b)
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  }

  persistPreference(connection: AntigravityConnection): Promise<void> {
    const model: AntigravityModel = { id: connection.model.id, name: connection.model.name }
    return saveAntigravityPreference(connection.sessionId, {
      model,
      thinking: connection.thinking,
      modes: connection.modes,
      supportsImages: connection.supportsImages,
      ...(connection.acpSessionId && connection.acpCwd
        ? {
            acpSessionId: connection.acpSessionId,
            acpCwd: connection.acpCwd,
            ...(connection.acpHeadEntryId ? { acpHeadEntryId: connection.acpHeadEntryId } : {})
          }
        : {})
    })
  }

  async resolveResume(
    connection: AntigravityConnection | undefined
  ): Promise<{ sessionId: string; headEntryId: string } | undefined> {
    if (!connection?.acpSessionId || !connection.acpHeadEntryId || this.host.nativeBranchView) return undefined
    if (!this.sameCwd(connection.acpCwd, this.host.cwd)) return undefined
    if (this.host.state?.sessionFile) {
      const full = await this.host.readHistoryOf(this.host.state.sessionFile, true)
      if (!full || full.truncated || full.missing) return undefined
      if (full.compaction && !full.compaction.firstPostEntryId) return undefined
      const inContext = sliceInContextMessages(full.messages, full.compaction)
      if (inContext.at(-1)?.entryId !== connection.acpHeadEntryId) return undefined
      return { sessionId: connection.acpSessionId, headEntryId: connection.acpHeadEntryId }
    }
    if (this.host.messages.at(-1)?.entryId !== connection.acpHeadEntryId) return undefined
    return { sessionId: connection.acpSessionId, headEntryId: connection.acpHeadEntryId }
  }

  async select(modelId: string, restoreThinking?: string, restoreMode?: string, options?: { allowQueued?: boolean }): Promise<{ ok: boolean; error?: string }> {
    const sessionId = this.host.state?.sessionId
    const owner = this.host.asyncOwner()
    if (!owner.rpc?.running || !sessionId || !this.host.nativeRuntime?.bridgeCapabilities.includes('append_antigravity_turn')) {
      return { ok: false, error: pick('当前会话不能接入 Antigravity。', 'This session cannot use Antigravity.') }
    }
    let session: AntigravitySession | undefined
    try {
      const previous = this.connection
      const reuse = previous?.sessionId === sessionId && !previous.mcpStale && previous.session
      const resumeTarget = !reuse && previous?.sessionId === sessionId ? await this.resolveResume(previous) : undefined
      if (!this.host.ownerCurrent(owner) || this.host.state?.sessionId !== sessionId) throw new Error(GENERATION_MISMATCH_ERROR)
      session = reuse || launchAntigravity(this.host.cwd)
      const proc = session
      const host = this.host.subagentHost
      const script = this.host.nativeSessionExtension ? join(dirname(this.host.nativeSessionExtension), 'antigravity-pi-mcp.mjs') : undefined
      const nativeMcp = !reuse && script ? (this.nativeMcp ??= new McpConnectionManager([])) : undefined
      const mcp = !reuse && script ? await antigravityMcpServices({
        agentDir: PI_AGENT_DIR,
        cwd: this.host.cwd,
        trusted: await trustStatus(this.host.cwd).then(({ trusted }) => trusted, () => false),
        host: this.host.mcp.connectionManager(),
        native: nativeMcp,
        onToolsListChanged: () => this.markMcpChanged('tools')
      }) : undefined
      if (mcp) proc.setCleanup(mcp.close)
      if (mcp) {
        const cold = await warmAntigravityMcp(mcp.services)
        if (cold.length) console.warn(`[antigravity-mcp] not ready before session start: ${cold.join(', ')}`)
        if (!this.host.ownerCurrent(owner) || this.host.state?.sessionId !== sessionId) throw new Error(GENERATION_MISMATCH_ERROR)
      }
      let owned = this.delegatedIds.get(sessionId)
      if (!owned) {
        owned = new Set<string>()
        this.delegatedIds.set(sessionId, owned)
        if (this.delegatedIds.size > 32) {
          const oldest = this.delegatedIds.keys().next().value
          if (oldest) this.delegatedIds.delete(oldest)
        }
      }
      const bridge = mcp && script ? await openAntigravityDelegation(script, () => {
        const turn = this.turn
        if (!turn || turn.session !== proc || !this.host.ownerCurrent(owner) || this.host.state?.sessionId !== sessionId) return undefined
        return { signal: turn.delegation.signal, mode: this.connection?.mode, run: host ? (command, params) => host.run(command, params, {
          cwd: this.host.cwd, parentSessionId: sessionId, parentSessionFile: this.host.state?.sessionFile,
          parentRunId: this.host.capabilityOpts?.sessionId, parentGeneration: owner.generation,
          parentMessageId: turn.messages.at(-1)?.id, projectId: this.host.capabilityOpts?.projectId, fromAntigravity: true
        }, turn.delegation.signal) : undefined }
      }, { delegate: !!host, browser: (action, params, signal) => this.host.browserCommands.runBrowserCommand(action, params, signal), services: mcp.services, commandHost: this.host.commandHost, owned }) : undefined
      if (bridge && mcp) proc.setCleanup(async () => { await bridge.close(); await mcp.close() })
      const explicitMode = restoreMode ?? (previous?.sessionId === sessionId ? previous.modes?.current : undefined)
      let models = reuse
        ? await proc.selectModel(modelId)
        : await proc.start(this.host.cwd, bridge ? { stdio: bridge.configs, http: bridge.httpConfigs } : undefined, {
            mode: explicitMode,
            defaultMode: ANTIGRAVITY_DEFAULT_MODE,
            ...(resumeTarget ? { resumeSessionId: resumeTarget.sessionId } : {})
          })
            .then((options) => options.current === modelId ? options : proc.selectModel(modelId))
      const prior = previous?.sessionId === sessionId ? previous : undefined
      const preferredThinking = restoreThinking ?? (prior?.thinking?.current &&
        models.thinking?.options.some(({ id }) => id === prior.thinking?.current) ? prior.thinking.current : undefined)
      if (preferredThinking && models.thinking?.current !== preferredThinking) {
        if (!models.thinking?.options.some(({ id }) => id === preferredThinking)) {
          throw new Error(pick('已保存的 Antigravity 思考档不可用。请重新选择模型或思考档。', 'The saved Antigravity effort is unavailable. Choose the model or effort again.'))
        }
        models = await proc.selectThinking(preferredThinking)
      }
      const desiredMode = explicitMode ?? (models.modes?.options.some(({ id }) => id === ANTIGRAVITY_DEFAULT_MODE) ? ANTIGRAVITY_DEFAULT_MODE : undefined)
      models = await proc.confirmPromptMode(desiredMode)
      if (preferredThinking && models.thinking?.current !== preferredThinking) {
        throw new Error(pick('Antigravity 未确认最终设置，未切换会话。', 'Antigravity did not confirm the final settings; the session was not switched.'))
      }
      const chosen = models.available.find(({ id }) => id === modelId && id === models.current)
      if (!chosen) throw new Error(pick('Antigravity 未切到选中的模型。', 'Antigravity did not switch to the selected model.'))
      if (!this.host.ownerCurrent(owner) || this.host.state?.sessionId !== sessionId || this.host.executionActive() || (!options?.allowQueued && this.host.state.pendingMessageCount)) throw new Error(pick('会话状态已变化，未切换模型。', 'The session changed; model not switched.'))
      const resumed = !reuse && proc.resumed
      const acpSessionId = proc.acpSessionId || (reuse ? previous?.acpSessionId : undefined)
      const acpHeadEntryId = reuse ? previous?.acpHeadEntryId : resumed ? resumeTarget?.headEntryId : undefined
      const selected: AntigravityConnection = {
        sessionId,
        model: this.modelInfo(chosen, models.thinking, models.supportsImages),
        thinking: models.thinking,
        mode: models.mode,
        modes: models.modes,
        supportsImages: models.supportsImages,
        bridgeConfigured: reuse ? previous?.bridgeConfigured : !!bridge && !!host,
        mcpServers: reuse ? previous?.mcpServers : mcp?.services.map(({ name }) => name),
        mcpFingerprint: reuse ? previous?.mcpFingerprint : mcp?.fingerprint,
        session,
        hasContext: (!!reuse && previous?.hasContext === true) || resumed,
        ...(acpSessionId ? { acpSessionId, acpCwd: this.host.cwd } : {}),
        ...(acpHeadEntryId ? { acpHeadEntryId } : {})
      }
      await this.persistPreference(selected)
      if (!this.host.ownerCurrent(owner) || this.host.state?.sessionId !== sessionId) throw new Error(GENERATION_MISMATCH_ERROR)
      this.connection = selected
      this.bind(selected, session)
      if (!reuse) await previous?.session?.close()
      await this.host.refreshState()
      await this.host.refreshStats()
      return { ok: true }
    } catch (error) {
      if (session) {
        const previous = this.connection
        if (previous?.session === session) {
          previous.session = undefined
          previous.bridgeConfigured = undefined
          previous.mode = undefined
          previous.hasContext = false
          void this.host.refreshState()
        }
        await session.close()
      }
      if (!this.connection?.session && this.nativeMcp) {
        const nativeMcp = this.nativeMcp
        this.nativeMcp = undefined
        await nativeMcp.close().catch(() => undefined)
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async currentMcpFingerprint(): Promise<string> {
    const trusted = await trustStatus(this.host.cwd).then(({ trusted }) => trusted, () => false)
    const hostConfigs = mcpServersForProject(loadMcpServers().servers, this.host.capabilityOpts?.projectId)
      .filter((server) => !isInkstoneManaged(server))
    return antigravityMcpFingerprint({ agentDir: PI_AGENT_DIR, cwd: this.host.cwd, trusted, hostConfigs })
  }

  ensureMcpWatcher(): void {
    if (this.mcpWatcher && this.mcpWatchCwd === this.host.cwd) return
    this.mcpWatcher?.close()
    this.mcpWatchCwd = this.host.cwd
    this.mcpWatcher = watchAntigravityMcpFiles(
      [join(PI_AGENT_DIR, 'mcp.json'), join(this.host.cwd, '.pi', 'mcp.json'), mcpServersFile()],
      () => this.markMcpChanged('config')
    )
  }

  markMcpChanged(kind: 'config' | 'tools'): void {
    if (!this.connection) return
    this.connection.mcpStale = true
    if (kind === 'tools') this.connection.mcpToolsStale = true
    this.scheduleMcpRefresh()
  }

  scheduleMcpRefresh(delayMs = 150): void {
    if (this.mcpRefreshTimer) {
      clearTimeout(this.mcpRefreshTimer)
      this.mcpRefreshTimer = undefined
    }
    const conn = this.connection
    if (!conn?.mcpStale || !conn.session || this.host.stopping) return
    this.mcpRefreshTimer = setTimeout(() => {
      this.mcpRefreshTimer = undefined
      void this.refreshStale()
    }, delayMs)
    this.mcpRefreshTimer.unref?.()
  }

  async refreshStale(): Promise<void> {
    if (this.mcpRefreshTask) return this.mcpRefreshTask
    const conn = this.connection
    if (!conn?.mcpStale || !conn.session || this.host.stopping || this.turn || this.compacting ||
      this.host.executionActive() || this.host.state?.pendingMessageCount || conn.session.busy || this.host.operations.busy().length) {
      return
    }
    let task: Promise<void>
    task = this.host.enqueueCapabilityChange(async () => {
      const current = this.connection
      if (!current || current !== conn || !current.mcpStale || !current.session || this.host.stopping ||
        this.turn || this.compacting || this.host.executionActive() || this.host.state?.pendingMessageCount || current.session.busy) {
        return { ok: true }
      }
      if (!current.mcpToolsStale && current.mcpFingerprint !== undefined) {
        const latestFingerprint = await this.currentMcpFingerprint().catch(() => undefined)
        if (this.connection !== current || !current.session) return { ok: true }
        if (latestFingerprint === current.mcpFingerprint) {
          current.mcpStale = false
          return { ok: true }
        }
      }
      return this.host.withOperation('reload', undefined, async () => {
        const active = this.connection
        if (!active || active !== conn || !active.mcpStale || !active.session || this.host.stopping ||
          this.turn || this.compacting || this.host.executionActive() || this.host.state?.pendingMessageCount || active.session.busy) {
          return { ok: true }
        }
        await this.host.mcp.syncChanged({ immediate: true })
        return this.select(active.model.id, active.thinking?.current, active.mode ?? active.modes?.current, { allowQueued: true })
      })
    }).then(() => undefined, () => undefined).finally(() => {
      if (this.mcpRefreshTask === task) this.mcpRefreshTask = undefined
    })
    this.mcpRefreshTask = task
    return task
  }

  async reloadMcp(): Promise<{ ok: boolean; error?: string }> {
    if (!this.connection) return { ok: true }
    if (this.mcpRefreshTimer) {
      clearTimeout(this.mcpRefreshTimer)
      this.mcpRefreshTimer = undefined
    }
    this.connection.mcpStale = true
    this.connection.mcpToolsStale = true
    if (!this.connection.session) return { ok: true }
    if (this.mcpRefreshTask) await this.mcpRefreshTask.catch(() => undefined)
    const conn = this.connection
    if (!conn || !conn.mcpStale || !conn.session) return { ok: true }
    return this.host.enqueueCapabilityChange(() => this.host.withOperation('reload', undefined, async () => {
      const active = this.connection
      if (!active || active !== conn) return { ok: false, error: GENERATION_MISMATCH_ERROR }
      if (!active.session) return { ok: true }
      await this.host.mcp.syncChanged({ immediate: true })
      return this.select(active.model.id, active.thinking?.current, active.mode ?? active.modes?.current, { allowQueued: true })
    }))
  }

  async send(text: string, images?: { data: string; mimeType: string }[]): Promise<{ ok: boolean; error?: string }> {
    const initial = this.connection
    const native = this.host.nativeRuntime
    if (!initial || !native || this.host.executionActive() || !this.host.piQueueEmpty() || (!text.trim() && !images?.length)) {
      return { ok: false, error: pick('当前不能发送 Antigravity 消息。', 'Cannot send an Antigravity message right now.') }
    }
    if (this.host.state?.sessionId !== initial.sessionId) return { ok: false, error: GENERATION_MISMATCH_ERROR }
    let media
    try { media = normalizeAntigravityImages(images) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    if (initial.session && !initial.mcpStale && initial.mcpFingerprint !== undefined) {
      const latestFingerprint = await this.currentMcpFingerprint().catch(() => undefined)
      if (this.connection !== initial || this.host.state?.sessionId !== initial.sessionId) return { ok: false, error: GENERATION_MISMATCH_ERROR }
      if (latestFingerprint !== undefined && latestFingerprint !== initial.mcpFingerprint) initial.mcpStale = true
    }
    if (!initial.session || initial.mcpStale) {
      if (initial.mcpStale) await this.host.mcp.syncChanged({ immediate: true })
      const reconnected = await this.select(initial.model.id, initial.thinking?.current, undefined, { allowQueued: true })
      if (!reconnected.ok) return reconnected
    }
    let connection = this.connection
    let session = connection?.session
    if (!connection || !session || connection.sessionId !== initial.sessionId || this.host.executionActive()) return { ok: false, error: GENERATION_MISMATCH_ERROR }
    if (media.length > 0 && connection.supportsImages === false) {
      return { ok: false, error: pick('当前 Antigravity CLI 未声明支持图片输入。', 'The current Antigravity CLI does not advertise image input support.') }
    }
    const owner = this.host.asyncOwner()
    const ownsTurn = () => this.host.ownerCurrent(owner) && this.host.state?.sessionId === connection?.sessionId && this.connection === connection
    const loadHandoff = async (): Promise<{ ok: true; history: UIMessage[]; compactionSummary?: string } | { ok: false; error: string }> => {
      let list = connection!.hasContext ? [] : this.host.messages
      let summary: string | undefined
      if (!connection!.hasContext && this.host.state?.sessionFile) {
        const sessionFile = this.host.state.sessionFile
        const full = await this.host.readHistoryOf(sessionFile, true)
        if (!ownsTurn() || connection!.session !== session) return { ok: false, error: GENERATION_MISMATCH_ERROR }
        if (!full && !list.length && !this.host.nativeBranchView) {
          const notYetPersisted = await lstat(sessionFile).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
          if (notYetPersisted) {
            const snapshot = await owner.rpc?.command<{ entries: { type: string }[] }>('get_entries').catch(() => null)
            if (!ownsTurn() || connection!.session !== session || this.host.state?.sessionFile !== sessionFile) return { ok: false, error: GENERATION_MISMATCH_ERROR }
            const entries = snapshot?.data?.entries
            if (snapshot?.success && Array.isArray(entries) && entries.every((entry) => entry?.type === 'model_change' || entry?.type === 'thinking_level_change' || entry?.type === 'session_info')) {
              return { ok: true, history: [] }
            }
          }
        }
        if (!full || full.truncated || full.missing) return { ok: false, error: pick('未能读取完整的 Antigravity 交接历史。消息未发送，原记录未改动。', 'Could not read the full Antigravity handoff history. Nothing was sent or changed.') }
        const rawHistory = this.host.nativeBranchView
          ? [...full.messages.filter((message) => message.id.startsWith('history:')), ...list.filter((message) => !message.id.startsWith('history:'))]
          : full.messages
        list = sliceInContextMessages(rawHistory, full.compaction)
        summary = full.compaction?.summary
      }
      return { ok: true, history: list, compactionSummary: summary }
    }
    let handoff = await loadHandoff()
    if (!handoff.ok) return handoff
    await this.host.terminalNotices.flushHeld()
    if (!ownsTurn() || connection.session !== session || this.turn) return { ok: false, error: GENERATION_MISMATCH_ERROR }
    const heldNotices = this.heldNotices.length ? [...this.heldNotices] : []
    const promptOptions = heldNotices.length ? { notices: heldNotices } : undefined
    let prompt: string
    try {
      prompt = antigravityPrompt(text, handoff.history, handoff.compactionSummary, promptOptions)
    } catch (error) {
      if (error instanceof AntigravityHandoffLimitError && !connection.hasContext && handoff.history.length > 0 && this.host.state?.autoCompactionEnabled !== false) {
        this.host.push({ ch: 'notify', payload: { id: `acp-handoff-compact-${Date.now()}`, method: 'notify', notifyType: 'info',
          message: pick('冷交接历史超出 Antigravity 单条上限，正在自动压缩上下文后继续发送…', 'Handoff history exceeds Antigravity\'s single-prompt limit; compacting context before sending…') } })
        const compacted = await this.runCompaction('threshold', undefined, { holdAdmission: true })
        if (!this.host.ownerCurrent(owner) || this.host.state?.sessionId !== initial.sessionId) return { ok: false, error: GENERATION_MISMATCH_ERROR }
        if (!compacted.ok) return { ok: false, error: compacted.error ?? error.message }
        const reconnected = await this.select(connection.model.id, connection.thinking?.current, undefined, { allowQueued: true })
        if (!reconnected.ok) return reconnected
        connection = this.connection
        session = connection?.session
        if (!connection || !session || connection.sessionId !== initial.sessionId || this.host.executionActive()) return { ok: false, error: GENERATION_MISMATCH_ERROR }
        handoff = await loadHandoff()
        if (!handoff.ok) return handoff
        try {
          prompt = antigravityPrompt(text, handoff.history, handoff.compactionSummary, promptOptions)
        } catch (retryError) {
          return { ok: false, error: retryError instanceof Error ? retryError.message : String(retryError) }
        }
      } else {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (!this.host.confirmExecutionAdmission()) return { ok: false, error: pick('会话运行许可已失效，请重新发送。', 'Execution admission expired. Send the message again.') }
    if (heldNotices.length) this.heldNotices.splice(0, heldNotices.length)
    const titleOnSend = !this.host.state?.sessionName && !this.host.messages.some((m) => m.role === 'user')
    this.startTurn({ connection, session, native, owner, userText: text, media, prompt })
    if (titleOnSend) void this.host.maybeGenerateTitle({ prompt: { text, images: media } })
    return { ok: true }
  }

  startTurn(options: {
    connection: AntigravityConnection
    session: AntigravitySession
    native: NativeSessionRuntime
    owner: RunOwner
    userText?: string
    media?: { data: string; mimeType: string }[]
    prompt?: string
    steer?: AntigravitySteer
    stopped?: boolean
    delegation?: AbortController
    firstEvent?: AntigravityEvent
  }): void {
    const { connection, session, native, owner } = options
    const media = options.media ?? []
    const prompted = options.prompt !== undefined || !!options.steer
    const ownsTurn = () => this.host.ownerCurrent(owner) && this.host.state?.sessionId === connection.sessionId && this.connection === connection
    const startedAt = Date.now()
    const startedMono = performance.now()
    const modelId = `${ANTIGRAVITY_PROVIDER}/${connection.model.id}`
    const userImages = media.length
      ? media.map(({ data, mimeType }) => ({ mimeType, data: '', url: this.host.localizeHistoryImage(mimeType, data) }))
      : undefined
    const user: UIMessage | undefined = prompted
      ? { id: `acp-${randomUUID()}`, role: 'user', text: options.userText ?? '', ...(userImages ? { images: userImages } : {}), timestamp: startedAt }
      : undefined
    const makeStep = (timestamp: number): UIMessage => ({ id: `acp-${randomUUID()}`, role: 'assistant', text: '', model: modelId, timestamp })
    let currentStep = makeStep(startedAt)
    const steps: UIMessage[] = [currentStep]
    const stepCalls = new Map<string, Map<string, UIToolCall>>([[currentStep.id, new Map()]])
    const toolStep = new Map<string, UIMessage>()
    const approvals = new Map<number, AbortController>()
    const runContext = this.host.runObserverContext()
    const observe = (signal: RunSignal): void => {
      if (runContext) this.host.observeRun(runContext, signal)
    }
    const turn: AntigravityTurn = this.turn = {
      session,
      done: Promise.resolve(),
      stopped: options.stopped === true,
      interjected: false,
      messages: user ? [user, currentStep] : [currentStep],
      delegation: options.delegation ?? new AbortController(),
      startedAt,
      runContext
    }
    let stepStartMono = startedMono
    let firstTokenMono: number | undefined
    let lastTokenMono: number | undefined
    let firstTextAt: number | undefined
    let produced = false
    let lastTextAt: number | undefined
    let continuousOutput = true
    let turnContext: NonNullable<UIMessage['antigravity']>['context']
    let turnUsage: NonNullable<UIMessage['antigravity']>['usage']
    const buildStepGenTiming = (): UIMessage['generationTiming'] | undefined => {
      if (firstTokenMono === undefined || lastTokenMono === undefined) return undefined
      const ttftMs = Math.max(0, Math.round(firstTokenMono - stepStartMono))
      const decodeMs = Math.max(0, Math.round(lastTokenMono - firstTokenMono))
      const outputDecodeMs = firstTextAt !== undefined && lastTextAt !== undefined && lastTextAt > firstTextAt
        ? Math.max(0, Math.round(lastTextAt - firstTextAt))
        : undefined
      const durationMs = Math.max(ttftMs + decodeMs, Math.round(lastTokenMono - stepStartMono))
      return {
        startEvent: 'turn_start',
        ttftMs,
        decodeMs,
        ...(outputDecodeMs !== undefined ? { outputDecodeMs } : {}),
        durationMs
      }
    }
    const settleStepThinking = (step: UIMessage, now: number): boolean => {
      if (!step.thinkingLive) return false
      step.thinkingLive = false
      if (step.thinkingStartedAt !== undefined) {
        step.thinkingMs = (step.thinkingMs ?? 0) + Math.max(0, now - step.thinkingStartedAt)
      }
      return true
    }
    const advanceStep = (now: number): UIMessage => {
      if (!currentStep.toolCalls?.length) return currentStep
      const prevTiming = buildStepGenTiming()
      if (prevTiming) currentStep.generationTiming = prevTiming
      const settled = settleStepThinking(currentStep, now)
      if (settled || prevTiming) {
        this.host.push({ ch: 'msg-update', payload: { id: currentStep.id, patch: { ...(settled ? { thinkingLive: false, thinkingMs: currentStep.thinkingMs } : {}), ...(prevTiming ? { generationTiming: prevTiming } : {}) } } })
      }
      currentStep = makeStep(now)
      steps.push(currentStep)
      stepCalls.set(currentStep.id, new Map())
      turn.messages.push(currentStep)
      stepStartMono = performance.now()
      firstTokenMono = undefined
      lastTokenMono = undefined
      firstTextAt = undefined
      lastTextAt = undefined
      continuousOutput = true
      this.host.push({ ch: 'msg-add', payload: { ...currentStep } })
      return currentStep
    }
    let settleTimer: NodeJS.Timeout | null = null
    let unsolicitedSettled = false
    let finishUnsolicited: ((reason: string) => void) | undefined
    let failUnsolicited: ((error: Error) => void) | undefined
    const clearSettleTimer = (): void => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = null
    }
    const isWaitingSchedule = (call: UIToolCall): boolean => {
      if (call.status !== 'running' || call.name !== 'Run schedule' || (call.details as { kind?: string } | undefined)?.kind !== 'other') return false
      const duration = (call.args as { DurationSeconds?: unknown } | null)?.DurationSeconds
      return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    }
    const hasActiveWork = (): boolean =>
      approvals.size > 0 || steps.some((step) => step.toolCalls?.some((call) =>
        (call.status === 'pending' || call.status === 'running') && !isWaitingSchedule(call) &&
        !((call.details as { kind?: string } | undefined)?.kind === 'execute' && (call.args as { IsDaemon?: boolean } | undefined)?.IsDaemon === true)))
    const rawIdle = Number(process.env.YAN_ACP_UNSOLICITED_IDLE_MS)
    const customIdle = Number.isFinite(rawIdle) && rawIdle >= 50 && rawIdle <= 10_000 ? rawIdle : undefined
    const textIdleMs = customIdle ?? 2_000
    const usageIdleMs = Math.min(800, textIdleMs)
    const thinkingIdleMs = customIdle ? customIdle * 3 : 30_000
    const toolWaitIdleMs = customIdle ? customIdle * 4 : 60_000
    const scheduleSettle = (overrideMs?: number): void => {
      if (prompted || unsolicitedSettled) return
      clearSettleTimer()
      if (approvals.size > 0) return
      if (hasActiveWork()) {
        settleTimer = scheduleAntigravityToolIdleTimeout((error) => failUnsolicited?.(error), customIdle ? customIdle * 4 : undefined)
        return
      }
      const delay = overrideMs ?? (
        currentStep.text.trim().length > 0 && !currentStep.toolCalls?.length && !currentStep.thinkingLive
          ? textIdleMs
          : currentStep.thinkingLive
            ? thinkingIdleMs
            : toolWaitIdleMs
      )
      settleTimer = setTimeout(() => { finishUnsolicited?.('end_turn') }, delay)
      settleTimer.unref?.()
    }
    currentStep.antigravity = {}
    if (this.todos.length) {
      this.todos = []
      this.host.push({ ch: 'todos', payload: [] })
    }
    this.host.runFromUser = prompted && !isSubagentNotice(options.userText ?? '') && !isHostTextNotice(options.userText ?? '')
    if (options.steer && this.host.agentRunning && this.host.state) {
      this.host.state = { ...this.host.state, runStartedAt: startedAt }
      this.host.push({ ch: 'state', payload: this.host.state })
    }
    this.host.setAgentRunning(true)
    this.host.markStreaming(true)
    observe({ type: 'agent-start' })
    observe({ type: 'activity', activity: 'waiting-model' })
    if (user) this.host.push({ ch: 'msg-add', payload: user })
    this.host.push({ ch: 'msg-add', payload: { ...currentStep } })
    const handleEvent = (event: AntigravityEvent): void => {
      if (!ownsTurn()) return
      if (event.type === 'text' || event.type === 'thought' || event.type === 'tool' || event.type === 'plan') produced = true
      if (event.type === 'text' && !turn.stopped && !turn.interjected) {
        if (!event.text) return
        const now = Date.now()
        const step = advanceStep(now)
        const settled = settleStepThinking(step, now)
        const mono = performance.now()
        firstTokenMono ??= mono
        lastTokenMono = mono
        lastTextAt = mono
        firstTextAt ??= mono
        step.text += event.text
        const gt = buildStepGenTiming()
        if (gt) step.generationTiming = gt
        this.host.push({ ch: 'msg-update', payload: { id: step.id, patch: { textDelta: event.text, thinkingLive: false, ...(settled ? { thinkingMs: step.thinkingMs } : {}), ...(gt ? { generationTiming: gt } : {}) } } })
        observe({ type: 'activity', activity: 'streaming' })
        scheduleSettle()
      } else if (event.type === 'thought' && !turn.stopped && !turn.interjected && event.text) {
        const now = Date.now()
        const step = advanceStep(now)
        if (firstTextAt !== undefined) continuousOutput = false
        const mono = performance.now()
        firstTokenMono ??= mono
        lastTokenMono = mono
        if (!step.thinkingLive) step.thinkingStartedAt = now
        step.thinkingLive = true
        step.thinking = (step.thinking ?? '') + event.text
        const gt = buildStepGenTiming()
        if (gt) step.generationTiming = gt
        this.host.push({ ch: 'msg-update', payload: { id: step.id, patch: { thinkingDelta: event.text, thinkingStartedAt: step.thinkingStartedAt, thinkingLive: true, ...(gt ? { generationTiming: gt } : {}) } } })
        observe({ type: 'activity', activity: 'thinking' })
        scheduleSettle()
      } else if (event.type === 'context' && !turn.stopped) {
        turnContext = { used: event.used, size: event.size }
        currentStep.antigravity = { ...currentStep.antigravity, context: turnContext }
        this.host.push({ ch: 'msg-update', payload: { id: currentStep.id, patch: { antigravity: currentStep.antigravity } } })
        observe({ type: 'context', used: event.used, window: event.size })
        void this.host.refreshStats()
        if (!prompted && !hasActiveWork() && currentStep.text.trim().length > 0 && !currentStep.toolCalls?.length && !currentStep.thinkingLive) {
          scheduleSettle(usageIdleMs)
        }
      } else if (event.type === 'usage') {
        turnUsage = event.usage
      } else if (event.type === 'plan' && !turn.stopped) {
        const todos: SessionTodo[] = event.entries.map((entry) => ({ text: entry.content, done: entry.status === 'done', status: entry.status }))
        this.todos = todos
        this.host.push({ ch: 'todos', payload: todos })
        scheduleSettle()
      } else if (event.type === 'tool') {
        continuousOutput = false
        const now = Date.now()
        const ownerStep = toolStep.get(event.id) ?? currentStep
        toolStep.set(event.id, ownerStep)
        const calls = stepCalls.get(ownerStep.id)!
        const settled = settleStepThinking(ownerStep, now)
        const id = `${ownerStep.id}:${event.id}`
        const previous = calls.get(id)
        const status = event.status === 'completed' ? 'ok' : event.status === 'failed' ? 'error' : event.status === 'in_progress' ? 'running' : previous?.status ?? 'pending'
        const completed = status === 'ok' || status === 'error'
        const name = event.title || previous?.name || 'Antigravity'
        const diffs = status === 'ok' ? antigravityFileDiffs(this.host.cwd, event.diffs) : []
        calls.set(id, { id, name, args: event.args ?? previous?.args ?? {}, status, output: event.output,
          details: { antigravity: true, kind: event.kind ?? (previous?.details as { kind?: string } | undefined)?.kind, antigravityDiffs: diffs },
          startedAt: previous?.startedAt ?? (status === 'running' || completed ? now : undefined),
          endedAt: completed ? previous?.endedAt ?? now : undefined })
        if (!previous) observe({ type: 'tool-start', tool: { name, callId: id } })
        if (completed && !previous?.endedAt) observe({ type: 'tool-end', callId: id, isError: status === 'error' })
        else if (!completed && previous) observe({ type: 'tool-update' })
        ownerStep.toolCalls = [...calls.values()]
        this.host.push({ ch: 'msg-update', payload: { id: ownerStep.id, patch: { toolCalls: ownerStep.toolCalls, thinkingLive: false, ...(settled ? { thinkingMs: ownerStep.thinkingMs } : {}) } } })
        scheduleSettle()
      } else if (event.type === 'permission') {
        if (turn.stopped || turn.interjected) { session.reply(event.id, null); return }
        continuousOutput = false
        const allow = event.options.find((option) => option.allow)
        const deny = event.options.find((option) => !option.allow)
        if (!allow) {
          session.reply(event.id, deny?.id ?? null)
          if (event.blocked) this.host.push({ ch: 'notify', payload: { id: `acp-denied-${currentStep.id}-${event.id}`, method: 'notify', notifyType: 'warning', message: event.blocked } })
          return
        }
        const controller = new AbortController()
        approvals.set(event.id, controller)
        clearSettleTimer()
        void this.host.ui.requestHostUi({ method: 'select', purpose: 'approval', nativeConfirmation: 'inline', sensitive: true,
          title: `Antigravity · ${event.title}`, message: event.detail, signal: controller.signal, timeout: 180_000,
          options: [pick('仅允许这一次', 'Allow once'), pick('拒绝', 'Deny')] }).then(
          (answer) => session.reply(event.id, answer.confirmed && !turn.stopped && !turn.interjected && ownsTurn() ? allow.id : deny?.id ?? null),
          () => session.reply(event.id, deny?.id ?? null)
        )
      } else if (event.type === 'question') {
        if (turn.stopped || turn.interjected) { session.reply(event.id, null); return }
        continuousOutput = false
        const controller = new AbortController()
        approvals.set(event.id, controller)
        clearSettleTimer()
        const reserved = new Set(event.options.map(({ name }) => name))
        const ids = new Map<string, string>()
        const suffixes = new Map<string, number>()
        for (const { id, name } of event.options) {
          let label = name
          let suffix = suffixes.get(name) ?? 2
          while (ids.has(label) || (label !== name && reserved.has(label))) label = `${name} (${suffix++})`
          suffixes.set(name, suffix)
          ids.set(label, id)
        }
        void this.host.ui.requestHostUi({ method: 'select', title: pick('Antigravity 提问', 'Antigravity question'),
          message: event.title, options: [...ids.keys()], signal: controller.signal, timeout: 180_000 }).then(
          (answer) => session.reply(event.id, !answer.cancelled && !turn.stopped && !turn.interjected && ownsTurn() ? ids.get(answer.value ?? '') ?? null : null),
          () => session.reply(event.id, null)
        )
      } else if (event.type === 'elicitation') {
        if (turn.stopped || turn.interjected) { session.replyElicitation(event.id, { action: 'cancel' }); return }
        continuousOutput = false
        const controller = new AbortController()
        approvals.set(event.id, controller)
        clearSettleTimer()
        const { request, parse } = buildElicitationUi(event.message, event.fields)
        void this.host.ui.requestHostUi({ ...request, signal: controller.signal, timeout: 180_000 }).then(
          (answer) => session.replyElicitation(event.id, !turn.stopped && !turn.interjected && ownsTurn() ? parse(answer) : { action: 'cancel' }),
          () => session.replyElicitation(event.id, { action: 'cancel' })
        )
      } else if (event.type === 'permission-cleared' || event.type === 'elicitation-cleared') {
        approvals.get(event.id)?.abort()
        approvals.delete(event.id)
        scheduleSettle()
      } else if (event.type === 'closed') {
        connection.session = undefined
        connection.bridgeConfigured = undefined
        connection.mode = undefined
        connection.hasContext = false
        if (!prompted) failUnsolicited?.(new Error(event.error || pick('Antigravity 已断开连接。', 'Antigravity disconnected.')))
      }
    }
    session.onEvent = handleEvent
    const running = options.steer ? options.steer.attach(handleEvent) : options.prompt !== undefined
      ? session.prompt(options.prompt, connection.model.id, connection.thinking?.current, connection.mode, media)
      : new Promise<string>((resolve, reject) => {
          finishUnsolicited = (reason: string) => {
            if (unsolicitedSettled) return
            unsolicitedSettled = true
            clearSettleTimer()
            resolve(reason)
          }
          failUnsolicited = (error: Error) => {
            if (unsolicitedSettled) return
            unsolicitedSettled = true
            clearSettleTimer()
            reject(error)
          }
          turn.cancel = () => finishUnsolicited?.('cancelled')
        })
    if (options.firstEvent) handleEvent(options.firstEvent)
    let nextQueued: QueueItem | undefined
    let handingOff = false
    let autoCompactNeeded: { used: number; size: number } | undefined
    let settledOutcome: 'completed' | 'stopped' | 'failed' | null = null
    let authBlipRetry = false
    const retireAcp = async () => {
      if (!ownsTurn()) return
      connection.hasContext = false
      connection.acpSessionId = undefined
      connection.acpCwd = undefined
      connection.acpHeadEntryId = undefined
      if (connection.session === session) {
        connection.session = undefined
        connection.bridgeConfigured = undefined
        connection.mode = undefined
        await session.close()
      }
      if (ownsTurn()) await this.persistPreference(connection).catch(() => undefined)
    }
    turn.done = (async () => {
      let status = 'stop'
      let turnError: string | undefined
      let cleanCancel = false
      try {
        const reason = await running
        handingOff = reason === 'end_turn' && !!turn.steer && connection.session === session
        if (reason === 'cancelled' || turn.stopped || turn.interjected) {
          status = 'aborted'
          cleanCancel = reason === 'cancelled'
        } else if (reason !== 'end_turn') {
          status = 'error'
          turnError = antigravityStopError(reason)
        }
        const silentStall = !produced && performance.now() - startedMono >= ANTIGRAVITY_SILENT_STALL_MS
        connection.hasContext = connection.session === session && (handingOff || status === 'stop' || (status === 'aborted' && cleanCancel && !turn.steer && !silentStall))
        const tail = status === 'stop' && !handingOff ? steps[steps.length - 1] : undefined
        const reported = tail ? splitAntigravityErrorLine(tail.text) : null
        if (tail && reported) {
          tail.text = reported.text
          status = 'error'
          turnError = reported.error
          connection.hasContext = false
          authBlipRetry = isAuthBlip(reported.error, { retried: false, continued: options.userText === continuationPrompt('model-error') })
        }
      } catch (error) {
        status = turn.stopped || turn.interjected ? 'aborted' : 'error'
        if ((!turn.stopped && !turn.interjected) || (error instanceof Error && error.name === 'INVALID_THINKING_SIGNATURE')) {
          turnError = error instanceof Error ? error.message : String(error)
        }
        connection.hasContext = false
      } finally {
        clearSettleTimer()
        if (!handingOff) session.clearTools()
        for (const approval of approvals.values()) approval.abort()
        approvals.clear()
      }
      if (!handingOff) turn.delegation.abort()
      if (!connection.hasContext) await retireAcp()
      if (!ownsTurn()) {
        observe({ type: 'stopped', by: 'host', reason: 'interrupted' })
        return
      }
      const elapsedMs = Math.max(0, Math.round(performance.now() - startedMono))
      const endedAt = startedAt + elapsedMs
      const lastStep = steps[steps.length - 1]
      const finalGenTiming = buildStepGenTiming()
      if (finalGenTiming) lastStep.generationTiming = finalGenTiming
      if (turnError) lastStep.error = turnError
      for (const step of steps) {
        step.toolCalls = step.toolCalls?.map((call) => {
          if (status === 'stop' && isWaitingSchedule(call)) {
            observe({ type: 'tool-end', callId: call.id, isError: false })
            return { ...call, status: 'ok', endedAt, output: call.output || pick('已安排定时任务，等待触发。', 'Scheduled; waiting to trigger.') }
          }
          return call.status === 'pending' || call.status === 'running' ? { ...call, status: 'error', cancelled: true, endedAt } : call
        })
        settleStepThinking(step, endedAt)
        if (step !== lastStep) delete step.antigravity
      }
      lastStep.antigravity = {
        ...(turnContext ? { context: turnContext } : {}),
        ...(turnUsage ? { usage: turnUsage } : {})
      }
      const usage = lastStep.antigravity.usage
      if (status === 'stop' && steps.length === 1 && continuousOutput && !lastStep.toolCalls?.length && usage && firstTextAt !== undefined && lastTextAt !== undefined && lastTextAt > firstTextAt) {
        const visible = usage.visibleOutput ?? (!lastStep.thinking && usage.thought === undefined ? usage.output : undefined)
        if (visible !== undefined && (usage.output === undefined || visible <= usage.output)) {
          lastStep.antigravity = { ...lastStep.antigravity, usage: { ...usage, visibleOutput: visible }, outputSpanMs: lastTextAt - firstTextAt }
        }
      }
      lastStep.turnTiming = { logicalTurnId: user?.id ?? steps[0].id, startedAt, endedAt, elapsedMs, terminalReason: status === 'aborted' ? 'stopped' : status === 'error' ? 'failed' : 'completed' }
      try {
        const ids = await native.appendAntigravityTurn({
          sessionId: connection.sessionId,
          ...(user ? { user: options.userText ?? '' } : { continuation: true }),
          ...(media.length ? { userImages: media } : {}),
          steps: steps.map((step) => ({
            text: step.text,
            ...(step.toolCalls?.length ? { tools: step.toolCalls } : {}),
            ...(step.thinking ? { thinking: step.thinking } : {}),
            ...(step.thinkingMs ? { thinkingMs: step.thinkingMs } : {}),
            ...(step.generationTiming ? { genTiming: step.generationTiming } : {}),
            timestamp: step.timestamp
          })),
          model: connection.model.id,
          startedAt,
          endedAt,
          status,
          ...(lastStep.error ? { error: lastStep.error } : {}),
          timing: lastStep.turnTiming,
          antigravity: lastStep.antigravity
        })
        if (user && ids.userId) user.entryId = ids.userId
        const stepIds = ids.assistantIds
        if (stepIds && stepIds.length === steps.length) {
          steps.forEach((step, index) => { step.entryId = stepIds[index] })
        } else {
          lastStep.entryId = ids.assistantId
        }
        if (connection.hasContext && session.acpSessionId && ids.assistantId) {
          connection.acpSessionId = session.acpSessionId
          connection.acpCwd = this.host.cwd
          connection.acpHeadEntryId = ids.assistantId
          if (ownsTurn()) await this.persistPreference(connection).catch(() => undefined)
        }
      } catch (error) {
        lastStep.error = pick(`回复未能保存到会话：${error instanceof Error ? error.message : String(error)}`, `Could not save the Antigravity turn: ${error instanceof Error ? error.message : String(error)}`)
        if (connection.hasContext) await retireAcp()
        if (status !== 'aborted') {
          status = 'error'
          lastStep.turnTiming.terminalReason = 'failed'
        }
      }
      if (!ownsTurn()) {
        observe({ type: 'stopped', by: 'host', reason: 'interrupted' })
        return
      }
      if (!connection.hasContext && connection.session === session) {
        connection.session = undefined
        connection.bridgeConfigured = undefined
        connection.mode = undefined
        await session.close()
      }
      if (!ownsTurn()) {
        observe({ type: 'stopped', by: 'host', reason: 'interrupted' })
        return
      }
      turn.messages = []
      if (user) this.host.items.appendMessage(user)
      for (const step of steps) this.host.items.appendMessage(step)
      if (user) this.host.push({ ch: 'msg-update', payload: { id: user.id, patch: { entryId: user.entryId } } })
      for (const step of steps) this.host.push({ ch: 'msg-update', payload: { id: step.id, patch: step } })
      const outcome = status === 'error' ? 'failed' as const : status === 'aborted' ? 'stopped' as const : 'completed' as const
      if (status === 'error') observe({ type: 'host-fail', message: lastStep.error ?? 'Antigravity' })
      else if (status === 'aborted') observe({ type: 'stopped', by: 'user' })
      else {
        observe({ type: 'agent-end' })
        observe({ type: 'agent-settled', aborted: false })
        if (user) void this.host.maybeGenerateTitle()
      }
      settledOutcome = outcome
      if (!handingOff && status === 'stop' && !turn.stopped && !turn.interjected && this.host.state?.autoCompactionEnabled !== false && turnContext?.used && turnContext.size > 0) {
        const cap = (await getSettings()).autoCompactTokens ?? DEFAULT_AUTO_COMPACT_TOKENS
        const line = autoCompactAt(cap, turnContext.size)
        if (turnContext.used <= line) {
          if (this.compactHold?.sessionId === connection.sessionId) this.compactHold = undefined
        } else if (this.compactHold?.sessionId !== connection.sessionId || turnContext.used >= this.compactHold.untilTokens) {
          autoCompactNeeded = turnContext
        }
      }
      if (!handingOff && !turn.stopped && (this.queue.steering.length || this.queue.followUp.length)) {
        nextQueued = this.queue.steering.shift() ?? this.queue.followUp.shift()
        this.publishQueue()
      }
    })().finally(() => {
      clearSettleTimer()
      for (const approval of approvals.values()) approval.abort()
      if (this.turn === turn) {
        this.turn = undefined
        if (handingOff && turn.steer && ownsTurn() && connection.session === session && connection.hasContext) {
          if (settledOutcome) this.host.push({ ch: 'turn-settled', payload: { sessionId: connection.sessionId, outcome: settledOutcome } })
          const { item, prompt } = turn.steer
          this.startTurn({ connection, session, native, owner, userText: item.text, media: item.images, steer: prompt,
            stopped: turn.stopped, delegation: turn.delegation })
          return
        }
        turn.delegation.abort()
        this.host.releaseComputerControl()
        if (ownsTurn()) {
          if (connection.session === session) this.bind(connection, session)
          this.host.setAgentRunning(false)
          this.host.markStreaming(false)
          this.host.settleExecutionAdmission()
          if (settledOutcome) this.host.push({ ch: 'turn-settled', payload: { sessionId: connection.sessionId, outcome: settledOutcome } })
          if (autoCompactNeeded) {
            const triggerUsed = autoCompactNeeded.used
            void this.compact('threshold').then((compacted) => {
              if (!compacted.ok) this.compactHold = { sessionId: connection.sessionId, untilTokens: triggerUsed * 1.2 }
              if (nextQueued && !compacted.aborted && ownsTurn()) {
                const queued = nextQueued
                void this.host.withOperation('send', owner.generation, () => this.host.withExecutionAdmission(() => this.send(queued.text, queued.images)))
                  .then((res) => {
                    if (!res.ok && res.error) {
                      this.host.push({ ch: 'notify', payload: { id: `acp-queue-fail-${Date.now()}`, method: 'notify', notifyType: 'error', message: res.error } })
                    }
                  })
              }
            })
            return
          }
          void this.host.refreshState()
          void this.host.refreshStats()
          if (nextQueued) {
            const queued = nextQueued
            void this.host.withOperation('send', owner.generation, () => this.host.withExecutionAdmission(() => this.send(queued.text, queued.images)))
              .then((res) => {
                if (!res.ok && res.error) {
                  this.host.push({ ch: 'notify', payload: { id: `acp-queue-fail-${Date.now()}`, method: 'notify', notifyType: 'error', message: res.error } })
                }
              })
          } else if (authBlipRetry && !turn.stopped) {
            void this.continueAfterAuthBlip(connection, owner)
          } else if (connection.mcpStale && connection.session === session) {
            this.scheduleMcpRefresh(0)
          }
        }
      }
    })
    void turn.done.catch((error) => console.error('[antigravity]', error instanceof Error ? error.message : String(error)))
  }

  async setMode(mode: string): Promise<{ ok: boolean; error?: string }> {
    const connection = this.connection
    if (!connection || !isAntigravityMode(mode)) return { ok: false, error: pick('这不是可用的 Antigravity 权限档。', 'This is not an available Antigravity permission mode.') }
    return this.host.enqueueCapabilityChange(() => this.host.withOperation('reload', undefined, () => {
      if (connection !== this.connection) return Promise.resolve({ ok: false, error: GENERATION_MISMATCH_ERROR })
      return this.updateConfig('mode', mode)
    }))
  }

  async updateConfig(kind: 'thinking' | 'mode', value: string): Promise<{ ok: boolean; error?: string }> {
    const previous = this.connection
    if (!previous || this.host.executionActive() || this.host.state?.pendingMessageCount) return { ok: false, error: pick('请等 Antigravity 当前回合结束。', 'Wait for the current Antigravity turn to finish.') }
    const choice = kind === 'mode' ? previous.modes : previous.thinking
    if (!choice?.options.some(({ id }) => id === value)) return { ok: false, error: pick('当前会话不支持该档位。', 'This level is unavailable in the current session.') }
    if (!previous.session) return this.select(previous.model.id, kind === 'thinking' ? value : previous.thinking?.current, kind === 'mode' ? value : undefined)
    const owner = this.host.asyncOwner()
    const session = previous.session
    try {
      const models = await (kind === 'thinking' ? session.selectThinking(value) : session.selectMode(value))
      if (!this.host.ownerCurrent(owner) || this.connection !== previous || models.current !== previous.model.id) throw new Error(GENERATION_MISMATCH_ERROR)
      const nextPref = { ...previous, thinking: models.thinking, modes: models.modes }
      await this.persistPreference(nextPref)
      if (!this.host.ownerCurrent(owner) || this.connection !== previous) throw new Error(GENERATION_MISMATCH_ERROR)
      previous.thinking = models.thinking
      previous.model = this.modelInfo(previous.model, models.thinking, previous.supportsImages)
      previous.mode = models.mode
      previous.modes = models.modes
      await this.host.refreshState()
      await this.host.refreshStats()
      return { ok: true }
    } catch (error) {
      if (this.connection === previous && previous.session === session) {
        previous.session = undefined
        previous.bridgeConfigured = undefined
        previous.mode = undefined
        previous.hasContext = false
        await session.close()
        void this.host.refreshState()
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  stats(): SessionStats {
    const modelKey = modelKeyOf(this.connection?.model)
    const latest = this.turn?.messages.at(-1) ?? this.host.messages.findLast((message) => message.role === 'assistant')
    const compactedAt = this.host.compactionState.last?.status === 'completed'
      ? (this.host.compactionState.last.endedAt ?? this.host.compactionState.last.startedAt)
      : this.host.contextFrom?.compactedAt
    const liveContext = this.connection?.session?.context
    const latestStale = compactedAt !== undefined && (latest?.timestamp ?? 0) <= compactedAt
    const context = liveContext ?? (latest?.model === modelKey ? latest?.antigravity?.context : undefined)
    const messages = this.turn ? [...this.host.messages, ...this.turn.messages] : this.host.messages
    return {
      toolCalls: messages.reduce((n, message) => n + (message.toolCalls?.length ?? 0), 0),
      userMessages: messages.filter((message) => message.role === 'user').length,
      assistantMessages: messages.filter((message) => message.role === 'assistant').length,
      ...(context ? { contextUsage: { modelKey, tokens: !liveContext && latestStale ? null : context.used, contextWindow: context.size,
        percent: !liveContext && latestStale ? null : context.used / context.size * 100, availability: 'known' } } : {})
    }
  }
}
