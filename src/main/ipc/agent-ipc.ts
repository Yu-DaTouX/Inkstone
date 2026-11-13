import type { IpcRegistrar } from './registrar'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import type { RunnerVisibility } from '../runner-reclaim'
import type { ApprovalBroker } from '../approval-broker'
import type { LineModel } from '../native-compaction-line'
import type { ExpectedRuntimeOwner, MainPush, QueueEditOp, QueueSnapshot, QueueState } from '../../shared/ipc'
import type { RuntimeRef } from '../../shared/runs'
import { pick } from '../../shared/ui-lang'
import { getSettings } from '../settings'
import { userMessageSent } from '../browser/user-handoff'
import { reserveWorkspaceMutation } from '../workspace-mutation'
import { captureCheckpoint } from '../checkpoints'
import { requiredSessionActionAgent, sessionActionChanged } from './session-action-target'
import { abortBashFor, lastAssistantTextFor } from './session-command-target'
import { localCommandDescriptors } from '../command-registry'
import { approvalIdentityFrom } from '../approval-ledger'
import { piInfo, resetPiVersionCache } from '../protocol'

export type ExpectedRuntimeInput = RuntimeRef

export interface PinnedSendTarget {
  runId: string
  generation: number
  sessionId?: string
  agent: AgentController
}

export interface AgentIpcDeps {
  runners(): RunnerRegistry | null
  ac(): AgentController | null
  startAgent(restore?: { sessionFile?: string }): Promise<{ ok: boolean; error?: string }>
  whenAgentStarted(): Promise<void>
  flushRestoreNotice(): void
  piDown(): string
  push(msg: MainPush): void
  isObject(value: unknown): value is Record<string, unknown>
  normalizeExpectedRuntime(input: unknown): ExpectedRuntimeInput | null | 'invalid'
  resolveExpectedTarget(expected: ExpectedRuntimeInput | null): string | null
  targetMatchesExpected(id: string, expected: ExpectedRuntimeInput | null): boolean
  runnerForExpected(expected: ExpectedRuntimeInput): AgentController | null
  pinSendTarget(id: string): PinnedSendTarget | null
  pinnedTargetMatches(pin: PinnedSendTarget): boolean
  warnSharedCwdOnce(runnerId: string, cwd: string, registry: RunnerRegistry): void
  stopRunner(agent: AgentController | null): Promise<QueueSnapshot>
  applyToAllAgents(apply: (agent: AgentController) => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }>
  syncCompactionLines(models: LineModel[]): Promise<void>
  runnerVisibility: RunnerVisibility
  approvals: ApprovalBroker
  pendingUiReplay(): MainPush[]
  resyncActiveView(reason: unknown): Promise<{ ok: boolean }>
}

export function registerAgentIpc(ipc: IpcRegistrar, deps: AgentIpcDeps): void {
  const { handle } = ipc
  const {
    ac, startAgent, whenAgentStarted, flushRestoreNotice, piDown, push, isObject,
    normalizeExpectedRuntime, resolveExpectedTarget, targetMatchesExpected, runnerForExpected, pinSendTarget, pinnedTargetMatches,
    warnSharedCwdOnce, stopRunner, applyToAllAgents, syncCompactionLines, runnerVisibility, approvals, pendingUiReplay, resyncActiveView
  } = deps

  handle('yan:start', async () => {
    const active = deps.runners()?.active()
    const crashedFile = active && !active.running ? active.getState()?.sessionFile : undefined
    const res = await startAgent(crashedFile ? { sessionFile: crashedFile } : undefined)
    return { ...res, state: ac()?.getState() ?? undefined }
  })

  handle('yan:send', async (text: string, images?: { data: string; mimeType: string }[], mode?: 'steer' | 'followUp', expectedInput?: unknown) => {
    const preparationStartedAt = Date.now()
    let checkpointMs = 0
    let checkpointSaved: boolean | undefined
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { ok: false, error: pick('发送目标身份无效，消息未发送', 'Invalid send target; message not sent') }
    let targetId = expected ? resolveExpectedTarget(expected) ?? undefined : deps.runners()?.activeRunnerId
    if (expected && !targetId) return { ok: false, error: pick('目标会话已不在或已切换，消息未发送；草稿已保留', 'Target session is gone or changed; message not sent, draft kept') }
    let pin = targetId ? pinSendTarget(targetId) : null
    const sendOwnershipChanged = (id: string | null | undefined): boolean =>
      (!!expected && (!id || !targetMatchesExpected(id, expected))) || (!!id && !!pin && !pinnedTargetMatches(pin))
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: pick('目标会话在等待时已变化，消息未发送；草稿已保留', 'Target session changed while waiting; message not sent, draft kept') }
    }
    if (!expected && (!targetId || !deps.runners()?.agentOf(targetId)?.running)) {
      const r = await startAgent()
      if (!r.ok) return r
      targetId = deps.runners()?.activeRunnerId
      pin = targetId ? pinSendTarget(targetId) : null
    }
    if (sendOwnershipChanged(targetId)) {
      return { ok: false, error: pick('目标会话已不在或已切换，消息未发送；草稿已保留', 'Target session is gone or changed; message not sent, draft kept') }
    }
    const id = targetId
    if (id) {
      const guard = deps.runners()?.guardExecute(id)
      if (guard && !guard.ok) return guard
    }
    const registry = deps.runners()
    const agent = id ? registry?.agentOf(id) : null
    if (!id || !registry || !agent) return { ok: false, error: piDown() }
    await userMessageSent(agent.getState()?.sessionId)
    let admissionToken: number | undefined
    let handedOff = false
    const idleForTurn = (): boolean => {
      const state = agent.getState()
      return !!state && !state.isAgentRunning && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount && !agent.hasRunningBash()
    }
    if (!mode && text.trim() && idleForTurn()) {
      const admission = registry.admitExecute(id)
      if (!admission.ok) return admission
      admissionToken = admission.token
      warnSharedCwdOnce(id, agent.workingDirectory, registry)
    }
    try {
      if (admissionToken !== undefined && (await getSettings()).checkpointsEnabled !== false) {
        if (sendOwnershipChanged(id) || deps.runners() !== registry) {
          return { ok: false, error: pick('目标会话已不在或已切换，消息未发送；草稿已保留', 'Target session is gone or changed; message not sent, draft kept') }
        }
        const state = agent.getState()
        if (state && idleForTurn()) {
          const release = reserveWorkspaceMutation(agent.workingDirectory)
          if (!release) return { ok: false, error: pick('项目正在保存或回退代码，请稍后发送；草稿已保留', 'Project is saving or reverting code; try again shortly, draft kept') }
          const checkpointStartedAt = Date.now()
          try {
            checkpointSaved = !!(await captureCheckpoint(agent.workingDirectory, state.conversationId ?? state.sessionId, text))
          } finally {
            checkpointMs = Math.max(0, Date.now() - checkpointStartedAt)
            release()
          }
        }
      }
      if (sendOwnershipChanged(id) || deps.runners() !== registry) {
        return { ok: false, error: pick('目标会话已不在或已切换，消息未发送；草稿已保留', 'Target session is gone or changed; message not sent, draft kept') }
      }
      console.log(`[发送准备] ${JSON.stringify({ runnerId: id, elapsedMs: Math.max(0, Date.now() - preparationStartedAt), checkpointMs, checkpointSaved })}`)
      const result = await agent.send(text, images, mode, undefined, pin?.generation)
      handedOff = result.ok
      return result
    } finally {
      if (admissionToken !== undefined && !handedOff) registry.releaseExecute(id, admissionToken)
    }
  })

  handle('yan:steer', async (text: string, expectedInput?: unknown) => {
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid' || !expected) return { ok: false, error: pick('插话目标身份无效', 'Invalid steer target') }
    const agent = runnerForExpected(expected)
    if (!agent) return { ok: false, error: pick('目标会话已不在或运行实例已更换，插话未发送', 'Target session is gone or its runtime changed; steer not sent') }
    return agent.steer(text, undefined, expected.generation)
  })
  handle('yan:followUp', async (text: string, expectedInput: unknown) => {
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid' || !expected) return { ok: false, error: pick('追加目标身份无效', 'Invalid follow-up target') }
    const agent = runnerForExpected(expected)
    if (!agent) return { ok: false, error: pick('目标会话已不在或运行实例已更换，追加未发送', 'Target session is gone or its runtime changed; follow-up not sent') }
    return agent.followUp(text)
  })
  const queueAgent = (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)
  const queueMissing = () => ({ ok: false, error: sessionActionChanged() })
  handle('yan:steerQueued', async (queueId: string, expected: ExpectedRuntimeOwner) => queueAgent(expected)?.steerQueued(queueId) ?? queueMissing())
  handle('yan:removeQueued', async (queueId: string, expected: ExpectedRuntimeOwner) => queueAgent(expected)?.removeQueued(queueId) ?? queueMissing())
  handle('yan:queueEdit', async (arg: QueueState | QueueEditOp, expected: ExpectedRuntimeOwner) => {
    const agent = queueAgent(expected)
    if (!agent) return queueMissing()
    return 'op' in arg ? agent.editQueue(arg) : agent.rewriteQueue(arg)
  })
  handle('yan:abort', async (expectedInput?: unknown) => {
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { steering: [], followUp: [], error: pick('停止目标身份无效', 'Invalid stop target') }
    if (!expected) return stopRunner(ac())
    const agent = runnerForExpected(expected)
    if (!agent) return { steering: [], followUp: [], error: pick('目标会话已不在或运行实例已更换，未停止', 'Target session is gone or its runtime changed; not stopped') }
    return (await agent.abort(expected.generation))
  })

  handle('yan:runBash', async (command: string, options?: { excludeFromContext?: boolean }, expectedInput?: unknown) => {
    if (typeof command !== 'string' || !command.trim() || (options !== undefined && (!options || typeof options !== 'object' || (options.excludeFromContext !== undefined && typeof options.excludeFromContext !== 'boolean')))) return { ok: false, error: pick('命令参数无效', 'Invalid command arguments') }
    const expected = normalizeExpectedRuntime(expectedInput)
    if (expected === 'invalid') return { ok: false, error: pick('执行目标身份无效', 'Invalid run target') }
    const id = expected ? resolveExpectedTarget(expected) ?? undefined : deps.runners()?.activeRunner()?.id
    if (expected && !id) return { ok: false, error: pick('目标会话已不在或已切换，命令未执行', 'Target session is gone or changed; command not run') }
    if (id) {
      const guard = deps.runners()?.guardExecute(id)
      if (guard && !guard.ok) return guard
    }
    return (id ? deps.runners()?.agentOf(id)?.runBash(command, options) : undefined) ?? { ok: false, error: piDown() }
  })
  handle('yan:abortBash', async (expected: ExpectedRuntimeOwner) => abortBashFor({ ac, runners: () => deps.runners() }, expected))

  handle('yan:setVisibleRunnerSessions', (sessions: unknown) => {
    deps.runners()?.noteVisibleActivity()
    return runnerVisibility.update(sessions)
  })

  handle('yan:listModels', async () => {
    const models = (await ac()?.listModels()) ?? []
    void syncCompactionLines(models)
    return models
  })
  handle(
    'yan:setModel',
    async (provider: string, modelId: string, expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.setModel(provider, modelId) ?? { ok: false, error: sessionActionChanged() }
  )
  handle('yan:setThinking', async (level: string, expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.setThinking(level) ?? { ok: false, error: sessionActionChanged() })
  handle('yan:listThinkingLevels', async () => ac()?.listThinkingLevels() ?? [])
  handle('yan:setUltracode', async (on: boolean, expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.setUltracode(!!on) ?? { ok: false, error: sessionActionChanged() })
  handle('yan:listCommands', async () => ac()?.listCommands() ?? localCommandDescriptors())

  handle(
    'yan:setAutoCompaction',
    async (enabled: boolean) => applyToAllAgents((agent) => agent.setAutoCompaction(enabled))
  )
  handle(
    'yan:setAutoRetry',
    async (enabled: boolean) => applyToAllAgents((agent) => agent.setAutoRetry(enabled))
  )
  handle(
    'yan:setSteeringMode',
    async (mode: string) => applyToAllAgents((agent) => agent.setSteeringMode(mode))
  )
  handle(
    'yan:setFollowUpMode',
    async (mode: string) => applyToAllAgents((agent) => agent.setFollowUpMode(mode))
  )
  handle(
    'yan:abortRetry',
    async (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.abortRetry() ?? { ok: false, error: sessionActionChanged() }
  )
  handle(
    'yan:cycleModel',
    async (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.cycleModel() ?? { ok: false, error: sessionActionChanged() }
  )
  handle(
    'yan:cycleModelBack',
    async (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.cycleModelBack() ?? { ok: false, error: sessionActionChanged() }
  )
  handle(
    'yan:cycleThinking',
    async (expected: ExpectedRuntimeOwner) => requiredSessionActionAgent({ ac, runners: () => deps.runners() }, expected)?.cycleThinking() ?? { ok: false, error: sessionActionChanged() }
  )
  handle('yan:lastAssistantText', async (expected?: ExpectedRuntimeOwner) => lastAssistantTextFor({ ac, runners: () => deps.runners() }, expected))

  handle('yan:approvalAnswer', async (id: string, choice: unknown, identity?: unknown, feedback?: unknown) => ({ ok: approvals.answer(String(id ?? ''), choice, approvalIdentityFrom(identity), feedback) }))
  handle('yan:approvalHold', async (id: string, identity?: unknown) => ({ ok: approvals.hold(String(id ?? ''), approvalIdentityFrom(identity)) }))
  handle('yan:approvalPending', async () => approvals.list())
  handle('yan:pendingUiRequests', async () => pendingUiReplay())
  handle('yan:resyncView', async (reason?: unknown) => resyncActiveView(reason))

  handle('yan:piInfo', async () => {
    const s = await getSettings()
    return piInfo(s.piBin)
  })

  handle('yan:redetectPi', async () => {
    const s = await getSettings()
    resetPiVersionCache()
    const info = await piInfo(s.piBin, { fresh: true })
    push({ ch: 'pi-info', payload: info })
    if (info.version && !ac()?.running) {
      await startAgent()
    }
    return info
  })

  handle('yan:getState', async () => {
    await whenAgentStarted()
    flushRestoreNotice()
    return ac()?.getState() ?? null
  })

  handle('yan:agentStatus', async () =>
    ac()?.getConn() ?? { state: 'starting' as const, detail: '' }
  )
  handle('yan:getMessages', async () => {
    await whenAgentStarted()
    return ac()?.getMessages() ?? []
  })
  handle('yan:getStats', async () => {
    await whenAgentStarted()
    return ac()?.refreshStats() ?? null
  })

  handle('yan:respondUi', async (res: unknown) => {
    if (!isObject(res) || typeof res.id !== 'string' || !res.id) {
      return { ok: false, code: 'invalid' as const, error: pick('无效的答复', 'Invalid answer') }
    }
    const runners = deps.runners()
    const result = await (runners ? runners.respondUiResult(res as never) : ac()?.respondUiResult(res as never))
    if (!result) {
      return { ok: false, code: 'not_pending' as const, error: pick('这个问题已经结束或不属于当前会话，答案没有送达', 'This question already ended or belongs to another session; the answer was not delivered') }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: result.code === 'pi_down'
          ? piDown()
          : pick('这个问题已经结束，答案没有送达', 'This question already ended; the answer was not delivered')
      }
    }
    return { ok: true }
  })

  handle('yan:extendUi', async (id: string, extraMs?: number) =>
    deps.runners()?.extendHostUi(String(id ?? ''), extraMs) ?? { ok: false, error: piDown() }
  )

  handle('yan:startUiTimer', async (id: string) =>
    deps.runners()?.startHostUiTimer(String(id ?? '')) ?? { ok: false, error: piDown() }
  )
}
