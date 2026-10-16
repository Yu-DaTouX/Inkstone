/**
 * 用户在工作区里要求需要激活的页签（终端 / 浏览器）时，把「正在看的会话」
 * 真正切到 pi 侧。
 *
 * 关键约束（CONTRACT）：**在 `ensureActivated` 前后钉住目标**。
 * `ensureActivated` 内部会 await 主进程切换，期间用户可能又点了别的会话；
 * 若返回后当前视图已不是发起时的那条，就不能把工作区资源挂到新会话上，
 * 也不能假装成功 —— 保留面板关闭并给出 notice。
 *
 * 不在这里新建资源、不执行 PTY、不导航浏览器；只负责会话激活这一步。
 */
import { isSessionSwitchInFlight } from '../../state/session-activation'
import { useStore } from '../../state/store'

export interface ActivationTarget {
  sessionId: string | null
  sessionFile: string | null
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

function sameTarget(a: ActivationTarget, b: ActivationTarget): boolean {
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId
  return !!a.sessionFile && !!b.sessionFile && normPath(a.sessionFile) === normPath(b.sessionFile)
}

/** 记录发起激活时的视图身份。 */
export function captureActivationTarget(): ActivationTarget {
  const state = useStore.getState()
  const session = state.session
  return {
    sessionId: state.peekedSessionId ?? session?.sessionId ?? session?.conversationId ?? null,
    sessionFile: state.peekedPath ?? session?.sessionFile ?? session?.conversationFile ?? null
  }
}

/**
 * 尝试激活。返回 true 才允许打开需要激活的页签。
 * 失败原因由 `ensureActivated` 或这里推入 `notify`，调用方不要再造一份。
 */
export async function activateWorkspaceOwner(target: ActivationTarget): Promise<boolean> {
  const store = useStore.getState()
  if (isSessionSwitchInFlight()) {
    store.notify('warning', '正在切换会话，请稍候再打开工作区')
    return false
  }
  const ok = await store.ensureActivated()
  if (!ok) return false

  const after = useStore.getState()
  const session = after.session
  const current: ActivationTarget = {
    sessionId: after.peekedSessionId ?? session?.sessionId ?? session?.conversationId ?? null,
    sessionFile: after.peekedPath ?? session?.sessionFile ?? session?.conversationFile ?? null
  }
  /* 空目标（新会话还没落盘）不算错；有目标就必须仍然是同一条，避免静默挂到别处 */
  const pinned = target.sessionId || target.sessionFile
  if (pinned && !sameTarget(target, current)) {
    after.notify('warning', '会话已切换，工作区没有打开；请在目标会话重试')
    return false
  }
  return true
}
