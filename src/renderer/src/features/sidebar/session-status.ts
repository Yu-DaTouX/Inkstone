import { isAuxTile, sameSplitSession, type SplitLayout, type SplitSessionRef } from '../../state/split-view'
import type { RunPhase } from '../../../../shared/runs'

export type SessionStatusKind = 'archived' | 'error' | 'awaiting' | 'running' | 'unread' | 'idle'

export interface PaneSession {
  id?: string
  path?: string
}

export function visiblePaneSessions(split: SplitLayout | null, narrow: boolean): SplitSessionRef[] {
  if (!split || split.tiles.length < 2) return []
  const shown = narrow ? [split.tiles[split.live]] : split.tiles
  return shown.filter((tile): tile is SplitSessionRef => !!tile && !isAuxTile(tile) && !!(tile.sessionId || tile.path))
}

export function paneShowsSession(panes: readonly SplitSessionRef[], target: PaneSession): boolean {
  if (!target.id && !target.path) return false
  return panes.some((pane) => !isAuxTile(pane) && sameSplitSession(pane, { sessionId: target.id, path: target.path }))
}

export interface SessionUnreadInput {
  unread: boolean
  paneSelected: boolean
}

export function sessionUnread({ unread, paneSelected }: SessionUnreadInput): boolean {
  return unread && !paneSelected
}

export interface SessionStatusInput {
  phase: RunPhase | null
  unread: boolean
  archived: boolean
  markedUnread?: boolean
}

export function sessionStatusKind({ phase, unread, archived, markedUnread }: SessionStatusInput): SessionStatusKind {
  if (archived) return 'archived'
  const kind = runPhaseKind(phase, unread)
  return kind === 'idle' && markedUnread ? 'unread' : kind
}

function runPhaseKind(phase: RunPhase | null, unread: boolean): SessionStatusKind {
  switch (phase?.kind) {
    case 'needs-you':
    case 'stalled':
      return 'awaiting'
    case 'running':
    case 'queued':
      return 'running'
    case 'failed':
      return 'error'
    case 'done':
      return unread ? 'unread' : 'idle'
    default:
      return 'idle'
  }
}

const LABELS: Record<SessionStatusKind, { zh: string; en: string }> = {
  archived: { zh: '已归档', en: 'Archived' },
  error: { zh: '出错了', en: 'Something went wrong' },
  awaiting: { zh: '等待输入', en: 'Awaiting input' },
  running: { zh: '正在运行', en: 'Running' },
  unread: { zh: '未读回复', en: 'Unread response' },
  idle: { zh: '空闲', en: 'Idle' }
}

export function sessionStatusLabel(kind: SessionStatusKind, lang: 'zh-CN' | 'en-US'): string {
  return lang === 'en-US' ? LABELS[kind].en : LABELS[kind].zh
}
