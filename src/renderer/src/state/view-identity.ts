/**
 * 「当前视图是哪条会话」的唯一取值规则（纯函数）。
 *
 * 切换会话时 store 会先把文件内容铺上（peek），此时的视图身份来自
 * `peekedSessionId` / `peekedPath`，与尚未跟上来的运行实例投影 `session`
 * 可能不是同一条。取身份必须**成对**：
 *
 *   · peek 任一身份存在（id 或路径）→ 只取 peek 这一对，缺失的一侧留空，
 *     绝不用 `session` 的 id / 文件补缺。否则会出现「B 的路径 + A 的 id」的
 *     混配身份，让旧实例 A 的 cwd / active 冒充成 B 的视图（path-only 场景）。
 *   · 没有 peek → 才回落到 `session`（会话 id / 对话 id、会话文件 / 对话文件）。
 *
 * 与 `split-view.displayedSessionOf` 的取舍完全一致（那边叠了分屏 uid 等字段）。
 * 只做取值与归属判定，不持有状态、不触发切换。
 */

export interface ViewIdentitySession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
}

export interface ViewIdentityInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: ViewIdentitySession | null
}

export interface ViewIdentity {
  sessionId: string | null
  sessionFile: string | null
  /** 身份来自尚未在 pi 侧确认的 peek；此时不能拿 `session` 补缺 */
  peeked: boolean
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

/** 两条会话文件路径是不是同一个文件（归一大小写与分隔符）。 */
export function sameSessionFile(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

/** 当前视图的会话身份；peek 存在时成对只取 peek，缺失的一侧是 null，不补旧会话。 */
export function viewIdentityOf(input: ViewIdentityInput): ViewIdentity {
  if (input.peekedSessionId || input.peekedPath) {
    return { sessionId: input.peekedSessionId ?? null, sessionFile: input.peekedPath ?? null, peeked: true }
  }
  const session = input.session
  return {
    sessionId: session?.sessionId ?? session?.conversationId ?? null,
    sessionFile: session?.sessionFile ?? session?.conversationFile ?? null,
    peeked: false
  }
}

/** `workspaceKeyFor` 的输入：成对取值，不把 null id 补成旧会话 id。 */
export function viewKeyRef(input: ViewIdentityInput): { sessionId?: string; path?: string } {
  const id = viewIdentityOf(input)
  return { sessionId: id.sessionId ?? undefined, path: id.sessionFile ?? undefined }
}

/** 当前视图的会话 id；path-only peek（只知文件、不知 id）时为 undefined，不回落旧会话。 */
export function viewingSessionIdOf(input: ViewIdentityInput): string | undefined {
  return viewIdentityOf(input).sessionId ?? undefined
}

export interface PathEvidence {
  pendingActivation?: { sessionId?: string; sessionFile?: string } | null
  session?: ViewIdentitySession | null
  runners?: readonly { sessionId?: string; sessionFile?: string }[]
  sessions?: readonly { id: string; path: string }[]
}

/**
 * 有没有一条正式证据（待激活目标 / 会话投影 / 运行实例 / 会话列表）能证明
 * `incomingSessionId` 就是这条会话文件。path-only peek 只能靠它认回自己的
 * 权威推送，认不回来就 fail closed，不能让别的会话覆盖。
 */
export function incomingProvesPath(incomingSessionId: string, sessionFile: string, evidence: PathEvidence): boolean {
  const pending = evidence.pendingActivation
  if (pending?.sessionId === incomingSessionId && sameSessionFile(pending.sessionFile, sessionFile)) return true
  const session = evidence.session
  if (
    (session?.sessionId === incomingSessionId || session?.conversationId === incomingSessionId) &&
    (sameSessionFile(session?.sessionFile, sessionFile) || sameSessionFile(session?.conversationFile, sessionFile))
  ) {
    return true
  }
  if (evidence.runners?.some((runner) => runner.sessionId === incomingSessionId && sameSessionFile(runner.sessionFile, sessionFile))) {
    return true
  }
  if (evidence.sessions?.some((item) => item.id === incomingSessionId && sameSessionFile(item.path, sessionFile))) return true
  return false
}

/**
 * 一条带运行实例身份的推送是否属于当前视图。
 *
 * · 没有 peek：交给既有的 `session` 归属判定（这里返回 true，不改变旧行为）；
 * · 有 id 的 peek：incoming 必须等于它；
 * · 只有路径的 peek：必须拿到文件证据，否则 fail closed ——
 *   旧会话迟到的 sync 不能覆盖正在查看的这条会话文件。
 */
export function pushBelongsToView(input: ViewIdentityInput & PathEvidence, incomingSessionId: string | undefined): boolean {
  if (!incomingSessionId) return true
  const id = viewIdentityOf(input)
  if (!id.peeked) return true
  if (id.sessionId) return incomingSessionId === id.sessionId
  if (!id.sessionFile) return false
  return incomingProvesPath(incomingSessionId, id.sessionFile, input)
}
