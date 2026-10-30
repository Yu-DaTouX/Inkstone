import type { Lang } from '../../i18n'
import type { CommandPrefix } from './command-items'

export interface CommandText {
  paletteLabel: string
  placeholder: string
  footRun: string
  footPrefixes: string
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
  openSettings: string
  stopSession: string
  workspaceChanges: string
  workspaceTerminal: string
  workspaceFiles: string
  workspaceBrowser: string
  workspacePreview: string
  settingsPrefix: string
  settingsUsage: string
  roleUser: string
  roleAssistant: string
  roleBash: string
  helpRows: Record<CommandPrefix, string>
  messageHint: string
  empty: string
  sessionEmpty: string
  messageEmpty: string
  failed: string
  switchFailed: string
  messageNotFound: string
  activationFailed: string
  busy: string
  clear: string
}

const ZH: CommandText = {
  paletteLabel: '命令面板',
  placeholder: '搜索命令或会话…',
  footRun: '执行',
  footPrefixes: '搜索前缀',
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
  openSettings: '打开设置',
  stopSession: '停止当前会话',
  workspaceChanges: '工作区 · 改动',
  workspaceTerminal: '工作区 · 终端',
  workspaceFiles: '工作区 · 文件',
  workspaceBrowser: '工作区 · 浏览器',
  workspacePreview: '工作区 · 预览',
  settingsPrefix: '设置',
  settingsUsage: '本机用量',
  roleUser: '你',
  roleAssistant: '助手',
  roleBash: '命令',
  helpRows: {
    '>': '只看操作：新会话、侧栏、工作区、设置、主题',
    '@': '切换会话：按标题、项目或路径搜',
    '#': '搜索当前会话里的消息',
    '?': '显示这段前缀说明'
  },
  messageHint: '输入关键词搜索当前会话的消息',
  empty: '没有匹配的命令',
  sessionEmpty: '没有匹配的会话',
  messageEmpty: '当前会话里没有匹配的消息',
  failed: '操作失败',
  switchFailed: '会话切换未生效',
  messageNotFound: '这条消息已不在当前会话中',
  activationFailed: '会话未激活，工作区没有打开',
  busy: '执行中…',
  clear: '清除'
}

const EN: CommandText = {
  paletteLabel: 'Command palette',
  placeholder: 'Search commands or chats…',
  footRun: 'Run',
  footPrefixes: 'Search prefixes',
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
  openSettings: 'Open settings',
  stopSession: 'Stop current chat',
  workspaceChanges: 'Workspace · Changes',
  workspaceTerminal: 'Workspace · Terminal',
  workspaceFiles: 'Workspace · Files',
  workspaceBrowser: 'Workspace · Browser',
  workspacePreview: 'Workspace · Preview',
  settingsPrefix: 'Settings',
  settingsUsage: 'Usage',
  roleUser: 'You',
  roleAssistant: 'Assistant',
  roleBash: 'Command',
  helpRows: {
    '>': 'Actions only: new chat, sidebar, workspace, settings, theme',
    '@': 'Switch chats by title, project or path',
    '#': 'Search messages in the current chat',
    '?': 'Show this prefix help'
  },
  messageHint: 'Type keywords to search messages in this chat',
  empty: 'No matching commands',
  sessionEmpty: 'No matching chats',
  messageEmpty: 'No matching messages in this chat',
  failed: 'Action failed',
  switchFailed: 'Chat did not switch',
  messageNotFound: 'This message is no longer in the current chat',
  activationFailed: 'Chat is not active, so the workspace did not open',
  busy: 'Running…',
  clear: 'Clear'
}

export function commandText(lang: Lang): CommandText {
  return lang === 'en-US' ? EN : ZH
}
