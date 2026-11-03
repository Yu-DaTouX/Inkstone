import { useStore } from '../../state/store'
import { displayedSessionOf, sameSplitSession, type SplitSessionRef } from '../../state/split-view'
import { ASK_DOCK_SELECTOR, focusAskDock } from '../session/AskDock'
import { focusSplitSession } from './split-actions'

export type PeerAsk = { kind: 'answer' | 'approval'; text: string }

const ANSWER_SETTLE_MAX_MS = 1500

export function usePeerAsk(target: SplitSessionRef): PeerAsk | null {
  const request = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId]?.uiRequests[0] : undefined))
  const approval = useStore((s) => (target.sessionId ? s.approvals.find((item) => item.sessionId === target.sessionId) : undefined))
  if (approval) return { kind: 'approval', text: approval.title }
  if (request) return { kind: 'answer', text: request.message || request.title || '' }
  return null
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
