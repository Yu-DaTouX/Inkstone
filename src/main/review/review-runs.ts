/**
 * 评审运行（R 号）的事件 producer（§10.2 / WP-50）。
 *
 * ── 职责边界 ──
 * 评审 Agent 的只读子运行仍由既有 `SubagentService` 执行（我们**不在这里**
 * 启动进程、不复制 pi 循环、不自建任务状态机）。本模块只做一件事：把那个
 * 子运行**按 runId 一对一映射**成运行注册表里 `kind:'review'` 的运行 ——
 *   · `begin`  ：子运行一启动就 `open`，编号用编号存储发出的 R 号；
 *   · `observe`：子运行的原始 pi 事件经既有 `signalsFromPiEvent` 投影成阶段；
 *   · `settle` ：结束 / 失败 / 停止各收口一次（终态由既有 reducer 决定）；
 *   · 未知或已终态的 runId 事件一律丢弃，绝不新建运行、绝不改别的运行。
 *
 * ── 归属 ──
 * 注册表里同一个 `sessionId` 只允许一个非终态运行（换实例会把旧的按宿主回收）。
 * 评审运行不是那个会话自身的运行，如果用属主会话 id 登记，会把**同时正在跑的
 * 主会话运行停掉**。所以评审运行用独立的注册表作用域 `review:<子运行 id>`，
 * 由 `sessionPath` / `projectId` / 标题带上属主会话事实（与子 Agent 用
 * `subagent:<id>` 作用域、把父会话放在 `parentSessionId` 同一思路）。
 *
 * 事件路由：本模块直接调注册表端口，不走宿主 `observerFor` 的事件通道，
 * 因此评审事件不会回流成会话信号，也不会碰到别的运行。
 */
import { isTerminalPhase, type RunModel, type RunPhase, type RunSignal, type RunSnapshot } from '../../shared/runs'
import type { RunContext } from '../runs/registry'
import type { ReviewRunRegistryPort } from '../runs-host'
import { signalsFromPiEvent } from '../runs/pi-events'

/** 评审运行在注册表里的作用域 id；只用于隔离 active 槽，不参与显示。 */
export function reviewRunScopeId(runId: string): string {
  return `review:${runId}`
}

/**
 * 子运行上报的模型标签（`provider/id`）→ 运行快照的 `RunModel`。
 *
 * 拆不出 provider 时按原样当 id，不编造 provider（与 `subagentModel` 同口径）。
 */
export function reviewRunModel(label?: string, thinking?: string): RunModel | undefined {
  const text = typeof label === 'string' ? label.trim() : ''
  if (!text) return undefined
  const slash = text.indexOf('/')
  const provider = slash > 0 ? text.slice(0, slash) : ''
  const id = slash > 0 ? text.slice(slash + 1) : text
  return { provider, id, label: text, ...(thinking ? { thinking } : {}) }
}

export interface ReviewRunInput {
  /** 只读评审子运行的 id；作为注册表运行实例 id（按 runId 一一映射） */
  runId: string
  /** 正式编号存储发出的 R 号（`R04` 这类） */
  code: string
  /** 属主会话的会话文件路径（运行总览「回到会话」与归属显示用） */
  sessionPath?: string
  projectId?: string
  title?: string
  model?: RunModel
}

/** 评审运行的终态；由宿主按子运行最终状态给出。 */
export type ReviewRunOutcome = 'done' | 'failed' | 'stopped'

export interface ReviewRunProducerOptions {
  registry: ReviewRunRegistryPort
  /** 可注入时钟（测试）；缺省 Date.now。 */
  now?: () => number
  /** 注册表拒绝登记时的可见日志；不改变返回值语义。 */
  onError?: (message: string) => void
}

export interface ReviewRunProducer {
  /** 子运行一启动就登记 R 运行；同一 runId 重复调用幂等返回 false。 */
  begin(input: ReviewRunInput): boolean
  /** 把该子运行的一条原始 pi 事件投影到它的 R 运行；未知 / 已终态 runId 忽略。 */
  observe(runId: string, evt: Record<string, unknown>): void
  /** 结束 / 失败 / 停止收口一次；该 runId 已不在登记表时返回 false（幂等）。 */
  settle(runId: string, outcome: ReviewRunOutcome, message?: string): boolean
  /** 该子运行当前是否登记着一个未终态的 R 运行。 */
  isActive(runId: string): boolean
  /** 当前登记中的运行数（收口后自动减少）。 */
  size(): number
}

export function createReviewRunProducer(options: ReviewRunProducerOptions): ReviewRunProducer {
  const now = (): number => options.now?.() ?? Date.now()
  /** 只读子运行 id → 该评审运行的注册表上下文（终态后删除）。 */
  const entries = new Map<string, RunContext>()

  const dropIfTerminal = (runId: string, snapshot: RunSnapshot | null): void => {
    if (snapshot && isTerminalPhase(snapshot.phase)) entries.delete(runId)
  }

  return {
    begin(input) {
      const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
      const code = typeof input.code === 'string' ? input.code.trim() : ''
      if (!runId || !code) return false
      if (entries.has(runId)) return false
      const ctx: RunContext = {
        runId,
        code,
        kind: 'review',
        sessionId: reviewRunScopeId(runId),
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {})
      }
      const phase: RunPhase = { kind: 'running', since: now(), activity: 'waiting-model' }
      const snapshot = options.registry.open(ctx, phase)
      if (!snapshot) {
        options.onError?.(`评审运行无法登记（${code}）：运行注册表未就绪或已关闭`)
        return false
      }
      entries.set(runId, ctx)
      dropIfTerminal(runId, snapshot)
      return true
    },

    observe(runId, evt) {
      const ctx = entries.get(runId)
      if (!ctx) return
      const signals = signalsFromPiEvent(evt, now())
      for (const signal of signals) {
        const snapshot = options.registry.observe(ctx, signal)
        if (snapshot) dropIfTerminal(runId, snapshot)
        if (!entries.has(runId)) return
      }
    },

    settle(runId, outcome, message) {
      const ctx = entries.get(runId)
      if (!ctx) return false
      const signal: RunSignal =
        outcome === 'done'
          ? { type: 'agent-settled', aborted: false }
          : outcome === 'stopped'
            ? { type: 'stopped', by: 'user' }
            : { type: 'host-fail', message: message ?? '评审运行失败' }
      const snapshot = options.registry.observe(ctx, signal)
      entries.delete(runId)
      return snapshot !== null
    },

    isActive(runId) {
      return entries.has(runId)
    },

    size() {
      return entries.size
    }
  }
}
