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
  description: '简洁只显示操作分组；侧边推理把推理放在消息左侧并行显示；思考模式推理时展开，结束后收进工具条。每个会话可单独切换（Ctrl+O）。',
  views: { concise: '简洁', side: '侧边推理', thinking: '思考模式' },
  viewHints: {
    concise: '隐藏推理，连续操作合成一组',
    side: '推理显示在消息左侧，与正文并行',
    thinking: '推理时展开，历史推理收进工具条'
  },
  makeDefault: (view) => `将「${view}」设为默认`,
  switched: (view) => `显示方式：${view}`
}

const en: TranscriptViewText = {
  menu: 'Display',
  label: 'Conversation display',
  description: 'Concise shows grouped actions only; Side reasoning shows reasoning beside the reply; Thinking expands reasoning while it runs, then folds it into the tool strip. Each session can switch on its own (Ctrl+O).',
  views: { concise: 'Concise', side: 'Side reasoning', thinking: 'Thinking' },
  viewHints: {
    concise: 'Hide reasoning, group consecutive actions',
    side: 'Reasoning beside the reply, in parallel',
    thinking: 'Expanded while reasoning, past reasoning in the tool strip'
  },
  makeDefault: (view) => `Make ${view} the default`,
  switched: (view) => `Display: ${view}`
}

export function transcriptViewText(lang: Lang): TranscriptViewText {
  return lang === 'en-US' ? en : zh
}
