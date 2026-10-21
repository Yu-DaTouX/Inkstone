const PENDING_SESSION_KEY = 'pending'

export function workbenchSessionKey(sessionFile?: string, sessionId?: string): string {
  return sessionFile || sessionId || PENDING_SESSION_KEY
}

interface ConversationSession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
}

export function conversationKeyOf(session: ConversationSession | null | undefined): string {
  return workbenchSessionKey(session?.conversationFile ?? session?.sessionFile, session?.conversationId ?? session?.sessionId)
}

export function workspaceKeyFor(ref: { sessionId?: string; path?: string }): string {
  return workbenchSessionKey(ref.path, ref.sessionId)
}
