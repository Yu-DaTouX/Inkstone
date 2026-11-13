import type { Lang } from '../../../i18n'

export interface ShortcutsText {
  note: string
  composerTitle: string
  composerNote: string
  fixed: string
  or: string
  modified: string
  recording: string
  restoreDefault: string
  restoreAll: string
  conflictFound: string
  conflictWith: string
  needModifier: string
  emptyBinding: string
}

const zh: ShortcutsText = {
  note: '点快捷键录制新键位，Esc 取消。',
  composerTitle: '输入框',
  composerNote: '运行中 Enter 插话，Ctrl+Q 或 Alt+Enter 排队；固定不可改。',
  fixed: '固定',
  or: '或',
  modified: '已改',
  recording: '按下新键位…',
  restoreDefault: '恢复默认',
  restoreAll: '全部恢复默认',
  conflictFound: '检测到重复键位：{list}',
  conflictWith: '与「{name}」冲突，换一个组合键。',
  needModifier: '请带上 Ctrl / Alt / Shift，或用 F1–F24。',
  emptyBinding: '没有收到可用按键，请重按。'
}

const en: ShortcutsText = {
  note: 'Click a shortcut to record; Esc cancels.',
  composerTitle: 'Composer',
  composerNote: 'While running: Enter steers, Ctrl+Q or Alt+Enter queues; fixed.',
  fixed: 'Fixed',
  or: 'or',
  modified: 'Changed',
  recording: 'Press new keys…',
  restoreDefault: 'Reset',
  restoreAll: 'Reset all',
  conflictFound: 'Duplicate bindings: {list}',
  conflictWith: 'Conflicts with “{name}”; pick another combination.',
  needModifier: 'Include Ctrl / Alt / Shift, or use F1–F24.',
  emptyBinding: 'No usable key was received; press again.'
}

export function shortcutsText(lang: Lang): ShortcutsText {
  return lang === 'en-US' ? en : zh
}
