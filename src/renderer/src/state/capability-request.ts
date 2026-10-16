export interface CapabilityRequestIdentity {
  runnerId: string | null
  sessionId?: string
}

export function isCapabilityResponseStale(
  sent: CapabilityRequestIdentity,
  current: CapabilityRequestIdentity
): boolean {
  if (sent.runnerId) return current.runnerId !== sent.runnerId
  if (!sent.sessionId) return false
  return current.sessionId !== sent.sessionId
}
