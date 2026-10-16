/**
 * 子 Agent 运行的注册表身份（v3 WP-10）。
 *
 * 子代理有自己的 pi 进程与独立会话，但**不占自己的 S 号**：在注册表里固定
 * 归到父会话编号下 `S{n}·{k}`。这里只做三件纯函数的事：
 *
 *   · `subagentScopeId` —— 子运行在注册表里的 sessionId 作用域。它必须与父会话
 *     区分开，否则会覆盖父会话 `active` 映射；用子代理 id 前缀即可稳定复用。
 *   · `subagentRunContext` —— 由 `SubagentRun` 的稳定字段构造 `RunContext`。
 *   · `subagentModel` —— 把 `provider/id` 标签拆成 `RunModel`，缺字段不猜。
 *
 * 终态归约不在这里：子代理的 pi 事件仍走 `signalsFromPiEvent`，`agent_end`
 * 不结束、只有 `agent_settled` 才终态。这样注册表的终态语义与主会话一致。
 */
import type { RunModel } from '../../shared/runs'
import type { RunContext } from './registry'

/** 子 Agent 归约需要的最小身份；`SubagentRun` 是它的超集。 */
export interface SubagentRunIdentity {
  id: string
  parentSessionId?: string
  task?: string
  model?: string
  thinkingLevel?: string
}

/** 子运行在注册表里的作用域 id；只用于区分会话，不参与显示。 */
export function subagentScopeId(id: string): string {
  return `subagent:${id}`
}

/**
 * `SubagentRun.model` 是 pi 的 `provider/id` 标签；拆不出 provider 时按原样当 id，
 * 不编造 provider。思考强度单独带上，没拿到就不填。
 */
export function subagentModel(run: Pick<SubagentRunIdentity, 'model' | 'thinkingLevel'>): RunModel | undefined {
  const label = typeof run.model === 'string' ? run.model.trim() : ''
  if (!label) return undefined
  const slash = label.indexOf('/')
  const provider = slash > 0 ? label.slice(0, slash) : ''
  const id = slash > 0 ? label.slice(slash + 1) : label
  return { provider, id, label, ...(run.thinkingLevel ? { thinking: run.thinkingLevel } : {}) }
}

/**
 * 构造子运行的注册表上下文。
 *
 * 没有父会话就返回 null：`S{n}·{k}` 的 `n` 只能来自父会话，宁可不登记也不发假编号。
 * `parentRunId` 由调用方在能解析到父运行实例时通过 `extra` 补上，用于把子行挂回
 * 父运行；解析不到也不影响编号（注册表会退回父会话编号）。
 */
export function subagentRunContext(run: SubagentRunIdentity, extra: Partial<RunContext> = {}): RunContext | null {
  if (!run.id || !run.parentSessionId) return null
  const model = subagentModel(run)
  return {
    sessionId: subagentScopeId(run.id),
    kind: 'subagent',
    parentSessionId: run.parentSessionId,
    ...(run.task ? { title: run.task } : {}),
    ...(model ? { model } : {}),
    ...extra
  }
}
