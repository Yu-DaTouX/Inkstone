import type { RunPhase } from '../../../../shared/runs'

export type SessionStatusKind = 'archived' | 'error' | 'awaiting' | 'running' | 'unread' | 'idle'

export interface SessionStatusInput {
  phase: RunPhase | null
  unread: boolean
  archived: boolean
}

export function sessionStatusKind({ phase, unread, archived }: SessionStatusInput): SessionStatusKind {
  if (archived) return 'archived'
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
