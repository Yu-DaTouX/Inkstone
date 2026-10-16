/**
 * 运行注册表（v3 WP-10）。
 *
 * 全应用唯一的运行状态来源。它**旁路订阅**同一条 pi 事件管道，不改消息投影、
 * 不改 pi 循环、不做任何执行控制 —— 只把事实归约成 `RunSnapshot` 并发布。
 *
 * ── 谁调用它 ──
 *   · 主进程在收到 pi 事件 / 扩展 UI 请求 / 进程退出时调用 `observePi`、`observe`；
 *   · 定时任务、评审、子 Agent 用 `open()` 登记外部运行；
 *   · `tick()` 由 `StallMonitor` 每秒调用，只标记停滞；
 *   · `subscribe()` 给推送层（250ms 合并）用。
 *
 * ── 身份与防旧事件 ──
 *   · 每轮一个 `runId`；会话级 `code` 来自注入的 `SessionCodeStore`。
 *   · 终态（done/stopped/failed）后的事件一律丢弃，除非是显式的新一轮开启信号。
 *   · 显式 `runId` 的事件只更新那一个运行；`generation` 更旧的运行实例事件被丢弃
 *     （会话被换过 pi 进程时，旧进程的迟到事件不能覆盖新实例）。
 *   · 会话编号无法分配时不登记运行，经 `onError` 如实报告，绝不发布假编号。
 */
import {
  compareRuns,
  createRunState,
  detectStall,
  formatChildCode,
  isImmediatePhase,
  isTerminalPhase,
  normalizeThresholds,
  reduceRun,
  snapshotOf,
  DEFAULT_STALL_THRESHOLDS,
  type RunKind,
  type RunModel,
  type RunPhase,
  type RunSignal,
  type RunSnapshot,
  type RunState,
  type StallCause,
  type StallThresholds
} from '../../shared/runs'
import { DurableRunHistory, type RunHistoryRecord, type RunHistorySegment, type RunHistoryWriter } from './history'
import { runSignalFromDangerConfirmation, runSignalFromPiExit, runSignalFromUiRequest, runSignalFromUiResolved, signalsFromPiEvent } from './pi-events'
import type { SessionCodeStore } from './session-codes'

/** 运行的上游身份；除 sessionId 外都是可选事实。 */
export interface RunContext {
  sessionId: string
  sessionPath?: string
  projectId?: string
  title?: string
  model?: RunModel
  kind?: RunKind
  /** 由上层解析好的显示编号（优先级最高） */
  code?: string
  /** 显式运行实例；缺省由注册表按会话分配 */
  runId?: string
  parentRunId?: string
  /** 子 Agent 的父会话；父运行已结束时仍可用它的会话编号定位 `S{n}·{k}` */
  parentSessionId?: string
  /** 编号作用域（定时任务用任务 id）；缺省用 sessionId */
  scopeId?: string
  /** 运行实例代次（来自 runner envelope）；用于丢弃旧实例的迟到事件 */
  generation?: number
}

/** 一次变更：upsert 快照，或显式移除（当前不使用，保留给归档）。 */
export interface RunChange {
  runs: RunSnapshot[]
  /** true = 状态类变化（等你确认 / 失败 / 完成 / 停止），推送层应立即发 */
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
  thresholds?: () => Partial<StallThresholds>
  /** 「长时间任务」命令前缀，命中则豁免工具无输出停滞判定 */
  exemptTools?: () => string[]
  onChange?: (change: RunChange) => void
  onError?: (error: RunError) => void
}

interface RunEntry {
  state: RunState
  generation?: number
  /** 当前阶段段的起点 */
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
  /** sessionId → 当前非终态运行 */
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

  private thresholds(): StallThresholds {
    return normalizeThresholds(this.options.thresholds?.() ?? DEFAULT_STALL_THRESHOLDS)
  }

  private resolveCode(ctx: RunContext): string | undefined {
    if (ctx.code) return ctx.code
    if (ctx.kind === 'subagent') {
      /*
       * 子 Agent 的归属稳定在**父会话**上：父运行实例只用于取当前会话编号，
       * 计数作用域落在父会话，父实例结束后新起的子运行接着 ·{k}，不回落到 ·1。
       */
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

  /** 显式登记外部运行（定时任务 / 评审 / 子 Agent / 启动时补登记）。 */
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
    /* 换运行实例：把同一会话上还挂着的旧运行按宿主回收处理，避免两个「运行中」。 */
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

  /** 直接投递一条规范化信号（宿主事件、队列更新、危险确认等）。 */
  observe(ctx: RunContext, signal: RunSignal): RunSnapshot | null {
    if (this.disposed) return null
    const now = this.now()
    let entry: RunEntry | undefined

    if (ctx.runId) {
      entry = this.runs.get(ctx.runId)
      if (!entry) return null
      /* 终态是终点：旧事件不得把它翻回去。 */
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

  /** pi 原始事件 → 信号 → 归约。返回本轮实际变化的快照。 */
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

  /** 流式循环防护：宿主在 `abort()` **之前**调用，随后的 aborted 才不会被当成用户停止。 */
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

  /** 停滞监测：只把「无输出」的 run 标记成 stalled，返回本次新标记的 runId。 */
  tick(now: number = this.now()): string[] {
    if (this.disposed) return []
    const thresholds = this.thresholds()
    const exemptTools = this.options.exemptTools?.() ?? []
    const stalled: string[] = []
    for (const entry of this.runs.values()) {
      if (isTerminalPhase(entry.state.phase)) continue
      const cause = detectStall(entry.state, now, thresholds, { exemptTools })
      if (!cause) continue
      if (this.applyStall(entry.state.runId, cause, now)) stalled.push(entry.state.runId)
    }
    return stalled
  }

  applyStall(runId: string, cause: StallCause, now: number = this.now()): RunSnapshot | null {
    const entry = this.runs.get(runId)
    if (!entry || isTerminalPhase(entry.state.phase)) return null
    return this.apply(entry, { type: 'stall-detected', cause }, now)
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

  size(): number {
    return this.runs.size
  }

  subscribe(listener: (change: RunChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 等待运行历史写盘结束（进程退出 / 测试收尾）。 */
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
    /* 更旧的运行实例事件丢弃；更新的代次视为同一实例的继续。 */
    return ctx.generation >= entry.generation
  }

  /** 会话标题 / 模型是可变事实，允许在运行中更新。返回是否有变化（不在此处发布）。 */
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

/** 元数据更新直接改 entry.state，不触发 segment / 终态逻辑。 */
function applySignalToEntry(entry: RunEntry, signal: RunSignal, now: number): void {
  const next = reduceRun(entry.state, signal, now)
  if (next !== entry.state) entry.state = next
}
