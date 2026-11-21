import type { Store } from '../../state/store'

export type PeerAsk = { kind: 'answer' | 'approval'; text: string }

export function createPeerAskSelector(sessionId: string | undefined) {
  let approvals: Store['approvals'] | undefined
  let approvalText: string | undefined
  let previous: PeerAsk | null = null
  return (state: Pick<Store, 'approvals' | 'sessionRuntimes'>): PeerAsk | null => {
    if (!sessionId) return null
    if (state.approvals !== approvals) {
      approvals = state.approvals
      approvalText = approvals.find((item) => item.sessionId === sessionId)?.title
    }
    const request = approvalText === undefined ? state.sessionRuntimes[sessionId]?.uiRequests[0] : undefined
    if (approvalText === undefined && !request) return previous = null
    const kind = approvalText !== undefined ? 'approval' : 'answer'
    const text = approvalText ?? (request?.message || request?.title || '')
    if (previous?.kind !== kind || previous.text !== text) previous = { kind, text }
    return previous
  }
}
