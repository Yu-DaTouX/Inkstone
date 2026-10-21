import type { Lang } from '../../i18n'
import type { TranscriptView } from './transcript-view-model'

export interface TranscriptViewText {
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
  description: '简洁只显示操作分组；思考显示推理过程；详细默认展开全部推理和操作。每个会话可单独切换（Ctrl+O）。',
  views: { concise: '简洁', thinking: '思考', verbose: '详细' },
  viewHints: {
    concise: '隐藏推理，连续操作合成一组',
    thinking: '显示推理过程，操作默认折叠',
    verbose: '推理和操作全部展开'
  },
  makeDefault: (view) => `将「${view}」设为默认`,
  switched: (view) => `显示方式：${view}`
}

const en: TranscriptViewText = {
  menu: 'Display',
  label: 'Conversation display',
  description: 'Concise shows grouped actions only; Thinking shows reasoning; Verbose expands all reasoning and actions. Each session can switch on its own (Ctrl+O).',
  views: { concise: 'Concise', thinking: 'Thinking', verbose: 'Verbose' },
  viewHints: {
    concise: 'Hide reasoning, group consecutive actions',
    thinking: 'Show reasoning, actions collapsed',
    verbose: 'Expand all reasoning and actions'
  },
  makeDefault: (view) => `Make ${view} the default`,
  switched: (view) => `Display: ${view}`
}

export function transcriptViewText(lang: Lang): TranscriptViewText {
  return lang === 'en-US' ? en : zh
}
