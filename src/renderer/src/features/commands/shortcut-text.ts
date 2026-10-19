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
