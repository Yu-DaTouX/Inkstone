import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { markSessionRunsSeen } from '../../state/use-current-runs-seen'
import { nextSessionAfter, sameSessionPathLoose } from './session-nav'
import { useSessionNav } from './session-nav-store'

export function viewingSessionPath(): string | null {
  const state = useStore.getState()
  return state.peekedPath ?? state.session?.sessionFile ?? null
}

export function openSidebarSession(item: { id?: string; path: string }): Promise<void> {
  useUiV3.getState().navigate({ name: 'chat' })
  return useStore.getState().switchSession(item.path).then(() => {
    if (!sameSessionPathLoose(useStore.getState().peekedPath, item.path)) return
    const summary = useStore.getState().sessions.find((entry) => sameSessionPathLoose(entry.path, item.path))
    markSessionRunsSeen({ id: item.id ?? summary?.id, path: item.path })
  })
}

export async function leaveSessionAfter(path: string, action: () => Promise<boolean>): Promise<boolean> {
  const wasViewing = sameSessionPathLoose(viewingSessionPath(), path)
  const order = useSessionNav.getState().order
  const ok = await action()
  if (!ok || !wasViewing || !sameSessionPathLoose(viewingSessionPath(), path)) return ok
  const next = nextSessionAfter(order, path)
  const listed = next ? useStore.getState().sessions.find((entry) => sameSessionPathLoose(entry.path, next)) : undefined
  if (listed && !listed.archivedAt) {
    await openSidebarSession({ id: listed.id, path: listed.path })
    return ok
  }
  useUiV3.getState().navigate({ name: 'chat' })
  await useStore.getState().newSession({ scope: 'global' })
  return ok
}
