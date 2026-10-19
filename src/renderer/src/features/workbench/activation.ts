import { isSessionSwitchInFlight } from '../../state/session-activation'
import { useStore } from '../../state/store'
import { translate, type MessageKey, type TVars } from '../../i18n'

export interface ActivationTarget {
  sessionId: string | null
  sessionFile: string | null
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

function uiText(key: MessageKey, vars?: TVars): string {
  return translate(useStore.getState().settings?.lang ?? 'zh-CN', key, vars)
}

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
    store.notify('warning', uiText('state.workspace.switching'))
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
    after.notify('warning', uiText('state.workspace.sessionChanged'))
    return false
  }
  return true
}
