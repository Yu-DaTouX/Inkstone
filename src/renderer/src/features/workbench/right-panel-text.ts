import type { Lang } from '../../i18n'

export type PanelUnavailableReason =
  | 'no-session'
  | 'inactive'
  | 'no-repo'
  | 'no-github'
  | 'no-gh-auth'
  | 'no-device'
  | 'no-sdk'
  | 'no-native-session'

export interface RightPanelText {
  panel: string
  tabs: string
  newTab: string
  closeTab: (name: string) => string
  close: string
  closeOthers: string
  closeRight: string
  closeAll: string
  maximize: string
  restore: string
  hidePanel: string
  resize: string
  launcherTitle: string
  openInOwnTab: (name: string) => string
  tabMenu: (name: string) => string
  overview: string
  pullRequest: (n: number) => string
  file: string
  subagent: string
  copyPath: string
  reopenPanel: string
  deviceHint: string
  unavailable: Record<PanelUnavailableReason, string>
}

const ZH: RightPanelText = {
  panel: '右侧面板',
  tabs: '面板标签',
  newTab: '新建标签',
  closeTab: (name) => `关闭「${name}」`,
  close: '关闭',
  closeOthers: '关闭其他标签',
  closeRight: '关闭右侧标签',
  closeAll: '关闭全部标签',
  maximize: '最大化面板',
  restore: '还原面板',
  hidePanel: '收起右侧面板',
  resize: '调整右侧面板宽度',
  launcherTitle: '打开一个面板',
  openInOwnTab: (name) => `在单独标签打开「${name}」`,
  tabMenu: (name) => `「${name}」标签操作`,
  overview: '概览',
  pullRequest: (n) => `#${n}`,
  file: '文件',
  subagent: '子代理',
  copyPath: '复制路径',
  reopenPanel: '重新打开面板',
  deviceHint: '观看 Android 模拟器画面。',
  unavailable: {
    'no-session': '先打开一个会话或项目。',
    inactive: '仅在这个会话激活后可用。',
    'no-repo': '仅 Git 仓库可用。',
    'no-github': '需要先安装 GitHub CLI（gh）。',
    'no-gh-auth': '需要先登录 GitHub。',
    'no-device': '没有可用的模拟器或设备。',
    'no-sdk': '需要先安装 Android SDK。',
    'no-native-session': '需要可用的本机会话服务。'
  }
}

const EN: RightPanelText = {
  panel: 'Right panel',
  tabs: 'Panel tabs',
  newTab: 'New tab',
  closeTab: (name) => `Close ${name}`,
  close: 'Close',
  closeOthers: 'Close other tabs',
  closeRight: 'Close tabs to the right',
  closeAll: 'Close all tabs',
  maximize: 'Maximize panel',
  restore: 'Restore panel',
  hidePanel: 'Hide right panel',
  resize: 'Resize right panel',
  launcherTitle: 'Open a surface',
  openInOwnTab: (name) => `Open ${name} in its own tab`,
  tabMenu: (name) => `${name} tab actions`,
  overview: 'Overview',
  pullRequest: (n) => `#${n}`,
  file: 'File',
  subagent: 'Subagent',
  copyPath: 'Copy path',
  reopenPanel: 'Reopen panel',
  deviceHint: 'Watch an Android Emulator.',
  unavailable: {
    'no-session': 'Open a session or project first.',
    inactive: 'Only available once this session is active.',
    'no-repo': 'Available for Git repositories only.',
    'no-github': 'Install the GitHub CLI (gh) first.',
    'no-gh-auth': 'Sign in to GitHub first.',
    'no-device': 'No emulator or device available.',
    'no-sdk': 'Install the Android SDK first.',
    'no-native-session': 'The local session service is unavailable.'
  }
}

export function rightPanelText(lang: Lang): RightPanelText {
  return lang === 'en-US' ? EN : ZH
}
