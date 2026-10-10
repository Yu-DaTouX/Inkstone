import { workbenchSessionKey } from './workbench'

/**
 * 工作区（磁贴排布、终端与文件预览的归属）按「会话的对话」存：接力后新会话文件沿用原对话的键。
 * 单会话与分屏的每一列都从这里取键，同一条会话在两种模式下永远是同一把。
 *
 * 磁贴上只有会话 id 与路径，对话字段只在会话成为活动会话时才知道，所以那时记一份对照；
 * 没见过的会话先按路径与 id 取键（只有接力出来的会话成为活动后键才会变）。
 */
interface ConversationSession {
  sessionId?: string
  sessionFile?: string
  conversationId?: string
  conversationFile?: string
}

const known = new Map<string, string>()
const normPath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()

export function conversationKeyOf(session: ConversationSession | null | undefined): string {
  return workbenchSessionKey(session?.conversationFile ?? session?.sessionFile, session?.conversationId ?? session?.sessionId)
}

/** 活动会话变了：记下它的对话键。幂等，可以在渲染里直接调 */
export function rememberConversationKey(session: ConversationSession | null | undefined): void {
  if (!session || (!session.sessionId && !session.sessionFile)) return
  const key = conversationKeyOf(session)
  if (session.sessionId) known.set(`id:${session.sessionId}`, key)
  if (session.sessionFile) known.set(`path:${normPath(session.sessionFile)}`, key)
}

/** 分屏磁贴（只有 id 与路径）对应的工作区键 */
export function workspaceKeyFor(ref: { sessionId?: string; path?: string }): string {
  const hit = (ref.sessionId ? known.get(`id:${ref.sessionId}`) : undefined) ?? (ref.path ? known.get(`path:${normPath(ref.path)}`) : undefined)
  return hit ?? workbenchSessionKey(ref.path, ref.sessionId)
}
