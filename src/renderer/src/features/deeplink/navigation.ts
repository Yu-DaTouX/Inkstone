import type { DeepLinkIntent } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { usePendingPairInvite } from '../collab/pending-invite'

export function applyDeepLink(intent: DeepLinkIntent): void {
  const ui = useUiV3.getState()
  const store = useStore.getState()
  switch (intent.action) {
    case 'session': {
      ui.navigate({ name: 'chat' })
      const local = store.sessions.find((s) => s.id === intent.sessionId)?.path
      if (local) {
        void store.switchSession(local)
        return
      }
      void window.yan
        .listSessions()
        .then((list) => {
          const hit = list.find((s) => s.id === intent.sessionId)
          if (hit) void useStore.getState().switchSession(hit.path)
        })
        .catch(() => {
        })
      return
    }
    case 'new-session': {
      ui.navigate({ name: 'chat' })
      void store.newSession({ scope: 'global' }).then((res) => {
        if (res.ok && intent.text) useStore.getState().injectComposerText(intent.text)
      })
      return
    }
    case 'settings': {
      store.openSettings(intent.section)
      return
    }
    case 'pair': {
      usePendingPairInvite.getState().offer({ address: intent.address, code: intent.code })
      ui.navigate({ name: 'collab' })
      return
    }
  }
}

export function installDeepLinkNavigation(): () => void {
  return window.yan.onDeepLink((intent) => applyDeepLink(intent))
}
