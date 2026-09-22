/**
 * 同一会话的「下一步动作」判定（实施-14 F2 / H1）。
 *
 * ══════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════
 * 交接、自主续跑、模型错误重试原本是三条各自 `void` 起跑的链路：
 * 同一份 `state` 推送里，交接在准备包的同时，续跑也可能被 arm 出去。
 * 结果就是「源会话一边往外交接、一边继续往下跑」，或者一次工具还没结束
 * 就动了会话身份。这一层把优先级收成**一个纯函数**，宿主只负责执行。
 *
 * ── 为什么优先级是这个顺序 ──
 *   1. `busy`：实例还在跑（回合 / 流式 / 工具）—— 安全边界根本还没到，
 *      此时任何决定都是拿旧状态猜未来。
 *   2. `wait-error-retry`：模型错误重试有自己的退避与上限（S5c），
 *      再 arm 一条续跑就是两条腿抢同一个回合。
 *   3. `wait-handoff`：交接已经登记了操作所有权 —— 冻结源续跑（§5.2），
 *      等它提交或放弃。放弃时宿主会把续跑放回来。
 *   4. `prefer-handoff`：够格就只做交接；不够格（资格判定在宿主里做）
 *      才退回普通续跑。
 *   5. `continue`：直接普通续跑。
 *
 * ⚠️ 这个函数**不判资格**（那要读三份 store + 解析模式）。它只回答
 * 「这一刻该往哪个方向走」。真正的资格判定仍由 `handoffEligibility` 做。
 */

/** 一个空闲回合收尾之后，下一步该做什么。 */
export type SessionWorkAction =
  /** 实例还在忙：什么也不做（安全边界未到） */
  | 'wait-busy'
  /** 已排模型错误重试：什么也不做（免得两条腿抢同一个回合） */
  | 'wait-error-retry'
  /** 交接正在准备包：冻结源续跑 */
  | 'wait-handoff'
  /** 先试交接；不够格再普通续跑 */
  | 'prefer-handoff'
  /** 直接普通续跑 */
  | 'continue'

export interface SessionWorkInput {
  /** 实例忙（回合在跑 / 流式 / 工具未结束） */
  busy: boolean
  /** 这个 runner 上已经有一次交接在准备包 */
  handoffPending: boolean
  /** 这个 runner 上已经排了模型错误重试 */
  errorRetryPending: boolean
  /** 这次调度是否允许尝试交接（自动交接开关 + 触发来源） */
  handoffAllowed: boolean
}

/**
 * 决定下一步。
 *
 * 顺序即优先级，且**每一条早退都有可读的原因**（诊断与排障要用）。
 */
export function decideSessionWork(input: SessionWorkInput): SessionWorkAction {
  if (input.busy) return 'wait-busy'
  if (input.errorRetryPending) return 'wait-error-retry'
  if (input.handoffPending) return 'wait-handoff'
  if (input.handoffAllowed) return 'prefer-handoff'
  return 'continue'
}

/**
 * 一次延迟回调是否仍拥有这个会话的当前操作（实施-14 F2 / H2）。
 *
 * 为什么需要它：轮询与超时是两条独立定时器，旧操作（提前完成、被替换、
 * 被停止）留下的一条回调醒来时，现场可能已经是**新**操作 ——
 * 老代码不核对身份，于是旧 timeout 会把新操作清掉（用户看到新交接莫名失败）。
 *
 * 语义：
 *   · 回调**没带**身份 → 视为「就是当前操作」（内部同步调用点都是这种）；
 *   · 回调带身份 → 必须与当前操作完全相同；
 *   · 当前没有操作（`current` 为空）→ 带身份的回调一律不拥有任何东西。
 */
export function ownsHandoffOperation(
  currentOperationId: string | null | undefined,
  callbackOperationId: string | null | undefined
): boolean {
  const current = typeof currentOperationId === 'string' && currentOperationId.trim() ? currentOperationId.trim() : null
  const callback = typeof callbackOperationId === 'string' && callbackOperationId.trim() ? callbackOperationId.trim() : null
  if (!callback) return true
  return current !== null && current === callback
}

/** 一行可读摘要（日志 / 诊断）。 */
export function sessionWorkSummary(action: SessionWorkAction): string {
  switch (action) {
    case 'wait-busy':
      return '等待安全边界（实例仍在工作）'
    case 'wait-error-retry':
      return '等待已排的模型错误重试'
    case 'wait-handoff':
      return '交接进行中：冻结源续跑'
    case 'prefer-handoff':
      return '优先尝试交接，不够格才续跑'
    case 'continue':
      return '普通续跑'
  }
}
