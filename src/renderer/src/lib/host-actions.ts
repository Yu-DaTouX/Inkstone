import type { TFunc } from '../i18n'

export type HostT = TFunc

export type ShortcutNoteGroup = 'input' | 'approval' | 'terminal'

export interface ShortcutNote {
  labelKey: string
  keys?: string[]
  noteKey?: string
}

export const SHORTCUT_NOTE_GROUPS: { id: ShortcutNoteGroup; rows: ShortcutNote[] }[] = [
  {
    id: 'input',
    rows: [
      { labelKey: 'sheet.inputSend', noteKey: 'sheet.inputSendNote' },
      { labelKey: 'sheet.inputNewline', keys: ['Shift', 'Enter'] },
      { labelKey: 'sheet.inputSendForce', keys: ['Ctrl', 'Enter'] },
      { labelKey: 'sheet.inputMenu', keys: ['↑', '↓'] },
      { labelKey: 'sheet.inputComplete', keys: ['Tab'] },
      { labelKey: 'sheet.inputCloseMenu', keys: ['Esc'] },
      { labelKey: 'sheet.inputLong', keys: ['↑', '↑'], noteKey: 'sheet.inputLongNote' },
      { labelKey: 'sheet.inputStop', keys: ['Esc'], noteKey: 'sheet.inputStopNote' },
      { labelKey: 'sheet.inputSteer', keys: ['Enter'], noteKey: 'sheet.inputSteerNote' },
      { labelKey: 'sheet.inputQueue', keys: ['Ctrl', 'Q'], noteKey: 'sheet.inputQueueNote' }
    ]
  },
  {
    id: 'approval',
    rows: [
      { labelKey: 'sheet.approvalConfirm', keys: ['Enter'] },
      { labelKey: 'sheet.approvalCancel', keys: ['Esc'] },
      { labelKey: 'sheet.approvalMove', keys: ['Tab', 'Shift+Tab'] },
      { labelKey: 'sheet.approvalFocus', noteKey: 'sheet.approvalFocusNote' }
    ]
  },
  {
    id: 'terminal',
    rows: [
      { labelKey: 'sheet.terminalYield', noteKey: 'sheet.terminalYieldNote' },
      { labelKey: 'sheet.terminalInterrupt', keys: ['Ctrl', 'C'] }
    ]
  }
]
