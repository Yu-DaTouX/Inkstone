import type { Lang } from '../../i18n'

export interface ContextPaneText {
  title: string
  usage: string
  unknown: string
  unknownHint: string
  afterCompact: string
  occupancy: string
  occupancyLabels: Record<'tools' | 'files', string>
  items: string
  estimateNote: string
  compaction: string
  compactionNone: string
  openSettings: string
}

const ZH: ContextPaneText = {
  title: '上下文用量',
  usage: '当前会话',
  unknown: '—',
  unknownHint: '还没有可信的上下文总量；连上模型并收到一次回复后才显示占用。',
  afterCompact: '刚压缩过，等下一次用量回报。',
  occupancy: '文件与工具结果',
  occupancyLabels: { tools: '工具结果', files: '文件与图片' },
  items: '项',
  estimateNote: '分类与明细按可见消息估算，总量以上方 Agent 回报为准。',
  compaction: '压缩记录',
  compactionNone: '本次运行内还没有压缩记录。',
  openSettings: '打开裁剪与压缩设置'
}

const EN: ContextPaneText = {
  title: 'Context usage',
  usage: 'This session',
  unknown: '—',
  unknownHint: 'No trusted context total yet; it appears once a model reply reports usage.',
  afterCompact: 'Compacted recently; waiting for the next usage report.',
  occupancy: 'Files and tool results',
  occupancyLabels: { tools: 'Tool results', files: 'Files and images' },
  items: 'items',
  estimateNote: 'Categories and details are estimated from visible messages; the Agent total above is authoritative.',
  compaction: 'Compaction record',
  compactionNone: 'No compaction in this run yet.',
  openSettings: 'Open trim and compaction settings'
}

export function contextPaneText(lang: Lang): ContextPaneText {
  return lang === 'en-US' ? EN : ZH
}
