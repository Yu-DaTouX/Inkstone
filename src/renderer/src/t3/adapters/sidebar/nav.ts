import { useStore } from '../../../state/store'
import { openSidebarSession } from '../../../features/sidebar/session-advance'
import { LOCAL_ENVIRONMENT_ID } from '../../internal/environment'
import { scopedKeyOf, type ThreadRef } from './types'

export function navigateToThread(ref: ThreadRef): void {
  const item = useStore.getState().sessions.find((session) => session.id === ref.threadId)
  if (item) void openSidebarSession({ id: item.id, path: item.path })
}

export function navigateToThreadId(threadId: string): void {
  navigateToThread({ environmentId: LOCAL_ENVIRONMENT_ID, threadId })
}

export function useRouteThreadKey(): string | null {
  const sessionId = useStore((s) => s.session?.sessionId)
  return sessionId ? scopedKeyOf(sessionId) : null
}

export function useRouteThreadRef(): ThreadRef | null {
  const sessionId = useStore((s) => s.session?.sessionId)
  return sessionId ? { environmentId: LOCAL_ENVIRONMENT_ID, threadId: sessionId } : null
}
