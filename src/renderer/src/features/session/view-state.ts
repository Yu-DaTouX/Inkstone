interface SessionViewIdentity {
  sessionId: string | null
  sessionFile: string | null
  key: string
}

interface SessionViewIdentitySession {
  sessionId?: string
  conversationId?: string
  sessionFile?: string
  conversationFile?: string
}

interface SessionViewIdentityInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: SessionViewIdentitySession | null
}

function normalizeViewPath(path?: string | null): string {
  return (path ?? '').replace(/[\\/]+/g, '/').toLowerCase()
}

export function sameViewPath(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normalizeViewPath(a) === normalizeViewPath(b)
}

export function sessionViewIdentity(input: SessionViewIdentityInput): SessionViewIdentity {
  const peeking = !!(input.peekedSessionId || input.peekedPath)
  const sessionId = peeking
    ? input.peekedSessionId ?? null
    : input.session?.sessionId ?? input.session?.conversationId ?? null
  const sessionFile = peeking
    ? input.peekedPath ?? null
    : input.session?.conversationFile ?? input.session?.sessionFile ?? null
  return { sessionId, sessionFile, key: sessionFile || sessionId || '' }
}

export function viewMatchesProjectedSession(
  view: SessionViewIdentity,
  session: SessionViewIdentitySession | null
): boolean {
  if (!session) return false
  const ids = [session.sessionId, session.conversationId].filter((id): id is string => !!id)
  const files = [session.sessionFile, session.conversationFile].filter((file): file is string => !!file)
  if (view.sessionId && ids.includes(view.sessionId)) return true
  if (view.sessionFile && files.some((file) => sameViewPath(file, view.sessionFile))) return true
  return false
}

export function approvalMatchesView(
  request: { sessionId?: string; subagentId?: string },
  subagents: readonly { id: string; parentSessionId?: string }[],
  view: SessionViewIdentity
): boolean {
  if (!view.sessionId) return false
  const child = request.subagentId ? subagents.find((run) => run.id === request.subagentId) : undefined
  const originSessionId = child?.parentSessionId ?? request.sessionId
  return !!originSessionId && originSessionId === view.sessionId
}
