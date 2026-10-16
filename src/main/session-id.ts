const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

export function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}
