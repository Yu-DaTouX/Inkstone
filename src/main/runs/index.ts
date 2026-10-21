import { DurableRunHistory, type RunHistoryWriter } from './history'
import { RunPublisher, type RunUpdatePayload } from './publisher'
import { RunRegistry, type RunError, type RunRegistryOptions } from './registry'
import { SessionCodeStore } from './session-codes'

export interface RunPipelineOptions {
  root?: string
  codes?: SessionCodeStore
  history?: RunHistoryWriter
  publish?: (payload: RunUpdatePayload) => void
  onError?: (error: RunError) => void
  now?: () => number
  newRunId?: () => string
  batchMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface RunPipeline {
  registry: RunRegistry
  codes: SessionCodeStore
  history: RunHistoryWriter
  publisher: RunPublisher | null
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
    ...(options.onError ? { onError: options.onError } : {}),
    onChange: (change) => publisher?.pushChange(change)
  }
  const registry = new RunRegistry(registryOptions)

  return {
    registry,
    codes,
    history,
    publisher,
    async dispose() {
      publisher?.dispose()
      registry.dispose()
      await codes.whenIdle()
      await registry.whenIdle()
    }
  }
}

export { RunRegistry } from './registry'
export type { RunChange, RunContext, RunError, RunRegistryOptions } from './registry'
export { RunPublisher } from './publisher'
export type { RunPublisherOptions, RunUpdatePayload } from './publisher'
export { DurableRunHistory, MemoryRunHistory, runHistoryPath } from './history'
export type { RunHistoryRecord, RunHistorySegment, RunHistoryWriter } from './history'
export { SessionCodeStore, formatRunCode, sessionCodesPath } from './session-codes'
export type { CodeKind, SessionCodeEntry } from './session-codes'
export { signalsFromPiEvent, runSignalFromUiRequest, runSignalFromUiResolved, runSignalFromDangerConfirmation, runSignalFromPiExit } from './pi-events'
export { subagentModel, subagentRunContext, subagentScopeId } from './subagent'
export type { SubagentRunIdentity } from './subagent'
