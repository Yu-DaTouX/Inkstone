import type { HandoffView } from './handoff'

export type HandoffNoticeTone = 'working' | 'done' | 'failed'

export interface HandoffNotice {
  tone: HandoffNoticeTone
  reason: string | null
  canRetry: boolean
}

const SUCCESS_OUTCOMES = new Set(['package-ready', 'ok', 'resume-confirmed', 'state-inherited'])

const FAILED_OUTCOMES = new Set([
  'request-write-failed',
  'arm-threw',
  'failed',
  'unparsable',
  'incomplete',
  'persist-failed',
  'abandoned',
  'halted',
  'threw',
  'unconfirmed',
  'repeat-guard-failed'
])

const FAILED_ABANDON_REASONS = new Set(['timeout'])

function isFailureEvent(event: { outcome: string; reason?: string | null }): boolean {
  if (!FAILED_OUTCOMES.has(event.outcome)) return false
  if (event.outcome === 'abandoned') return FAILED_ABANDON_REASONS.has(String(event.reason ?? ''))
  return true
}

export const HANDOFF_DONE_WINDOW_MS = 60_000

export function handoffNoticeOf(
  view: HandoffView | null | undefined,
  now: number,
  doneWindowMs = HANDOFF_DONE_WINDOW_MS
): HandoffNotice | null {
  if (!view) return null
  if (view.pending) return { tone: 'working', reason: null, canRetry: false }

  const events = view.events ?? []
  let lastFailureAt: number | null = null
  let lastFailureReason: string | null = null
  let lastSuccessAt: number | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (lastSuccessAt === null && SUCCESS_OUTCOMES.has(event.outcome)) lastSuccessAt = event.at
    if (lastFailureAt === null && isFailureEvent(event)) {
      lastFailureAt = event.at
      lastFailureReason = event.reason ?? event.outcome
    }
    if (lastFailureAt !== null && lastSuccessAt !== null) break
  }

  if (lastFailureAt !== null && (lastSuccessAt === null || lastFailureAt > lastSuccessAt)) {
    return { tone: 'failed', reason: lastFailureReason, canRetry: true }
  }
  if (lastSuccessAt !== null && now - lastSuccessAt <= doneWindowMs) {
    return { tone: 'done', reason: null, canRetry: false }
  }
  return null
}

const REASON_TEXT: Record<string, string> = {
  'no-json-object': '模型未返回完整交接格式，仍保留原会话',
  truncated: '交接包太长，输出被长度限制切断（已保留原会话）',
  'invalid-json': '交接内容格式错误，仍保留原会话',
  empty: '模型未返回交接内容',
  'missing-content-fields': '交接内容字段不完整',
  'missing-continuation': '交接内容缺少剩余工作或下一步',
  'below-threshold': '这个片段还没有压够次数',
  'no-goal': '这条会话还没有在推进的目标',
  'goal-not-active': '目标已经不在推进阶段',
  'not-autonomous': '当前不是自主档',
  busy: '还有后台工作没结束',
  'request-write-failed': '生成请求没能写下去',
  timeout: '整理超时（已放弃这一次，会话没有受影响）',
  'arm-threw': '整理过程出错',
  failed: '模型没能写出交接包',
  unparsable: '交接包格式不对，已丢弃',
  incomplete: '交接包缺必填内容，已丢弃',
  'persist-failed': '交接包没能落盘',
  'operation-replaced': '已经有更新的一次整理在进行',
  'runner-gone': '原来的运行实例已经不在了',
  'not-idle': '实例又开始工作了（等它停下来再继续）',
  'source-session-changed': '期间切到了别的会话',
  'goal-changed': '期间目标变了',
  'mode-changed': '期间档位改了',
  'source-watermark-moved': '期间你说了话（沿用你最新的输入，没有换片段）',
  'repeat-guard-failed': '重复动作计数没能记上',
  unconfirmed: '续接消息发出去了，但还没在会话里确认',
  'manual-retry': '你点了重试',
  halted: '交接事务停在中途（已保留原会话）'
}

export function handoffReasonText(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string' || !reason.trim()) return null
  const key = reason.trim()
  return REASON_TEXT[key] ?? key
}
