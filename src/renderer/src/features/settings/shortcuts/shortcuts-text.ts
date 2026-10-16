/**
 * 「设置 → 快捷键」分区自己的短文案（WP-25b 余项）。
 *
 * 只服务这一个分区：外壳与侧栏的共享文案在 `app/v3-text.ts`，其余设置分区在
 * `features/settings/settings-text.ts`。放在本目录是为了让快捷键改绑的内容
 * 与逻辑、样式一起独立演进，不挤进共享文案表。中英两语同键同占位符。
 */
import type { Lang } from '../../../i18n'

export interface ShortcutsText {
  /** 分区顶部说明：哪些能改、怎么改。 */
  note: string
  columnAction: string
  columnKeys: string
  columnState: string
  columnActions: string
  fixed: string
  rebindable: string
  modified: string
  recording: string
  restoreDefault: string
  restoreAll: string
  conflictNone: string
  conflictFound: string
  conflictWith: string
  needModifier: string
  emptyBinding: string
}

const zh: ShortcutsText = {
  note: '点快捷键即可录制新键位：按下组合键生效，Esc 取消。终端会让键的 Ctrl+K / Ctrl+B / Ctrl+J / Ctrl+L / Ctrl+Shift+C 以及 Esc、确认卡的 Alt+Y / Alt+N 保持固定，不在可改范围。',
  columnAction: '作用',
  columnKeys: '快捷键',
  columnState: '改键',
  columnActions: '操作',
  fixed: '固定',
  rebindable: '可改',
  modified: '已改',
  recording: '按下新键位…',
  restoreDefault: '恢复默认',
  restoreAll: '全部恢复默认',
  conflictNone: '没有重复键位。',
  conflictFound: '检测到重复键位：{list}',
  conflictWith: '与「{name}」冲突，换一个组合键。',
  needModifier: '请带上 Ctrl / Alt / Shift，或用 F1–F24。',
  emptyBinding: '没有收到可用按键，请重按。'
}

const en: ShortcutsText = {
  note: 'Click a shortcut to record a new one: press the combination to apply, Esc to cancel. Ctrl+K / Ctrl+B / Ctrl+J / Ctrl+L / Ctrl+Shift+C (yielded to the terminal), Esc, and the approval card’s Alt+Y / Alt+N stay fixed and are not rebindable.',
  columnAction: 'Action',
  columnKeys: 'Keys',
  columnState: 'Rebind',
  columnActions: 'Actions',
  fixed: 'Fixed',
  rebindable: 'Editable',
  modified: 'Changed',
  recording: 'Press new keys…',
  restoreDefault: 'Reset',
  restoreAll: 'Reset all',
  conflictNone: 'No duplicate bindings.',
  conflictFound: 'Duplicate bindings: {list}',
  conflictWith: 'Conflicts with “{name}”; pick another combination.',
  needModifier: 'Include Ctrl / Alt / Shift, or use F1–F24.',
  emptyBinding: 'No usable key was received; press again.'
}

export function shortcutsText(lang: Lang): ShortcutsText {
  return lang === 'en-US' ? en : zh
}
