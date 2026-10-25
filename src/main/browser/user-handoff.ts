let release: ((sessionId: string) => void) | null = null

export function setUserHandoffRelease(handler: ((sessionId: string) => void) | null): void {
  release = handler
}

export function userMessageSent(sessionId: string | null | undefined): void {
  if (sessionId) release?.(sessionId)
}
