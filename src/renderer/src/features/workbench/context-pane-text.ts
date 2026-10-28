import type { Lang } from '../../i18n'
import type { AutoCompactDistance } from './context-pane-view'

export interface ContextPaneText {
  title: string
  usage: string
  unknown: string
  unknownHint: string
  afterCompact: string
  distance: (kind: AutoCompactDistance['kind'], remaining: string) => string
  topTools: string
  jumpTo: (name: string) => string
  locateFailed: string
  estimateNote: string
  compaction: string
  compactionNone: string
  compactionTokens: (before: string, after: string, percent: number | null) => string
  compactionBefore: (before: string) => string
  compactionSummary: (tokens: string) => string
  more: (count: number) => string
  less: string
  compactNow: string
  compacting: string
  compactBusy: string
  compactFailed: string
  openSettings: string
}

const ZH: ContextPaneText = {
  title: '上下文用量',
  usage: '当前会话',
  unknown: '—',
  unknownHint: '还没有可信的上下文总量；连上模型并收到一次回复后才显示占用。',
  afterCompact: '刚压缩过，等下一次用量回报。',
  distance: (kind, remaining) =>
    kind === 'off'
      ? '自动压缩已关闭，模型窗口用满前不会自动压缩。'
      : kind === 'reached'
        ? '已到自动压缩上限，本轮结束后会压缩。'
        : kind === 'limit'
          ? `再用 ${remaining} 触发自动压缩。`
          : `距模型窗口用满还剩 ${remaining}，接近用满时自动压缩。`,
  topTools: '占用最多的工具结果',
  jumpTo: (name) => `在对话中定位 ${name}`,
  locateFailed: '对话里找不到这一轮，它可能已不在当前会话中。',
  estimateNote: '分类与明细按可见消息估算，总量以上方 Agent 回报为准。',
  compaction: '压缩记录',
  compactionNone: '这条会话还没有压缩过。',
  compactionTokens: (before, after, percent) => `${before} → ${after}${percent === null ? '' : ` · 回收 ${percent}%`}`,
  compactionBefore: (before) => `压缩前 ${before}`,
  compactionSummary: (tokens) => `摘要约 ${tokens}`,
  more: (count) => `更多（${count}）`,
  less: '收起',
  compactNow: '立即压缩',
  compacting: '正在压缩…',
  compactBusy: '会话运行中，结束后再压缩。',
  compactFailed: '压缩失败',
  openSettings: '打开裁剪与压缩设置'
}

const EN: ContextPaneText = {
  title: 'Context usage',
  usage: 'This session',
  unknown: '—',
  unknownHint: 'No trusted context total yet; it appears once a model reply reports usage.',
  afterCompact: 'Compacted recently; waiting for the next usage report.',
  distance: (kind, remaining) =>
    kind === 'off'
      ? 'Auto-compaction is off; nothing compacts until the model window is full.'
      : kind === 'reached'
        ? 'At the auto-compact limit; compaction runs when this turn ends.'
        : kind === 'limit'
          ? `${remaining} more until auto-compaction.`
          : `${remaining} left in the model window; auto-compaction runs when it is nearly full.`,
  topTools: 'Largest tool results',
  jumpTo: (name) => `Show ${name} in the conversation`,
  locateFailed: 'That turn is no longer in the current chat.',
  estimateNote: 'Categories and details are estimated from visible messages; the Agent total above is authoritative.',
  compaction: 'Compaction history',
  compactionNone: 'This session has not been compacted yet.',
  compactionTokens: (before, after, percent) => `${before} → ${after}${percent === null ? '' : ` · reclaimed ${percent}%`}`,
  compactionBefore: (before) => `${before} before`,
  compactionSummary: (tokens) => `summary ~${tokens}`,
  more: (count) => `More (${count})`,
  less: 'Show less',
  compactNow: 'Compact now',
  compacting: 'Compacting…',
  compactBusy: 'The session is running; compact after it finishes.',
  compactFailed: 'Compaction failed',
  openSettings: 'Open trim and compaction settings'
}

export function contextPaneText(lang: Lang): ContextPaneText {
  return lang === 'en-US' ? EN : ZH
}
