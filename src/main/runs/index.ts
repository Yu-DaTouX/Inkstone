/**
 * 运行注册表装配入口（v3 WP-10）。
 *
 * 把「纯 reducer（shared/runs.ts） + 注册表 + 编号 + 历史 + 250ms 合并推送 +
 * 停滞监测」拼成一套可直接被主进程旁路接入的东西：
 *
 * ```ts
 * const pipeline = await createRunPipeline({
 *   root: YAN_DIR,
 *   publish: (payload) => pushFrom({ ch: 'runs', payload }),
 *   onError: (error) => console.warn('[runs]', error.code, error.message)
 * })
 * // pi 事件（只读旁路，不改 pi 循环）：
 * pipeline.registry.observePi(ctx, evt)
 * // 扩展 UI 请求 / 答复：
 * pipeline.registry.observeUiRequest(ctx, req); pipeline.registry.observeUiResolved(ctx, id)
 * // 流式循环防护：abort 之前标记
 * pipeline.registry.markLoopAbort(ctx, '重复输出')
 * // 进程退出：
 * pipeline.registry.observePiExit(ctx, code, signal)
 * ```
 *
 * 返回值里的 `publisher` / `monitor` 可注入定时器，测试不碰真实计时。
 */
import { DurableRunHistory, type RunHistoryWriter } from './history'
import { RunPublisher, type RunUpdatePayload } from './publisher'
import { RunRegistry, type RunContext, type RunError, type RunRegistryOptions } from './registry'
import { SessionCodeStore } from './session-codes'
import { StallMonitor } from './stall-monitor'
import type { StallThresholds } from '../../shared/runs'

export interface RunPipelineOptions {
  root?: string
  codes?: SessionCodeStore
  history?: RunHistoryWriter
  /** 接收合并后的增量；通常接 `MainPush` 的 `runs` 通道 */
  publish?: (payload: RunUpdatePayload) => void
  onError?: (error: RunError) => void
  now?: () => number
  newRunId?: () => string
  thresholds?: () => Partial<StallThresholds>
  exemptTools?: () => string[]
  /** 普通变化合并窗口，默认 250ms */
  batchMs?: number
  /** 停滞检查间隔，默认 1000ms */
  stallIntervalMs?: number
  /** false = 不自动启动停滞监测（由上层控制） */
  autoStartMonitor?: boolean
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface RunPipeline {
  registry: RunRegistry
  codes: SessionCodeStore
  history: RunHistoryWriter
  publisher: RunPublisher | null
  monitor: StallMonitor | null
  dispose(): Promise<void>
}

export async function createRunPipeline(options: RunPipelineOptions = {}): Promise<RunPipeline> {
  const root = options.root
  const codes = options.codes ?? new SessionCodeStore(root ? { root } : {})
  await codes.load()
  const history = options.history ?? (root ? new DurableRunHistory(root) : new DurableRunHistory())

  const publisher = options.publish
    ? new RunPublisher({
        emit: options.publish,
        ...(options.batchMs !== undefined ? { intervalMs: options.batchMs } : {}),
        ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
        ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {})
      })
    : null

  const registryOptions: RunRegistryOptions = {
    codes,
    history,
    ...(options.now ? { now: options.now } : {}),
    ...(options.newRunId ? { newRunId: options.newRunId } : {}),
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
    ...(options.exemptTools ? { exemptTools: options.exemptTools } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    onChange: (change) => publisher?.pushChange(change)
  }
  const registry = new RunRegistry(registryOptions)

  const monitor =
    options.autoStartMonitor === false
      ? null
      : new StallMonitor({
          tick: (now) => registry.tick(now),
          ...(options.stallIntervalMs !== undefined ? { intervalMs: options.stallIntervalMs } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.setInterval ? { setInterval: options.setInterval } : {}),
          ...(options.clearInterval ? { clearInterval: options.clearInterval } : {})
        })
  monitor?.start()

  return {
    registry,
    codes,
    history,
    publisher,
    monitor,
    async dispose() {
      monitor?.stop()
      publisher?.dispose()
      registry.dispose()
      await codes.whenIdle()
      await registry.whenIdle()
    }
  }
}

/** 从 runner 身份封套构造运行上下文；**不**把 runner 的 runId 当作每轮运行 ID。 */
export function runContextFromEnvelope(
  envelope: { sessionId: string; projectId?: string; generation?: number },
  extra: Partial<Omit<RunContext, 'sessionId'>> = {}
): RunContext {
  return {
    sessionId: envelope.sessionId,
    ...(envelope.projectId ? { projectId: envelope.projectId } : {}),
    ...(envelope.generation !== undefined ? { generation: envelope.generation } : {}),
    ...extra
  }
}

export { RunRegistry } from './registry'
export type { RunChange, RunContext, RunError, RunRegistryOptions } from './registry'
export { RunPublisher } from './publisher'
export type { RunPublisherOptions, RunUpdatePayload } from './publisher'
export { StallMonitor } from './stall-monitor'
export type { StallMonitorOptions } from './stall-monitor'
export { DurableRunHistory, MemoryRunHistory, runHistoryPath } from './history'
export type { RunHistoryRecord, RunHistorySegment, RunHistoryWriter } from './history'
export { SessionCodeStore, formatRunCode, sessionCodesPath } from './session-codes'
export type { CodeKind, SessionCodeEntry } from './session-codes'
export { signalsFromPiEvent, runSignalFromUiRequest, runSignalFromUiResolved, runSignalFromDangerConfirmation, runSignalFromPiExit } from './pi-events'
export { subagentModel, subagentRunContext, subagentScopeId } from './subagent'
export type { SubagentRunIdentity } from './subagent'
