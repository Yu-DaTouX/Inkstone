import type { Lang } from '../../i18n'

export interface BrowserText {
  inactive: string
  foreignOwner: string
  notOpen: string
  open: string
  opening: string
  tabLabel: string
  viewportLabel: string
}

const ZH: BrowserText = {
  inactive: '先激活这条会话，才能使用内置浏览器。',
  foreignOwner: '内置浏览器当前归另一条会话；切回去或在这条会话里重新打开。',
  notOpen: '内置浏览器还没有打开。',
  open: '打开浏览器',
  opening: '正在打开…',
  tabLabel: '内置浏览器标签页',
  viewportLabel: '网页显示区域'
}

const EN: BrowserText = {
  inactive: 'Activate this conversation before using the built-in browser.',
  foreignOwner: 'The built-in browser belongs to another conversation; switch back or reopen it here.',
  notOpen: 'The built-in browser is not open.',
  open: 'Open browser',
  opening: 'Opening…',
  tabLabel: 'Built-in browser tabs',
  viewportLabel: 'Web page area'
}

export function browserText(lang: Lang): BrowserText {
  return lang === 'en-US' ? EN : ZH
}
