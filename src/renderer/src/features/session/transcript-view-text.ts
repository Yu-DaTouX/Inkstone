import type { Lang } from '../../i18n'
import type { TranscriptView } from './transcript-view-model'

interface TranscriptViewText {
  menu: string
  label: string
  description: string
  views: Record<TranscriptView, string>
  viewHints: Record<TranscriptView, string>
  makeDefault: (view: string) => string
  switched: (view: string) => string
}

const zh: TranscriptViewText = {
  menu: '显示方式',
  label: '对话显示方式',
  description: '思考进行时实时可见，结束后折叠进「过程」，展开即可回看；每个会话可按 Ctrl+O 单独切换显示方式。',
  views: { concise: '简洁', side: '侧边推理', thinking: '思考模式' },
  viewHints: {
    concise: '思考实时可见，结束后折叠进「过程」，可展开回看',
    side: '推理在正文左侧并排，窗口不够宽时放到正文上方',
    thinking: '「过程」默认展开，思考和操作按原顺序显示'
  },
  makeDefault: (view) => `将「${view}」设为默认`,
  switched: (view) => `显示方式：${view}`
}

const en: TranscriptViewText = {
  menu: 'Display',
  label: 'Conversation display',
  description: 'Reasoning is visible while it runs, then folds into Process when the turn ends; expand it to read again. Switch per session with Ctrl+O.',
  views: { concise: 'Concise', side: 'Side reasoning', thinking: 'Thinking' },
  viewHints: {
    concise: 'Reasoning visible while it runs, then folded into Process',
    side: 'Reasoning left of the reply, above it when too narrow',
    thinking: 'Process starts expanded, in original order'
  },
  makeDefault: (view) => `Make ${view} the default`,
  switched: (view) => `Display: ${view}`
}

export function transcriptViewText(lang: Lang): TranscriptViewText {
  return lang === 'en-US' ? en : zh
}
