let release: ((sessionId: string) => void | Promise<void>) | null = null

export function setUserHandoffRelease(handler: ((sessionId: string) => void | Promise<void>) | null): void {
  release = handler
}

export async function userMessageSent(sessionId: string | null | undefined): Promise<void> {
  const handler = release
  if (!sessionId || !handler) return
  await Promise.resolve().then(() => handler(sessionId)).catch(() => undefined)
}
