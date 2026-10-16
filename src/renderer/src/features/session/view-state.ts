/**
 * 会话视图的「当前身份」纯函数：把 store 的 peek 与运行实例投影折叠成一套
 * 只读身份，供 `SessionView` 决定滚动、流式 / 等待、日志筛选与批准 / 提问归属。
 *
 * 为什么不能直接用 `session`：`session` 是**当前运行实例**的投影。用户可能只是
 * 点开（peek）一条历史会话、还没在 pi 侧激活，或者切换途中实例还停在旧会话上；
 * 这时拿 `session` 的会话 id / 运行标志当成眼前这条会话，就会把 A 的流式、
 * 等待、问答记录与批准卡片挂到 B 上。这里按 peek 优先、**逐字段**回退：
 *   · 有 peek（`peekedSessionId` 或 `peekedPath`）→ 只认 peek 给出的字段；
 *     `peekedPath`-only 时 `sessionId` 保持 `null`，**不**回退活动会话 id
 *     （否则 B 会冒认 A 的会话身份）。
 *   · 没有 peek → 用运行实例投影的会话身份。
 *
 * 这里只做判定，不 import React / store / DOM，便于直接用真实函数单测。
 */

export interface SessionViewIdentity {
  /** 当前视图的稳定会话 id；未知（例如只拿到路径）时为 null，不猜。 */
  sessionId: string | null
  /** 当前视图的会话文件；未知时为 null。 */
  sessionFile: string | null
  /**
   * 稳定键：滚动记录与列表 React key 用它隔离。
   *
   * 文件优先于 id（同一会话重载后 id 可能变）。跨会话出现相同短消息 id 时，
   * key 里带上它会强制重挂，不会复用上一个视图的组件 / 小部件状态。
   */
  key: string
}

export interface SessionViewIdentitySession {
  sessionId?: string
  conversationId?: string
  sessionFile?: string
  conversationFile?: string
}

export interface SessionViewIdentityInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: SessionViewIdentitySession | null
}

/** 路径比较用的归一化（大小写与分隔符都不敏感）。 */
export function normalizeViewPath(path?: string | null): string {
  return (path ?? '').replace(/[\\/]+/g, '/').toLowerCase()
}

/** 两条路径是否指向同一文件（空值一律不等）。 */
export function sameViewPath(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normalizeViewPath(a) === normalizeViewPath(b)
}

/**
 * 推导当前视图身份。
 *
 * 关键边界：一旦存在 peek，就**不**用运行实例的字段补另一侧 ——
 * `peekedPath` 有值而 `peekedSessionId` 为空时，视图的 `sessionId` 就是 null。
 */
export function sessionViewIdentity(input: SessionViewIdentityInput): SessionViewIdentity {
  const peeking = !!(input.peekedSessionId || input.peekedPath)
  const sessionId = peeking
    ? input.peekedSessionId ?? null
    : input.session?.sessionId ?? input.session?.conversationId ?? null
  const sessionFile = peeking
    ? input.peekedPath ?? null
    : input.session?.conversationFile ?? input.session?.sessionFile ?? null
  return { sessionId, sessionFile, key: sessionFile || sessionId || '' }
}

/**
 * 当前视图是否就是运行实例正在投影的那条会话。
 *
 * 只有为真时，`session` / `runTail` 上的流式与等待才属于眼前这条会话。
 * `peekedPath`-only 看别人时，视图文件对不上活动文件 → 为假，不会把 A 的
 * 运行状态当成 B 的。
 */
export function viewMatchesProjectedSession(
  view: SessionViewIdentity,
  session: SessionViewIdentitySession | null
): boolean {
  if (!session) return false
  const ids = [session.sessionId, session.conversationId].filter((id): id is string => !!id)
  const files = [session.sessionFile, session.conversationFile].filter((file): file is string => !!file)
  if (view.sessionId && ids.includes(view.sessionId)) return true
  if (view.sessionFile && files.some((file) => sameViewPath(file, view.sessionFile))) return true
  return false
}

/**
 * 批准请求的来源是否就是当前视图。
 *
 * 子代理的批准挂在**父会话**上（与 `ApprovalCard` 的归属口径一致）；没有明确
 * 来源（既无 sessionId、也无法解析父会话）时返回 false —— 宁可等用户回到那条
 * 会话再显示，也不把请求挂到别的视图底部（隐藏不取消后台请求）。
 */
export function approvalMatchesView(
  request: { sessionId?: string; subagentId?: string },
  subagents: readonly { id: string; parentSessionId?: string }[],
  view: SessionViewIdentity
): boolean {
  if (!view.sessionId) return false
  const child = request.subagentId ? subagents.find((run) => run.id === request.subagentId) : undefined
  const originSessionId = child?.parentSessionId ?? request.sessionId
  return !!originSessionId && originSessionId === view.sessionId
}
