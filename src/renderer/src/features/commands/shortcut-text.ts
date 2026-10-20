import type { Lang } from '../../i18n'
import type { ShortcutId } from '../../app/shortcuts'

export interface ShortcutText {
  title: string
  hint: string
  close: string
  groups: {
    global: string
    input: string
    approval: string
    terminal: string
  }
  purposes: Record<ShortcutId, string>
  approval: {
    allow: string
    deny: string
  }
}

const ZH: ShortcutText = {
  title: '快捷键',
  hint: '只读 · 按 Esc 关闭',
  close: '关闭',
  groups: {
    global: '全局',
    input: '输入框',
    approval: '审批',
    terminal: '终端'
  },
  purposes: {
    commandPalette: '命令面板',
    newSession: '新会话',
    toggleSidebar: '展开或收起侧栏',
    toggleWorkspace: '展开或收起工作区',
    openSettings: '打开设置',
    shortcutSheet: '打开快捷键表',
    goBack: '返回上一处',
    stopRun: '停止当前运行',
    focusComposer: '聚焦输入框',
    copyLastReply: '复制上一条回复',
    openTerminal: '打开终端',
    workspaceTab1: '打开改动页签',
    workspaceTab2: '打开终端页签',
    workspaceTab3: '打开文件页签',
    workspaceTab4: '打开浏览器页签',
    workspaceTab5: '打开预览页签',
    workspaceTab6: '打开上下文页签',
    workspaceClosePane: '关闭当前面板',
    workspaceToggleMaximize: '最大化或还原当前面板',
    splitFocusNext: '分屏：切到下一块',
    splitFocusPrevious: '分屏：切到上一块',
    splitNewRight: '分屏：在右侧打开最近的会话',
    splitNewBelow: '分屏：在下方打开最近的会话',
    splitClose: '分屏：关闭当前块',
    splitFocusLeft: '分屏：切到左边一块',
    splitFocusRight: '分屏：切到右边一块',
    splitFocusUp: '分屏：切到上面一块',
    splitFocusDown: '分屏：切到下面一块',
    cycleModel: '下一个模型',
    cycleModelBack: '上一个模型',
    cycleThinking: '切换思考档位',
    quickAsk: '快速提问'
  },
  approval: {
    allow: '允许一次',
    deny: '拒绝'
  }
}

const EN: ShortcutText = {
  title: 'Keyboard shortcuts',
  hint: 'Read-only · press Esc to close',
  close: 'Close',
  groups: {
    global: 'Global',
    input: 'Composer',
    approval: 'Approval',
    terminal: 'Terminal'
  },
  purposes: {
    commandPalette: 'Command palette',
    newSession: 'New chat',
    toggleSidebar: 'Show or hide the sidebar',
    toggleWorkspace: 'Show or hide the workspace',
    openSettings: 'Open settings',
    shortcutSheet: 'Open the shortcut sheet',
    goBack: 'Go back',
    stopRun: 'Stop the current run',
    focusComposer: 'Focus the composer',
    copyLastReply: 'Copy the last reply',
    openTerminal: 'Open the terminal',
    workspaceTab1: 'Open the changes tab',
    workspaceTab2: 'Open the terminal tab',
    workspaceTab3: 'Open the files tab',
    workspaceTab4: 'Open the browser tab',
    workspaceTab5: 'Open the preview tab',
    workspaceTab6: 'Open the context tab',
    workspaceClosePane: 'Close the focused panel',
    workspaceToggleMaximize: 'Maximize or restore the focused panel',
    splitFocusNext: 'Split view: focus next pane',
    splitFocusPrevious: 'Split view: focus previous pane',
    splitNewRight: 'Split view: open a recent session on the right',
    splitNewBelow: 'Split view: open a recent session below',
    splitClose: 'Split view: close the focused pane',
    splitFocusLeft: 'Split view: focus the pane on the left',
    splitFocusRight: 'Split view: focus the pane on the right',
    splitFocusUp: 'Split view: focus the pane above',
    splitFocusDown: 'Split view: focus the pane below',
    cycleModel: 'Next model',
    cycleModelBack: 'Previous model',
    cycleThinking: 'Cycle thinking level',
    quickAsk: 'Quick ask'
  },
  approval: {
    allow: 'Allow once',
    deny: 'Deny'
  }
}

export function shortcutText(lang: Lang): ShortcutText {
  return lang === 'en-US' ? EN : ZH
}
