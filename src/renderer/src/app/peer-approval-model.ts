export type PeerDecisionOutcome = 'approved' | 'gone' | 'failed'

export function peerDecisionOutcome(accepted: boolean | null): PeerDecisionOutcome {
  if (accepted === null) return 'failed'
  return accepted ? 'approved' : 'gone'
}

export function withoutApprovalRequest<T extends { requestId: string }>(queue: readonly T[], requestId: string): T[] {
  return queue.filter((item) => item.requestId !== requestId)
}
