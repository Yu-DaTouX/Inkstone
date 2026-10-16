import type { UIMessage } from '../shared/ipc'
import { YAN_DIR } from './paths'
import { toolWaitSpans } from '../shared/turns'
import { appendTurnTiming, timingKey, TURN_TIMING_VERSION } from './turn-timing-store'
import type { ResponseDetail, TurnTerminalReason } from '../shared/ipc'

export class TurnTimingTracker {
  startedAt?: number
  startedMono?: number
  messageIds: string[] = []
  terminal: TurnTerminalReason = 'completed'
  elapsedMs?: number
  outputTokens?: number
  persisted = false
  writeTail: Promise<void> = Promise.resolve()
  runSeq = 0
  runId?: string
  responseDetail: ResponseDetail = 'unknown'

  async persist(final: boolean, sessionFile: string | undefined, messages: UIMessage[]): Promise<void> {
    const bucket = timingKey(sessionFile)
    const elapsedMs = this.elapsedMs
    const sourceIds = [...this.messageIds]
    const terminalReason = this.terminal
    if (final) {
      this.messageIds = []
      this.elapsedMs = undefined
      this.outputTokens = undefined
      this.terminal = 'completed'
    }
    if (!bucket || elapsedMs === undefined || sourceIds.length === 0) return
    if (!final && this.persisted) return
    const anchorId = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && /^m\d+$/.test(m.id))?.id
    const logicalTurnId = anchorId ?? sourceIds[0]
    const waitSpans = toolWaitSpans(
      messages
        .filter((m) => sourceIds.includes(m.id))
        .flatMap((m) => m.toolCalls ?? [])
    )
    const sourceSet = new Set(sourceIds)
    const generationTimings = messages
      .filter((m) => sourceSet.has(m.id))
      .map((m) => m.generationTiming ?? null)
    const runIdAtWrite = this.runId
    const endedAt = Date.now()
    const record = {
      v: TURN_TIMING_VERSION,
      logicalTurnId,
      ...(this.runId ? { runId: this.runId } : {}),
      startedAt: endedAt - elapsedMs,
      endedAt,
      elapsedMs,
      terminalReason,
      final,
      ...(anchorId ? { anchorId } : {}),
      sourceIds,
      ...(waitSpans.length ? { waitSpans } : {}),
      ...(generationTimings.some(Boolean) ? { generationTimings } : {}),
      ...(this.outputTokens ? { outputTokens: this.outputTokens } : {}),
      monotonicMs: elapsedMs
    }
    const write = this.writeTail.then(() => appendTurnTiming(YAN_DIR, bucket, record))
    this.writeTail = write.then(
      () => undefined,
      () => undefined
    )
    if (await write && this.runId === runIdAtWrite) this.persisted = true
  }
}
