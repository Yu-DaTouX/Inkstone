/**
 * 推送的身份与归属判定：一条主进程推送该不该改当前视图。
 *
 * 带 `runtime` 的推送只属于某一个会话 / 运行实例 / 代次：
 *   · 比当前运行实例更旧的代次 → 丢弃；
 *   · 属于后台会话 → 只写进会话运行缓存（sessionRuntimes），不改当前投影；
 *   · 同一个运行实例被复用到新会话时，旧会话迟到的帧也只进缓存。
 * 旧探针没有 runtime 时走 sessionKey 的兼容路径。纯函数，便于单测。
 */
import type { MainPush, RunnerStatus, SessionState } from '../../../shared/ipc'
import { migrateSessionRuntime, reduceSessionRuntime, type SessionRuntimeMap } from './session-runtime'

export interface PushRoutingView {
  runners: RunnerStatus[]
  activeRunnerId: string | null
  sessionRuntimes: SessionRuntimeMap
  peekedSessionId: string | null
  session: SessionState | null
}

export interface PushRoute {
  /** 要先写进 store 的缓存 / 当前实例变化；没有为 null */
  patch: { sessionRuntimes?: SessionRuntimeMap; activeRunnerId?: string } | null
  /** 是否继续把这条推送投影到当前视图 */
  project: boolean
}

/** 当前视图看向哪条会话：优先「待确认的 peek」，否则用已确认的会话状态。 */
export function viewingSessionId(s: Pick<PushRoutingView, 'peekedSessionId' | 'session'>): string | undefined {
  return s.peekedSessionId ?? s.session?.sessionId ?? undefined
}

export function routePush(s: PushRoutingView, m: MainPush): PushRoute {
  /*
   * 实例身份过滤（N12）。
   *
   * 带 `runtime` 的消息只属于某一个会话/运行实例/代次：
   *   · 还没对齐身份（初始化第一帧）→ 以第一条为当前视图；
   *   · 与当前视图不一致 → 只写进 `sessionRuntimes`，不改当前投影。
   *     切回去时主进程仍会给完整快照，缓存用于保持后台状态可见。
   *   · 比当前运行实例更旧的 generation → 直接丢弃。
   * 旧探针没有 runtime 时继续使用 sessionKey 的兼容路径。
   */
  if (m.runtime) {
    const currentRunner = s.runners.find((runner) => (runner.runId ?? runner.id) === m.runtime!.runId)
    if (currentRunner && m.runtime.generation < currentRunner.generation) return { patch: null, project: false }

    const active = s.activeRunnerId
      ? s.activeRunnerId === m.runtime.runId &&
        (!currentRunner || m.runtime.generation >= currentRunner.generation)
      : true
    const cache = migrateSessionRuntime(
      reduceSessionRuntime(s.sessionRuntimes, m.runtime, m),
      m.runtime
    )
    const patch = {
      sessionRuntimes: cache,
      ...(s.activeRunnerId ? {} : { activeRunnerId: m.runtime.runId })
    }
    /*
     * 同一个 runner 可以在切会话时复用。此时旧会话的推送仍然会带着
     * 同一个 runId，单靠 active 判定挡不住它；peekedSessionId 才是当前
     * 视图已经铺上的目标身份。缓存要继续收，但 todos / stats / state 等
     * 顶层投影不能让旧会话迟到的帧覆盖新会话。
     */
    const viewing = viewingSessionId(s)
    const belongsToView = !viewing || !m.runtime.sessionId || m.runtime.sessionId === viewing
    return { patch, project: active && belongsToView }
  } else if (m.sessionKey) {
    if (!s.activeRunnerId) return { patch: { activeRunnerId: m.sessionKey }, project: true }
    if (s.activeRunnerId !== m.sessionKey) return { patch: null, project: false }
  }
  return { patch: null, project: true }
}
