import {
  compareRuns,
  createRunState,
  formatChildCode,
  isImmediatePhase,
  isTerminalPhase,
  reduceRun,
  snapshotOf,
  type RunKind,
  type RunModel,
  type RunPhase,
  type RunSignal,
  type RunSnapshot,
  type RunState
} from '../../shared/runs'
import { DurableRunHistory, type RunHistoryRecord, type RunHistorySegment, type RunHistoryWriter } from './history'
import { runSignalFromDangerConfirmation, runSignalFromPiExit, runSignalFromUiRequest, runSignalFromUiResolved, signalsFromPiEvent } from './pi-events'
import type { SessionCodeStore } from './session-codes'

export interface RunContext {
  sessionId: string
  sessionPath?: string
  projectId?: string
  title?: string
  model?: RunModel
  kind?: RunKind
  code?: string
  runId?: string
  parentRunId?: string
  parentSessionId?: string
  scopeId?: string
  generation?: number
}

export interface RunChange {
  runs: RunSnapshot[]
  immediate: boolean
}

export interface RunError {
  code: 'code-unavailable' | 'history-write-failed' | string
  message: string
  sessionId?: string
  runId?: string
}

export interface RunRegistryOptions {
  now?: () => number
  newRunId?: () => string
  codes?: SessionCodeStore
  history?: RunHistoryWriter
  onChange?: (change: RunChange) => void
  onError?: (error: RunError) => void
}

interface RunEntry {
  state: RunState
  generation?: number
  phaseFrom: number
  segments: RunHistorySegment[]
  historyWritten: boolean
}

let globalRunSeq = 0

function openingPhase(signal: RunSignal, now: number): RunPhase {
  if (signal.type === 'queued') return { kind: 'queued', since: now, reason: signal.reason, ...(signal.at !== undefined ? { at: signal.at } : {}) }
  return { kind: 'running', since: now, activity: 'waiting-model' }
}

function isOpeningSignal(signal: RunSignal): boolean {
  return signal.type === 'agent-start' || signal.type === 'queued'
}

function phaseChanged(before: RunPhase, after: RunPhase): boolean {
  return before.kind !== after.kind
}

export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>()
  private readonly active = new Map<string, string>()
  private readonly childCounts = new Map<string, number>()
  private readonly listeners = new Set<(change: RunChange) => void>()
  private disposed = false

  constructor(private readonly options: RunRegistryOptions = {}) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private nextRunId(): string {
    if (this.options.newRunId) return this.options.newRunId()
    globalRunSeq += 1
    return `run-${Date.now().toString(36)}-${globalRunSeq.toString(36)}`
  }

  private reportError(error: RunError): void {
    this.options.onError?.(error)
  }

  private resolveCode(ctx: RunContext): string | undefined {
    if (ctx.code) return ctx.code
    if (ctx.kind === 'subagent') {
      const parent = ctx.parentRunId ? this.runs.get(ctx.parentRunId) : undefined
      const scope = parent?.state.sessionId ?? ctx.parentSessionId ?? ctx.parentRunId
      if (!scope) return undefined
      const parentCode = parent?.state.code ?? (ctx.parentSessionId ? this.options.codes?.codeFor(ctx.parentSessionId) : undefined)
      if (!parentCode) return undefined
      const n = (this.childCounts.get(scope) ?? 0) + 1
      this.childCounts.set(scope, n)
      return formatChildCode(parentCode, n)
    }
    return this.options.codes?.codeFor(ctx.scopeId ?? ctx.sessionId)
  }

  private createEntry(ctx: RunContext, phase: RunPhase | undefined, now: number): RunEntry | null {
    const code = this.resolveCode(ctx)
    if (!code) {
      this.reportError({
        code: 'code-unavailable',
        message: '会话编号尚未分配，运行不会登记（请先调用 SessionCodeStore.assign）',
        sessionId: ctx.sessionId
      })
      return null
    }
    const runId = ctx.runId ?? this.nextRunId()
    const state = createRunState(
      {
        runId,
        code,
        kind: ctx.kind ?? 'session',
        sessionId: ctx.sessionId,
        ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
        ...(ctx.title ? { title: ctx.title } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(phase ? { phase } : {})
      },
      now
    )
    const entry: RunEntry = { state, ...(ctx.generation !== undefined ? { generation: ctx.generation } : {}), phaseFrom: now, segments: [], historyWritten: false }
    this.runs.set(runId, entry)
    if (!isTerminalPhase(state.phase)) this.active.set(ctx.sessionId, runId)
    return entry
  }

  private ensureEntry(ctx: RunContext, phase: RunPhase | undefined, now: number): RunEntry | null {
    if (ctx.runId) {
      const explicit = this.runs.get(ctx.runId)
      if (explicit) return explicit
    }
    const activeId = this.active.get(ctx.sessionId)
    if (activeId) {
      const active = this.runs.get(activeId)
      if (active && !isTerminalPhase(active.state.phase)) return active
      this.active.delete(ctx.sessionId)
    }
    return this.createEntry(ctx, phase, now)
  }

  open(ctx: RunContext, phase?: RunPhase): RunSnapshot | null {
    if (this.disposed) return null
    const now = this.now()
    const runId = ctx.runId ?? this.nextRunId()
    const sameRun = ctx.runId ? this.runs.get(ctx.runId) : undefined
    if (sameRun && !isTerminalPhase(sameRun.state.phase)) {
      const metaChanged = this.applyMeta(sameRun, ctx, now)
      if (phase) {
        this.setPhase(sameRun, phase, now)
        return snapshotOf(sameRun.state)
      }
      if (metaChanged) {
        const snapshot = snapshotOf(sameRun.state)
        this.emit([snapshot], isImmediatePhase(sameRun.state.phase))
        return snapshot
      }
      return snapshotOf(sameRun.state)
    }
    const activeId = this.active.get(ctx.sessionId)
    if (activeId && activeId !== runId) {
      const active = this.runs.get(activeId)
      if (active && !isTerminalPhase(active.state.phase)) this.apply(active, { type: 'stopped', by: 'host' }, now)
    }
    const entry = this.createEntry({ ...ctx, runId }, phase, now)
    if (!entry) return null
    const snapshot = snapshotOf(entry.state)
    this.emit([snapshot], isImmediatePhase(entry.state.phase))
    return snapshot
  }

  observe(ctx: RunContext, signal: RunSignal): RunSnapshot | null {
    if (this.disposed) return null
    const now = this.now()
    let entry: RunEntry | undefined

    if (ctx.runId) {
      entry = this.runs.get(ctx.runId)
      if (!entry) return null
      if (isTerminalPhase(entry.state.phase)) return null
      if (!this.generationAcceptable(entry, ctx)) return null
    } else {
      const activeId = this.active.get(ctx.sessionId)
      const active = activeId ? this.runs.get(activeId) : undefined
      if (active && isTerminalPhase(active.state.phase)) {
        this.active.delete(ctx.sessionId)
        entry = undefined
      } else {
        entry = active
      }
      if (entry && !this.generationAcceptable(entry, ctx)) return null
      if (!entry) {
        if (!isOpeningSignal(signal)) return null
        entry = this.ensureEntry(ctx, openingPhase(signal, now), now) ?? undefined
        if (!entry) return null
      }
    }

    if (ctx.generation !== undefined && entry.generation === undefined) entry.generation = ctx.generation
    const metaChanged = this.applyMeta(entry, ctx, now)
    const changed = this.apply(entry, signal, now)
    if (changed) return changed
    if (metaChanged) {
      const snapshot = snapshotOf(entry.state)
      this.emit([snapshot], isImmediatePhase(entry.state.phase))
      return snapshot
    }
    return null
  }

  observePi(ctx: RunContext, evt: Record<string, unknown>): RunSnapshot[] {
    const out: RunSnapshot[] = []
    for (const signal of signalsFromPiEvent(evt, this.now())) {
      const snapshot = this.observe(ctx, signal)
      if (snapshot) out.push(snapshot)
    }
    return out
  }

  observeUiRequest(ctx: RunContext, req: Record<string, unknown>): RunSnapshot | null {
    const signal = runSignalFromUiRequest(req)
    return signal ? this.observe(ctx, signal) : null
  }

  observeUiResolved(ctx: RunContext, id: string): RunSnapshot | null {
    return this.observe(ctx, runSignalFromUiResolved(id))
  }

  observeDangerConfirmation(ctx: RunContext, request: { id: string; summary?: string }): RunSnapshot | null {
    return this.observe(ctx, runSignalFromDangerConfirmation(request))
  }

  observePiExit(ctx: RunContext, code?: number | null, signal?: string | null): RunSnapshot | null {
    return this.observe(ctx, runSignalFromPiExit(code, signal))
  }

  markLoopAbort(ctx: RunContext, detail?: string): RunSnapshot | null {
    return this.observe(ctx, { type: 'loop-abort', ...(detail ? { detail } : {}) })
  }

  stop(ctx: RunContext, by: 'user' | 'host' = 'user'): RunSnapshot | null {
    return this.observe(ctx, { type: 'stopped', by })
  }

  markSeen(runId: string): RunSnapshot | null {
    const entry = this.runs.get(runId)
    if (!entry) return null
    return this.apply(entry, { type: 'seen' }, this.now())
  }

  runningStates(): RunState[] {
    return [...this.runs.values()]
      .map((entry) => entry.state)
      .filter((state) => !isTerminalPhase(state.phase))
  }

  list(): RunSnapshot[] {
    return [...this.runs.values()].map((entry) => snapshotOf(entry.state)).sort(compareRuns)
  }

  get(runId: string): RunSnapshot | undefined {
    const entry = this.runs.get(runId)
    return entry ? snapshotOf(entry.state) : undefined
  }

  activeRunIdFor(sessionId: string): string | undefined {
    const id = this.active.get(sessionId)
    if (!id) return undefined
    const entry = this.runs.get(id)
    return entry && !isTerminalPhase(entry.state.phase) ? id : undefined
  }

  size(): number {
    return this.runs.size
  }

  subscribe(listener: (change: RunChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async whenIdle(): Promise<void> {
    const history = this.options.history
    if (history instanceof DurableRunHistory) await history.whenIdle()
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private generationAcceptable(entry: RunEntry, ctx: RunContext): boolean {
    if (ctx.generation === undefined || entry.generation === undefined) return true
    return ctx.generation >= entry.generation
  }

  private applyMeta(entry: RunEntry, ctx: RunContext, now: number): boolean {
    let changed = false
    if (ctx.title && ctx.title !== entry.state.title) {
      applySignalToEntry(entry, { type: 'title', title: ctx.title }, now)
      changed = true
    }
    if (ctx.model && JSON.stringify(ctx.model) !== JSON.stringify(entry.state.model)) {
      applySignalToEntry(entry, { type: 'model', model: ctx.model }, now)
      changed = true
    }
    return changed
  }

  private setPhase(entry: RunEntry, phase: RunPhase, now: number): void {
    if (phaseChanged(entry.state.phase, phase)) {
      entry.segments.push({ phase: entry.state.phase.kind, from: entry.phaseFrom, to: now })
      entry.phaseFrom = now
    }
    entry.state = { ...entry.state, phase, revision: entry.state.revision + 1 }
    this.emit([snapshotOf(entry.state)], isImmediatePhase(phase))
  }

  private apply(entry: RunEntry, signal: RunSignal, now: number): RunSnapshot | null {
    const before = entry.state
    const next = reduceRun(before, signal, now)
    if (next === before) return null
    if (phaseChanged(before.phase, next.phase)) {
      entry.segments.push({ phase: before.phase.kind, from: entry.phaseFrom, to: now })
      entry.phaseFrom = now
    }
    entry.state = next
    const immediate = isImmediatePhase(next.phase)
    const becameTerminal = isTerminalPhase(next.phase) && !isTerminalPhase(before.phase)
    if (becameTerminal) this.finish(entry, now)
    this.emit([snapshotOf(next)], immediate)
    return snapshotOf(next)
  }

  private finish(entry: RunEntry, now: number): void {
    if (entry.historyWritten) return
    entry.historyWritten = true
    this.active.delete(entry.state.sessionId)
    const phase = entry.state.phase
    const terminal = phase.kind === 'failed' || phase.kind === 'stopped' || phase.kind === 'done' ? phase.kind : 'done'
    const record: RunHistoryRecord = {
      runId: entry.state.runId,
      code: entry.state.code,
      kind: entry.state.kind,
      sessionId: entry.state.sessionId,
      ...(entry.state.sessionPath ? { sessionPath: entry.state.sessionPath } : {}),
      ...(entry.state.projectId ? { projectId: entry.state.projectId } : {}),
      ...(entry.state.parentRunId ? { parentRunId: entry.state.parentRunId } : {}),
      title: entry.state.title,
      ...(entry.state.model ? { model: entry.state.model } : {}),
      startedAt: entry.state.startedAt,
      endedAt: now,
      terminal,
      ...(phase.kind === 'failed' ? { cause: phase.cause, ...(phase.errorKind ? { errorKind: phase.errorKind } : {}), message: phase.message } : {}),
      ...(phase.kind === 'stopped' ? { cause: phase.by } : {}),
      segments: [...entry.segments],
      ...(entry.state.costUsd !== undefined ? { costUsd: entry.state.costUsd } : {}),
      counts: entry.state.counts
    }
    const writer = this.options.history
    if (!writer) return
    void writer.append(record).catch((error: unknown) => {
      this.reportError({
        code: 'history-write-failed',
        message: `运行历史写入失败：${error instanceof Error ? error.message : String(error)}`,
        runId: record.runId,
        sessionId: record.sessionId
      })
    })
  }

  private emit(snapshots: RunSnapshot[], immediate: boolean): void {
    if (snapshots.length === 0) return
    const change: RunChange = { runs: snapshots, immediate }
    this.options.onChange?.(change)
    for (const listener of [...this.listeners]) listener(change)
  }
}

function applySignalToEntry(entry: RunEntry, signal: RunSignal, now: number): void {
  const next = reduceRun(entry.state, signal, now)
  if (next !== entry.state) entry.state = next
}
