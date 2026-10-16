/**
 * 命令面板自己的短文案（中英）。
 *
 * 为什么不在两份 i18n JSON 里加键：那两份是共享热点，v3 尚未定稿，现在加键会给
 * v2 留下无用条目（与 `app/v3-text.ts` 同一口径）。面板定稿后再统一并入 i18n。
 */
import type { Lang } from '../../i18n'
import type { CommandPrefix } from './command-items'

export interface CommandText {
  paletteLabel: string
  placeholder: string
  prefixHint: string
  groupAction: string
  groupSession: string
  groupMessage: string
  groupHelp: string
  newSession: string
  focusSearch: string
  toggleSidebar: string
  toggleWorkspace: string
  themeToLight: string
  themeToDark: string
  openRuns: string
  openSettings: string
  openSideBySide: string
  stopSession: string
  workspaceChanges: string
  workspaceTerminal: string
  workspaceFiles: string
  workspaceBrowser: string
  workspacePreview: string
  settingsAppearance: string
  settingsModels: string
  settingsCapabilities: string
  settingsUsage: string
  roleUser: string
  roleAssistant: string
  roleBash: string
  helpRows: Record<CommandPrefix, string>
  messageHint: string
  empty: string
  failed: string
  switchFailed: string
  sideBySideNoPeer: string
  activationFailed: string
  busy: string
  clear: string
}

const ZH: CommandText = {
  paletteLabel: '命令面板',
  placeholder: '搜索命令，或用 > 操作 @ 会话 # 消息 ? 帮助…',
  prefixHint: '> 操作 · @ 会话 · # 消息 · ? 帮助',
  groupAction: '命令',
  groupSession: '会话',
  groupMessage: '消息',
  groupHelp: '帮助',
  newSession: '新建会话',
  focusSearch: '搜索侧栏',
  toggleSidebar: '展开或收起侧栏',
  toggleWorkspace: '展开或收起工作区',
  themeToLight: '切换到浅色主题',
  themeToDark: '切换到深色主题',
  openRuns: '运行总览',
  openSettings: '打开设置',
  openSideBySide: '并排打开',
  stopSession: '停止当前会话',
  workspaceChanges: '工作区 · 改动',
  workspaceTerminal: '工作区 · 终端',
  workspaceFiles: '工作区 · 文件',
  workspaceBrowser: '工作区 · 浏览器',
  workspacePreview: '工作区 · 预览',
  settingsAppearance: '设置 · 外观',
  settingsModels: '设置 · 模型与服务',
  settingsCapabilities: '设置 · 能力',
  settingsUsage: '设置 · 用量',
  roleUser: '你',
  roleAssistant: '助手',
  roleBash: '命令',
  helpRows: {
    '>': '只看操作：新会话、侧栏、工作区、设置、主题、运行总览',
    '@': '切换会话：按标题、项目或路径搜',
    '#': '搜索当前会话里的消息',
    '?': '显示这段前缀说明'
  },
  messageHint: '输入关键词搜索当前会话的消息',
  empty: '没有匹配的命令',
  failed: '操作失败',
  switchFailed: '会话切换未生效',
  sideBySideNoPeer: '没有可以并排显示的其他会话',
  activationFailed: '会话未激活，工作区没有打开',
  busy: '执行中…',
  clear: '清除'
}

const EN: CommandText = {
  paletteLabel: 'Command palette',
  placeholder: 'Search commands, or > actions @ chats # messages ? help…',
  prefixHint: '> actions · @ chats · # messages · ? help',
  groupAction: 'Commands',
  groupSession: 'Chats',
  groupMessage: 'Messages',
  groupHelp: 'Help',
  newSession: 'New chat',
  focusSearch: 'Search sidebar',
  toggleSidebar: 'Show or hide the sidebar',
  toggleWorkspace: 'Show or hide the workspace',
  themeToLight: 'Switch to light theme',
  themeToDark: 'Switch to dark theme',
  openRuns: 'Runs overview',
  openSettings: 'Open settings',
  openSideBySide: 'Open side by side',
  stopSession: 'Stop current chat',
  workspaceChanges: 'Workspace · Changes',
  workspaceTerminal: 'Workspace · Terminal',
  workspaceFiles: 'Workspace · Files',
  workspaceBrowser: 'Workspace · Browser',
  workspacePreview: 'Workspace · Preview',
  settingsAppearance: 'Settings · Appearance',
  settingsModels: 'Settings · Models & services',
  settingsCapabilities: 'Settings · Capabilities',
  settingsUsage: 'Settings · Usage',
  roleUser: 'You',
  roleAssistant: 'Assistant',
  roleBash: 'Command',
  helpRows: {
    '>': 'Actions only: new chat, sidebar, workspace, settings, theme, runs',
    '@': 'Switch chats by title, project or path',
    '#': 'Search messages in the current chat',
    '?': 'Show this prefix help'
  },
  messageHint: 'Type keywords to search messages in this chat',
  empty: 'No matching commands',
  failed: 'Action failed',
  switchFailed: 'Chat did not switch',
  sideBySideNoPeer: 'No other chat to show side by side',
  activationFailed: 'Chat is not active, so the workspace did not open',
  busy: 'Running…',
  clear: 'Clear'
}

export function commandText(lang: Lang): CommandText {
  return lang === 'en-US' ? EN : ZH
}
