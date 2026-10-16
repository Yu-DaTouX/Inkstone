/**
 * 从正式「当前视图 + 运行实例 / 会话摘要」推导工作区归属（纯函数，可单测）。
 *
 * 为什么不直接拿 store 的 `session.cwd`：`session` 是**当前运行实例**的投影。
 * 用户可能只是 peek 一条历史会话还没激活，或者切换途中实例还停在旧会话上；
 * 这时候用 `session.cwd` 给新视图执行，就是「拿旧激活会话的 cwd 干新会话的活」。
 * 这里按身份逐级核对：
 *
 *   1. 视图身份 = `peekedSessionId/peekedPath`，否则回落到 `session` 的会话身份；
 *   2. cwd 优先取**属于该视图**的运行实例，其次与该视图一致的待激活目标，
 *      再次视图对应的会话摘要，最后才是与视图身份一致的运行实例投影；
 *   3. `active=false` 当且仅当有待激活目标，或活动实例明显属于另一条会话。
 *
 * 归属键沿用 `workspaceKeyFor`（resource-owners 规则），只表达资源挂在哪条会话旁边。
 */
import type { WorkspaceOwner } from './types'
import { workspaceKeyFor } from '../../state/workspace-key'
import { viewIdentityOf } from '../../state/view-identity'

export interface OwnerViewSession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
  cwd?: string
}

export interface OwnerViewRunner {
  id?: string
  runId: string
  sessionId?: string
  sessionFile?: string
  cwd: string
  generation: number
  /** 当前视图正在看的就是它 */
  isActive?: boolean
}

export interface OwnerViewPending {
  sessionId?: string
  sessionFile?: string
  cwd: string
}

export interface OwnerViewInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: OwnerViewSession | null
  pendingActivation: OwnerViewPending | null
  activeRunnerId: string | null
  runners: readonly OwnerViewRunner[]
  sessions: readonly { id: string; path: string; cwd: string }[]
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

function sameFile(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

/** 视图的稳定会话身份：优先正在显示的那条（peek），否则运行实例当前的会话。
 *
 * peek 存在时 id / 文件成对只取 peek，缺失的一侧留空：不能拿旧实例 A 的
 * id 去补 B 的路径，否则 A 会以「B 的视图」身份提供 cwd / active（与
 * `split-view.displayedSessionOf` 同一约定）。
 */
export function viewIdentity(input: OwnerViewInput): { sessionId: string | null; sessionFile: string | null } {
  const id = viewIdentityOf(input)
  return { sessionId: id.sessionId, sessionFile: id.sessionFile }
}

function runnerMatchesView(runner: OwnerViewRunner, sessionId: string | null, sessionFile: string | null): boolean {
  if (sessionId && runner.sessionId && runner.sessionId === sessionId) return true
  if (sessionFile && sameFile(runner.sessionFile, sessionFile)) return true
  return false
}

function pendingMatchesView(pending: OwnerViewPending, sessionId: string | null, sessionFile: string | null): boolean {
  if (sessionId && pending.sessionId && pending.sessionId === sessionId) return true
  if (sessionFile && sameFile(pending.sessionFile, sessionFile)) return true
  return false
}

/** 运行实例投影里的会话就是正在显示的那条（没有 peek 另一条） */
function sessionIsView(session: OwnerViewSession | null, sessionId: string | null, sessionFile: string | null): boolean {
  if (!session) return false
  if (sessionId) return session.sessionId === sessionId || session.conversationId === sessionId
  if (sessionFile) return sameFile(session.sessionFile, sessionFile) || sameFile(session.conversationFile, sessionFile)
  return true
}

export function deriveWorkspaceOwner(input: OwnerViewInput): WorkspaceOwner {
  const { sessionId, sessionFile } = viewIdentity(input)

  /* 视图对应的运行实例（按会话身份，而不是「当前活动实例」） */
  const viewRunner = input.runners.find((runner) => runnerMatchesView(runner, sessionId, sessionFile)) ?? null
  /* 当前活动实例：它属于另一条会话时，不能说当前视图已激活 */
  const activeRunner = input.activeRunnerId
    ? input.runners.find((runner) => (runner.runId ?? runner.id) === input.activeRunnerId) ?? null
    : null

  const pending = input.pendingActivation
  const pendingForView = !!pending && (!pending.sessionId && !pending.sessionFile ? false : pendingMatchesView(pending, sessionId, sessionFile))
  const summary = sessionId || sessionFile
    ? input.sessions.find((item) => (sessionId ? item.id === sessionId : sameFile(item.path, sessionFile))) ?? null
    : null

  const cwd =
    viewRunner?.cwd ||
    (pendingForView ? pending!.cwd : '') ||
    (sessionIsView(input.session, sessionId, sessionFile) ? input.session?.cwd ?? '' : '') ||
    summary?.cwd ||
    ''

  /* 只有活动实例的身份确实匹配所看视图（同 id 或同文件）时，它才能提供 active；
   * 否则 path-only 场景里旧实例 A 会把「还没激活的 B」误标成已激活。 */
  const activeRunnerMatchesView = !!activeRunner && runnerMatchesView(activeRunner, sessionId, sessionFile)
  const active =
    !pending &&
    !(
      activeRunner &&
      (sessionId || sessionFile) &&
      !activeRunnerMatchesView &&
      !sessionIsView(input.session, sessionId, sessionFile)
    )

  return {
    key: workspaceKeyFor({ sessionId: sessionId ?? undefined, path: sessionFile ?? undefined }),
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    cwd,
    ...(active && viewRunner ? { runId: viewRunner.runId, generation: viewRunner.generation } : {}),
    active
  }
}
