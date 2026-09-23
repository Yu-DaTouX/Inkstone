/**
 * 「只接受最新一次请求」的代次守卫（审核 R10）。
 *
 * 设置页会在会话 / 项目变化时重新取列表，而 IPC 的返回顺序不保证 ——
 * 迟到的旧响应如果直接写进状态，用户看到的就是**上一个项目**的数据。
 * 把「发起 → 判定」拆出来，纯逻辑就能单测；用法：
 *
 *     const guard = createLatestOnly()
 *     const token = guard.begin()
 *     const next = await fetchList()
 *     if (!guard.isCurrent(token)) return   // 期间又发过请求 → 丢弃
 *     setView(next)
 *
 * `invalidate()` 给卸载用：之后到达的任何结果都不算当前。
 */
export interface LatestOnly {
  /** 开始一次请求，拿到它的令牌 */
  begin(): number
  /** 这个令牌还是最新的吗（不是就说明有更新的请求发出过） */
  isCurrent(token: number): boolean
  /** 让所有在途请求作废（组件卸载 / 主动重来） */
  invalidate(): void
}

export function createLatestOnly(): LatestOnly {
  let seq = 0
  return {
    begin: () => ++seq,
    isCurrent: (token) => token === seq,
    invalidate: () => {
      seq += 1
    }
  }
}
