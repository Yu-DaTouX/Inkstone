import { useMemo } from 'react'
import { useStore } from '../../state/store'
import { createPeerAskSelector, type PeerAsk } from './peer-ask-view'
import { displayedSessionOf, sameSplitSession, type SplitSessionRef } from '../../state/split-view'
import { ASK_DOCK_SELECTOR, focusAskDock } from '../session/AskDock'
import { focusSplitSession } from './split-actions'

const ANSWER_SETTLE_MAX_MS = 1500

export function usePeerAsk(target: SplitSessionRef): PeerAsk | null {
  const { sessionId } = target
  return useStore(useMemo(() => createPeerAskSelector(sessionId), [sessionId]))
}

export function answerSplitSession(target: SplitSessionRef): void {
  focusSplitSession(target, { composer: false })
  const started = performance.now()
  const check = (): void => {
    const shown = sameSplitSession(displayedSessionOf(useStore.getState()), target)
    if (shown && document.querySelector(ASK_DOCK_SELECTOR)) {
      focusAskDock()
      return
    }
    if (performance.now() - started < ANSWER_SETTLE_MAX_MS) window.setTimeout(check, 50)
  }
  check()
}
