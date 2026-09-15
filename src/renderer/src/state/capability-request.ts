/**
 * 能力列表请求的过期判定。
 *
 * 为什么单独抽成文件：这条规则踩过一次坑（见下），必须能单测钉住，
 * 不能继续以「内联在 store 里的一句 if」存在 —— 那样只有跑起真实 pi
 * 才可能发现它坏了，而隔离测试环境根本起不来 pi。
 *
 * ── 那个坑（用户报的「看不到模型选择」）──
 *
 * 模型列表 / 思考档位 / 斜杠命令都是**运行实例级**的
 *（`get_available_models` 与当前是哪个会话无关），但响应原本用
 * `sessionId` 做等值校验。而启动早期 sessionId 先是 `pending:<runId>`，
 * pi 就绪后才换成真实 uuid —— 这条**正常过渡**会把响应判成过期丢掉，
 * 于是模型菜单一直是空的（用户只能看到空的「没有匹配的模型」）。
 *
 * ── 规则 ──
 *
 *   有 runId 时只认 runId：切会话 / 切项目才会换实例，那才是真正要防的
 *   「迟到的旧响应覆盖新会话」。
 *   没有 runId（旧探针、最早的几帧）才退回 sessionId 比较。
 */

export interface CapabilityRequestIdentity {
  /** 运行实例 id；null 表示此刻还没有实例身份 */
  runnerId: string | null
  /** 会话 id；启动早期可能是 `pending:<runId>` */
  sessionId?: string
}

/**
 * 响应是否已过期（应丢弃）。
 *
 * @param sent    发起请求时记录的实例身份
 * @param current 响应到达时的实例身份
 */
export function isCapabilityResponseStale(
  sent: CapabilityRequestIdentity,
  current: CapabilityRequestIdentity
): boolean {
  if (sent.runnerId) return current.runnerId !== sent.runnerId
  if (!sent.sessionId) return false
  return current.sessionId !== sent.sessionId
}
