/**
 * 会话激活的并发闸门（D4）。
 *
 * `switchSession` 从「开始读历史」到「selectSession 返回」跨越多次 await，
 * 这期间输入框完全可交互 —— 用户可能再点一条会话，也可能直接回车发送。
 * 发送前若不知道「切换在途」，`ensureActivated` 会把「没有待激活目标」
 * 误当成「视图与实例一致」，把消息发到上一条会话的实例上。
 *
 * 这里只保存一个非渲染事实：最近一次切换的代次。`switchSession` 在**第一个
 * await 之前**登记；`finally` 里只有代次仍是最新时才清除 —— 旧切换的收尾
 * 不能把新切换的标记清掉。不放 store：它不参与渲染，也不该被持久化。
 */
let switchInFlight: number | null = null

/** 登记一次「切换在途」；gate = switchSession 的会话选择代次。 */
export function beginSessionSwitch(gate: number): void {
  switchInFlight = gate
}

/** 收尾本次切换；只有它仍是当前在途的那次时才清除。 */
export function endSessionSwitch(gate: number): void {
  if (switchInFlight === gate) switchInFlight = null
}

export function isSessionSwitchInFlight(): boolean {
  return switchInFlight !== null
}

/** 测试用：清空闸门，避免用例之间互相污染。 */
export function resetSessionActivationForTest(): void {
  switchInFlight = null
}
