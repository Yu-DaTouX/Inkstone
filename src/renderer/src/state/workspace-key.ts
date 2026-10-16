import { workbenchSessionKey } from './workbench'

interface ConversationSession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
}

const known = new Map<string, string>()
const MAX_KNOWN = 400
const normPath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()

export function conversationKeyOf(session: ConversationSession | null | undefined): string {
  return workbenchSessionKey(session?.conversationFile ?? session?.sessionFile, session?.conversationId ?? session?.sessionId)
}

export function rememberConversationKey(session: ConversationSession | null | undefined): void {
  if (!session || (!session.sessionId && !session.sessionFile)) return
  const key = conversationKeyOf(session)
  if (session.sessionId) known.set(`id:${session.sessionId}`, key)
  if (session.sessionFile) known.set(`path:${normPath(session.sessionFile)}`, key)
  for (const oldest of known.keys()) {
    if (known.size <= MAX_KNOWN) break
    known.delete(oldest)
  }
}

export function workspaceKeyFor(ref: { sessionId?: string; path?: string }): string {
  const hit = (ref.sessionId ? known.get(`id:${ref.sessionId}`) : undefined) ?? (ref.path ? known.get(`path:${normPath(ref.path)}`) : undefined)
  return hit ?? workbenchSessionKey(ref.path, ref.sessionId)
}
