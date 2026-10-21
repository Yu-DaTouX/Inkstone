export interface ViewIdentitySession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
}

export interface ViewIdentityInput {
  peekedSessionId: string | null
  peekedPath: string | null
  session: ViewIdentitySession | null
}

export interface ViewIdentity {
  sessionId: string | null
  sessionFile: string | null
  peeked: boolean
}

const normPath = (p?: string | null): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

export function sameSessionFile(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

export function viewIdentityOf(input: ViewIdentityInput): ViewIdentity {
  if (input.peekedSessionId || input.peekedPath) {
    return { sessionId: input.peekedSessionId ?? null, sessionFile: input.peekedPath ?? null, peeked: true }
  }
  const session = input.session
  return {
    sessionId: session?.sessionId ?? session?.conversationId ?? null,
    sessionFile: session?.sessionFile ?? session?.conversationFile ?? null,
    peeked: false
  }
}

export function viewKeyRef(input: ViewIdentityInput): { sessionId?: string; path?: string } {
  const id = viewIdentityOf(input)
  return { sessionId: id.sessionId ?? undefined, path: id.sessionFile ?? undefined }
}

export interface PathEvidence {
  pendingActivation?: { sessionId?: string; sessionFile?: string } | null
  session?: ViewIdentitySession | null
  runners?: readonly { sessionId?: string; sessionFile?: string }[]
  sessions?: readonly { id: string; path: string }[]
}

export function incomingProvesPath(incomingSessionId: string, sessionFile: string, evidence: PathEvidence): boolean {
  const pending = evidence.pendingActivation
  if (pending?.sessionId === incomingSessionId && sameSessionFile(pending.sessionFile, sessionFile)) return true
  const session = evidence.session
  if (
    (session?.sessionId === incomingSessionId || session?.conversationId === incomingSessionId) &&
    (sameSessionFile(session?.sessionFile, sessionFile) || sameSessionFile(session?.conversationFile, sessionFile))
  ) {
    return true
  }
  if (evidence.runners?.some((runner) => runner.sessionId === incomingSessionId && sameSessionFile(runner.sessionFile, sessionFile))) {
    return true
  }
  if (evidence.sessions?.some((item) => item.id === incomingSessionId && sameSessionFile(item.path, sessionFile))) return true
  return false
}

export function pushBelongsToView(input: ViewIdentityInput & PathEvidence, incomingSessionId: string | undefined): boolean {
  if (!incomingSessionId) return true
  const id = viewIdentityOf(input)
  if (!id.peeked) return true
  if (id.sessionId) return incomingSessionId === id.sessionId
  if (!id.sessionFile) return false
  return incomingProvesPath(incomingSessionId, id.sessionFile, input)
}
