/**
 * 运行注册表（v3 WP-10）的主进程接线。
 *
 * `main/runs/**` 只提供纯归约 + 注册表 + 编号 + 250ms 合并推送 + 停滞监测；
 * 本文件把它们接到**真实宿主事件**上，并对外给出渲染端要用的两件事：
 *
 *   · `observerFor()` —— AgentController 在既有 pi 事件边界旁路吐出的
 *     `(ctx, signal)` 落到这里；不改消息投影、不改 pi 循环、不做执行控制。
 *   · `snapshot()` / `markSeen()` —— IPC 读接口；增量由 `push` 的 `runs` 通道推。
 *
 * ── 修订号（revision）──
 * 每次真正推送一次增量都 +1，并随 `{revision, upsert, remove}` 一起发。
 * `snapshot()` 前先 `publisher.flush()`，把待发增量同步冲出，再返回此刻的
 * revision 与 `registry.list()`。渲染端先订阅、再取快照，只回放
 * `revision > snapshot.revision` 的增量 —— snapshot 期间到达的旧 `running`
 * 因此不会覆盖后来已到的 `done`。
 *
 * ── 编号分配（不能每 token 等 IO）──
 * 注册表要求会话已有稳定编号才会登记运行（`code-unavailable` 时如实报错）。
 * 首次见一个会话时异步 `codes.assign(sessionId, 'session')`；在它完成前，
 * 该会话的 run signals 进内存缓冲（只有压缩后的小对象，绝不持有消息/工具
 * 原始输出）。编号就绪后同步冲刷；此后热路径（每个 token / 工具 chunk）
 * 都是同步 `registry.observe`，不 await 任何 IO。分配失败则显式记日志并
 * 放弃该会话的运行登记，不阻塞旧会话。
 *
 * ── 身份 ──
 * `ctx` 由 AgentController 在**事件到达时**按当时的会话状态构造（见
 * `RunObserverContext`），本文件再补上 runner generation。旧 pi 进程的迟到
 * 事件带着旧 generation，由注册表按 generation 丢弃，不会投到新的运行。
 *
 * 扩展 `ui_request` / `ui_resolved` 与宿主 `danger.confirm` 按**正式请求封套
 * 和 id** 观察，不另造请求；「拒绝 / 超时 / 无答复」同样是 resolved。
 */
import { createRunPipeline, type RunContext, type RunError, type RunPipeline } from './runs'
import { runSignalFromDangerConfirmation, runSignalFromUiResolved, signalsFromPiEvent } from './runs/pi-events'
import { subagentRunContext, type SubagentRunIdentity } from './runs/subagent'
import {
  normalizeScheduledOrigin,
  scheduledRunContext,
  ScheduledOriginTable,
  type ScheduledContextSeed,
  type ScheduledOrigin
} from './runs/scheduled-origin'
import type { CodeKind } from './runs/session-codes'
import { isTerminalPhase, type RunPhase, type RunSignal, type RunModel, type RunSnapshot } from '../shared/runs'
import type { MainPush } from '../shared/ipc'
import type { ApprovalRequest } from '../shared/approval'
import type { RunObserver, RunObserverContext } from './agent'
import { YAN_DIR } from './paths'

export interface RunsSnapshot {
  revision: number
  runs: RunSnapshot[]
}

/**
 * 评审运行 producer 需要的注册表能力（`RunRegistry` 结构上满足）。
 *
 * 只暴露 `open` / `observe`：producer 不接触编号 / 历史 / 推送，也不改
 * 事件路由。评审运行的实例 id 就是只读评审子运行的 id，因此按 runId 投影时
 * 事件不会回流到宿主的事件通道，也不会碰到别的运行。
 */
export interface ReviewRunRegistryPort {
  open(ctx: RunContext, phase?: RunPhase): RunSnapshot | null
  observe(ctx: RunContext, signal: RunSignal): RunSnapshot | null
}

/** 一次定时运行的登记入参；`scopeId` 是任务 id（T 编号作用域）。 */
export interface ScheduledRunInput {
  scopeId: string
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
  generation?: number
}

/** 登记后的定时运行句柄；失败 / 取消都用同一份 `context` 收口。 */
export interface ScheduledRunHandle {
  scopeId: string
  runId: string
  /** 该任务的稳定 T 号。 */
  code: string
  context: RunContext
}

export interface RunsHost {
  /** 给一个 AgentController 用的旁路接收器；`generation` 固定为该 runner 实例。 */
  observerFor(options?: { generation?: number }): RunObserver
  /**
   * 发送前把定时来源绑定到稳定 runner 代次 / 会话。绑定后该会话的第一个运行
   * 事件就走 `kind:'scheduled'` 的 T 号，不会再先给会话分一个 S 号。
   */
  bindScheduledOrigin(input: { scopeId?: string; sessionId?: string; generation?: number }): void
  /** 该会话不再是定时来源（例如被普通选择复用）时清除绑定与终态标记。 */
  clearScheduledOrigin(input: { sessionId?: string; generation?: number }): void
  /**
   * 显式登记一次定时运行：按任务 id 分配一次 T 号并 open 一个 `scheduled` 运行。
   * 必须在发送指令之前调用；同一任务重复调用返回同一个运行实例。
   */
  openScheduled(input: ScheduledRunInput): Promise<ScheduledRunHandle>
  /** 发送 / 准备失败时，以同一 RunContext 收口成 failed。 */
  failScheduled(handle: ScheduledRunHandle, message: string): void
  /** 用户取消时，以同一 RunContext 收口成 stopped。 */
  cancelScheduled(handle: ScheduledRunHandle): void
  /**
   * 子 Agent 的 pi 原始事件旁路。
   *
   * 终态语义与主会话一致：`agent_end` 不结束，只有 `agent_settled` 才终态。
   * 子运行归到父会话编号下（`S{n}·{k}`），首次事件时按父会话登记运行。
   * 没有父会话的子代理不登记，绝不发假编号。
   */
  observeSubagentEvent(run: SubagentRunIdentity, evt: Record<string, unknown>): void
  /**
   * 首次启用 v3 时给旧会话补号：按创建时间确定性排序，已存在的编号不动，
   * 重复调用（每次启动都跑一遍）结果稳定且不与现有编号冲突。
   */
  backfillSessionCodes(items: { scopeId: string; kind?: CodeKind; createdAt: number }[]): Promise<{ assigned: number }>
  /**
   * 为外部运行分配稳定编号：`review` → R 号（R04 这类），`scheduled` → T 号。
   * 评审 Agent 的 R 编号必须从这里来 —— 与 S 号同一份编号文档、同一套
   * 先落盘后提交内存的语义，界面与运行总览看到的编号因此一致。
   */
  assignCode(scopeId: string, kind?: CodeKind): Promise<string>
  /** flush 待发增量后取全量；返回的 revision 与刚冲出的推送一致。 */
  snapshot(): RunsSnapshot
  /**
   * 评审运行（R 号）的注册表端口：只读评审子运行的 pi 事件按 runId 经
   * `review/review-runs.ts` 投影成 `kind:'review'` 的运行。宿主只提供入口，
   * 不在这里复制 pi 循环或另建任务状态机。
   */
  reviewRunPort(): ReviewRunRegistryPort
  markSeen(runId: string): { ok: boolean }
  /** 观察宿主批准（正式 ApprovalRequest 封套，不另造请求或改变授权）。 */
  observeApproval(request: ApprovalRequest): void
  /** 该确认已有结论（允许 / 拒绝 / 超时 / 无答复都算 resolved）。 */
  resolveApproval(id: string): void
  /** 关闭监测与推送，并等编号 / 历史写盘结束。 */
  dispose(): Promise<void>
}

export interface RunsHostOptions {
  /** 数据根目录；缺省 YAN_DIR（会话编号与运行历史都落在这里）。 */
  root?: string
  push: (msg: MainPush) => void
  /** 测试注入；生产不传。 */
  now?: () => number
  newRunId?: () => string
}

/** 一个会话在编号分配完成前允许缓冲的信号数（只有压缩后的小对象）。 */
const MAX_PENDING_SIGNALS = 2_000

function isUsableSessionId(sessionId: string): boolean {
  return sessionId.length > 0 && !sessionId.startsWith('pending:')
}

/** 一个已登记的定时运行（一次触发一个 runId，T 号按任务稳定）。 */
interface ScheduledEntry {
  origin: ScheduledOrigin
  scopeId: string
  sessionId: string
  runId: string
  code: string
  context: RunContext
}

export async function createRunsHost(options: RunsHostOptions): Promise<RunsHost> {
  let revision = 0
  let disposed = false

  const log = (text: string): void => {
    options.push({ ch: 'log', payload: { text: `[runs] ${text}`, level: 'error' } })
  }

  const pipeline: RunPipeline = await createRunPipeline({
    root: options.root ?? YAN_DIR,
    ...(options.now ? { now: options.now } : {}),
    ...(options.newRunId ? { newRunId: options.newRunId } : {}),
    publish: (payload) => {
      revision += 1
      options.push({
        ch: 'runs',
        payload: { revision, upsert: payload.upsert, remove: payload.remove }
      })
    },
    onError: (error: RunError) => log(`${error.code}：${error.message}`)
  })

  /** 会话编号就绪状态；undefined = 还没开始分配。键是真正持有 S 号的会话。 */
  const codeState = new Map<string, 'pending' | 'ready' | 'failed'>()
  /** 编号就绪前按会话缓冲的 signals（保持到达顺序）。 */
  const buffered = new Map<string, { ctx: RunContext; signal: RunSignal }[]>()
  /** 批准请求 id → 会话上下文，供 resolve 时归还运行态。 */
  const pendingApprovals = new Map<string, RunContext>()
  /** 已经登记过 agent-start 的子代理 id，避免后续事件把运行重新拉回等待模型。 */
  const openedSubagents = new Set<string>()

  /**
   * 编号就绪状态按「谁真正持有 S 号」键：普通会话是自己；子 Agent 是父会话。
   * 子运行不会拿到一个多余的 S 号，只有父会话编号就绪后才登记。
   */
  const codeKeyOf = (ctx: RunContext): string =>
    ctx.kind === 'subagent' ? (ctx.parentSessionId ?? '') : ctx.sessionId

  const toContext = (ctx: RunObserverContext, generation?: number): RunContext => ({
    sessionId: ctx.sessionId,
    ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
    ...(ctx.title ? { title: ctx.title } : {}),
    ...(ctx.model ? { model: ctx.model as RunModel } : {}),
    ...(generation !== undefined ? { generation } : {})
  })

  /* 旁路观察跑在 AgentController 的推送与事件路径上：这里抛错只记日志，不能打断消息投影。 */
  const observe = (ctx: RunContext, signal: RunSignal): void => {
    try {
      pipeline.registry.observe(ctx, signal)
    } catch (error) {
      log(`运行信号处理失败（${signal.type}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const drain = (sessionId: string): void => {
    const queue = buffered.get(sessionId)
    buffered.delete(sessionId)
    if (!queue) return
    for (const item of queue) {
      if (disposed) return
      observe(item.ctx, item.signal)
    }
  }

  const ensureCode = (sessionId: string): void => {
    codeState.set(sessionId, 'pending')
    void pipeline.codes.assign(sessionId, 'session').then(
      () => {
        if (disposed) return
        codeState.set(sessionId, 'ready')
        drain(sessionId)
      },
      (error: unknown) => {
        codeState.set(sessionId, 'failed')
        buffered.delete(sessionId)
        log(`会话编号分配失败，运行不会登记：${sessionId}（${error instanceof Error ? error.message : String(error)}）`)
      }
    )
  }

  /**
   * ── 定时来源（v3 WP-51）──
   *
   * 定时任务在 select 时把来源绑到会话 / runner 代次，因此它的第一个运行事件
   * 就归到任务 id 的 T 号上，**不会**先给会话分 S 号再事后改标。运行实例与
   * 普通会话共用同一套 registry / reducer / 终态语义，这里只改编号作用域与归属。
   */
  const scheduledOrigins = new ScheduledOriginTable()
  /** 已登记、还没终态的定时运行：键是 `scopeId\0sessionId`，一次触发一个 runId。 */
  const scheduledEntries = new Map<string, ScheduledEntry>()
  /** 并发的首次登记合并成同一个 promise，避免同一任务分两次编号 / 开两次运行。 */
  const scheduledOpening = new Map<string, Promise<ScheduledEntry | null>>()
  /** 编号就绪前按作用域缓冲的定时信号（保持到达顺序）。 */
  const scheduledQueues = new Map<string, { ctx: RunContext; signal: RunSignal }[]>()
  /** 终态后仍保留来源绑定，用来丢弃同一会话的迟到事件，而不是回落去分 S 号。 */
  const scheduledClosed = new Set<string>()

  const clock = (): number => options.now?.() ?? Date.now()
  const scheduledKeyOf = (origin: ScheduledOrigin, sessionId: string): string => `${origin.scopeId}\u0000${sessionId}`

  const finalizeScheduled = (entry: ScheduledEntry): void => {
    scheduledEntries.delete(scheduledKeyOf(entry.origin, entry.sessionId))
    scheduledClosed.add(entry.sessionId)
  }

  const observeScheduledEntry = (entry: ScheduledEntry, ctx: RunContext, signal: RunSignal): void => {
    const merged: RunContext = {
      ...entry.context,
      ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
      ...(ctx.title ? { title: ctx.title } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.projectId ? { projectId: ctx.projectId } : {})
    }
    try {
      pipeline.registry.observe(merged, signal)
    } catch (error) {
      log(`定时运行信号处理失败（${signal.type}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const snapshot = pipeline.registry.get(entry.runId)
    if (snapshot && isTerminalPhase(snapshot.phase)) finalizeScheduled(entry)
  }

  const ensureScheduledEntry = (origin: ScheduledOrigin, seed: ScheduledContextSeed): Promise<ScheduledEntry | null> => {
    const key = scheduledKeyOf(origin, seed.sessionId)
    const existing = scheduledEntries.get(key)
    if (existing) return Promise.resolve(existing)
    const opening = scheduledOpening.get(key)
    if (opening) return opening
    const promise = (async (): Promise<ScheduledEntry | null> => {
      let code: string
      try {
        code = await pipeline.codes.assign(origin.scopeId, 'scheduled')
      } catch (error) {
        log(`定时编号分配失败，运行不会登记：${origin.scopeId}（${error instanceof Error ? error.message : String(error)}）`)
        return null
      }
      if (disposed) return null
      const context = scheduledRunContext(seed, origin, { code })
      const snapshot = pipeline.registry.open(context, { kind: 'queued', since: clock(), reason: 'scheduled' })
      if (!snapshot) return null
      const entry: ScheduledEntry = {
        origin,
        scopeId: origin.scopeId,
        sessionId: seed.sessionId,
        runId: snapshot.runId,
        code,
        context: { ...context, runId: snapshot.runId }
      }
      scheduledEntries.set(key, entry)
      return entry
    })()
    scheduledOpening.set(key, promise)
    void promise
      .finally(() => {
        if (scheduledOpening.get(key) === promise) scheduledOpening.delete(key)
      })
      .catch(() => undefined)
    return promise
  }

  const feedScheduled = (ctx: RunContext, origin: ScheduledOrigin, signal: RunSignal): void => {
    /* 终态后同一会话的迟到事件一律丢弃，不重新开运行、也不给会话分 S 号。 */
    if (scheduledClosed.has(ctx.sessionId)) return
    const key = scheduledKeyOf(origin, ctx.sessionId)
    const entry = scheduledEntries.get(key)
    if (entry) {
      const queue = scheduledQueues.get(key)
      if (queue) {
        if (queue.length < MAX_PENDING_SIGNALS) queue.push({ ctx, signal })
        return
      }
      observeScheduledEntry(entry, ctx, signal)
      return
    }
    let queue = scheduledQueues.get(key)
    if (!queue) {
      queue = []
      scheduledQueues.set(key, queue)
      void ensureScheduledEntry(origin, {
        sessionId: ctx.sessionId,
        ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
        ...(ctx.title ? { title: ctx.title } : {}),
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.generation !== undefined ? { generation: ctx.generation } : {})
      })
        .then((created) => {
          const pending = scheduledQueues.get(key)
          scheduledQueues.delete(key)
          if (!created || !pending) return
          for (const item of pending) {
            if (disposed) return
            observeScheduledEntry(created, item.ctx, item.signal)
          }
        })
        .catch(() => {
          scheduledQueues.delete(key)
        })
    }
    if (queue.length < MAX_PENDING_SIGNALS) queue.push({ ctx, signal })
  }

  const feed = (ctx: RunContext, signal: RunSignal): void => {
    if (disposed || !isUsableSessionId(ctx.sessionId)) return
    /* 定时会话的子运行不占新号：直接走 registry，由父运行编号算 `T01·n`。 */
    if (ctx.kind === 'subagent' && ctx.parentSessionId) {
      const parentOrigin = scheduledOrigins.resolve({ sessionId: ctx.parentSessionId })
      if (parentOrigin) {
        if (!scheduledClosed.has(ctx.parentSessionId)) observe(ctx, signal)
        return
      }
    }
    const origin = scheduledOrigins.resolve({
      sessionId: ctx.sessionId,
      ...(ctx.generation !== undefined ? { generation: ctx.generation } : {})
    })
    if (origin) {
      feedScheduled(ctx, origin, signal)
      return
    }
    const key = codeKeyOf(ctx)
    if (!key) return
    const state = codeState.get(key)
    if (state === 'ready') {
      observe(ctx, signal)
      return
    }
    if (state === 'failed') return
    if (!state) ensureCode(key)
    const queue = buffered.get(key)
    if (!queue) {
      buffered.set(key, [{ ctx, signal }])
      return
    }
    /* 编号迟迟不来（例如磁盘卡住）时不能让缓冲无限涨。 */
    if (queue.length >= MAX_PENDING_SIGNALS) return
    queue.push({ ctx, signal })
  }

  const bindScheduledOrigin = (input: { scopeId?: string; sessionId?: string; generation?: number }): void => {
    const origin = normalizeScheduledOrigin(input.scopeId)
    if (!origin) return
    scheduledOrigins.bind(origin, {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {})
    })
    if (input.sessionId) scheduledClosed.delete(input.sessionId)
  }

  const clearScheduledOrigin = (key: { sessionId?: string; generation?: number }): void => {
    scheduledOrigins.clear({
      ...(key.sessionId ? { sessionId: key.sessionId } : {}),
      ...(key.generation !== undefined ? { generation: key.generation } : {})
    })
    if (key.sessionId) scheduledClosed.delete(key.sessionId)
  }

  /** 以同一 RunContext 收口；registry 已经在终态时不再重复收口。 */
  const closeScheduled = (handle: ScheduledRunHandle, signal: RunSignal): void => {
    const entry = [...scheduledEntries.values()].find((item) => item.runId === handle.runId)
    if (!entry) return
    try {
      pipeline.registry.observe(entry.context, signal)
    } catch (error) {
      log(`定时运行收口失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const snapshot = pipeline.registry.get(entry.runId)
    if (snapshot && isTerminalPhase(snapshot.phase)) finalizeScheduled(entry)
  }

  /** 子运行的父运行实例：该会话下当前非终态的非子运行；找不到就只靠父会话编号。 */
  const activeParentRunId = (parentSessionId: string): string | undefined => {
    for (const run of pipeline.registry.list()) {
      if (run.kind !== 'subagent' && run.sessionId === parentSessionId && !isTerminalPhase(run.phase)) return run.runId
    }
    return undefined
  }

  return {
    observerFor(observerOptions = {}) {
      return (ctx, signal) => feed(toContext(ctx, observerOptions.generation), signal)
    },
    observeSubagentEvent(run, evt) {
      if (disposed) return
      const parentRunId = run.parentSessionId ? activeParentRunId(run.parentSessionId) : undefined
      const ctx = subagentRunContext(run, parentRunId ? { parentRunId } : {})
      if (!ctx) return
      if (!openedSubagents.has(run.id)) {
        openedSubagents.add(run.id)
        /* 子代理的 handleEvent 不处理 agent_start；这里显式登记，后续信号才归属同一个 runId。 */
        feed(ctx, { type: 'agent-start' })
      }
      const signals = signalsFromPiEvent(evt, options.now?.() ?? Date.now())
      for (const signal of signals) feed(ctx, signal)
    },
    async backfillSessionCodes(items) {
      if (disposed) return { assigned: 0 }
      const normalized = items
        .filter((item) => item && typeof item.scopeId === 'string' && item.scopeId.trim().length > 0)
        .map((item) => ({
          scopeId: item.scopeId.trim(),
          kind: (item.kind ?? 'session') as CodeKind,
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
        }))
      const assigned = await pipeline.codes.backfill(normalized)
      return { assigned }
    },
    assignCode(scopeId, kind) {
      return pipeline.codes.assign(scopeId, kind ?? 'session')
    },
    snapshot() {
      pipeline.publisher?.flush()
      return { revision, runs: pipeline.registry.list() }
    },
    reviewRunPort() {
      return {
        open: (ctx, phase) => (disposed ? null : pipeline.registry.open(ctx, phase)),
        observe: (ctx, signal) => (disposed ? null : pipeline.registry.observe(ctx, signal))
      }
    },
    markSeen(runId) {
      const ok = pipeline.registry.get(runId) !== undefined
      pipeline.registry.markSeen(runId)
      return { ok }
    },
    bindScheduledOrigin(input) {
      bindScheduledOrigin(input)
    },
    clearScheduledOrigin(input) {
      clearScheduledOrigin(input)
    },
    async openScheduled(input) {
      if (disposed) throw new Error('运行注册表已关闭')
      const origin = normalizeScheduledOrigin(input.scopeId)
      if (!origin) throw new Error('定时运行缺少任务 id')
      if (!input.sessionId) throw new Error('定时运行缺少会话 id')
      /* 先同步绑定，再 await 编号：编号 IO 期间的信号也按 scheduled 缓冲，不会先分 S。 */
      bindScheduledOrigin({
        scopeId: origin.scopeId,
        sessionId: input.sessionId,
        ...(input.generation !== undefined ? { generation: input.generation } : {})
      })
      const entry = await ensureScheduledEntry(origin, {
        sessionId: input.sessionId,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.generation !== undefined ? { generation: input.generation } : {})
      })
      if (!entry) throw new Error('定时运行无法登记（编号分配失败）')
      return { scopeId: entry.scopeId, runId: entry.runId, code: entry.code, context: entry.context }
    },
    failScheduled(handle, message) {
      closeScheduled(handle, { type: 'host-fail', message })
    },
    cancelScheduled(handle) {
      closeScheduled(handle, { type: 'stopped', by: 'host' })
    },
    observeApproval(request) {
      if (disposed || !request.sessionId) return
      const ctx: RunContext = { sessionId: request.sessionId }
      pendingApprovals.set(request.id, ctx)
      const risky = request.kind === 'danger' || request.kind === 'outside' || request.kind === 'delete'
      feed(ctx, risky
        ? runSignalFromDangerConfirmation({ id: request.id, summary: request.title })
        : { type: 'needs-you', request: { id: request.id, type: 'confirm', summary: request.title } })
    },
    resolveApproval(id) {
      const ctx = pendingApprovals.get(id)
      if (!ctx) return
      pendingApprovals.delete(id)
      feed(ctx, runSignalFromUiResolved(id))
    },
    async dispose() {
      if (disposed) return
      disposed = true
      codeState.clear()
      buffered.clear()
      pendingApprovals.clear()
      openedSubagents.clear()
      scheduledOrigins.reset()
      scheduledEntries.clear()
      scheduledOpening.clear()
      scheduledQueues.clear()
      scheduledClosed.clear()
      await pipeline.dispose()
    }
  }
}
