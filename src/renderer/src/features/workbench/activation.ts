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

export function captureActivationTarget(): ActivationTarget {
  const state = useStore.getState()
  const session = state.session
  return {
    sessionId: state.peekedSessionId ?? session?.sessionId ?? session?.conversationId ?? null,
    sessionFile: state.peekedPath ?? session?.sessionFile ?? session?.conversationFile ?? null
  }
}

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
  const pinned = target.sessionId || target.sessionFile
  if (pinned && !sameTarget(target, current)) {
    after.notify('warning', '会话已切换，工作区没有打开；请在目标会话重试')
    return false
  }
  return true
}
