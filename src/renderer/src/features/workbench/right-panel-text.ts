import type { Lang } from '../../i18n'

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
  subagent: '子代理'
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
  subagent: 'Subagent'
}

export function rightPanelText(lang: Lang): RightPanelText {
  return lang === 'en-US' ? EN : ZH
}
