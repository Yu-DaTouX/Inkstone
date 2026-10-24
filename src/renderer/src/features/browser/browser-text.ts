import type { Lang } from '../../i18n'
import type { BrowserSiteAddResult } from '../../../../shared/ipc'

export interface BrowserText {
  inactive: string
  foreignOwner: string
  notOpen: string
  open: string
  opening: string
  tabLabel: string
  viewportLabel: string
  siteAskTitle: string
  siteAskLead(origin: string): string
  siteAskDetail: string
  siteAskDeny: string
  siteAskAllow: string
  sitesManage: string
  sitesTitle: string
  sitesDescription: string
  sitesAddLabel: string
  sitesAddPlaceholder: string
  sitesAdd: string
  sitesEmpty: string
  sitesRemove(label: string): string
  sitesClear: string
  sitesDone: string
  sitesError(result: BrowserSiteAddResult): string
  sitesLoadError: string
}

const ZH: BrowserText = {
  inactive: '先激活这条会话，才能使用内置浏览器。',
  foreignOwner: '内置浏览器当前归另一条会话；切回去或在这条会话里重新打开。',
  notOpen: '内置浏览器还没有打开。',
  open: '打开浏览器',
  opening: '正在打开…',
  tabLabel: '内置浏览器标签页',
  viewportLabel: '网页显示区域',
  siteAskTitle: '允许打开网站',
  siteAskLead: (origin) => `内置浏览器要打开 ${origin}。`,
  siteAskDetail: '允许后这个站点会被记住，以后在浏览器里打开不再询问；删除放行站点后会重新询问。不允许只取消本次打开，下次点击仍可重新选择。',
  siteAskDeny: '本次不打开',
  siteAskAllow: '允许并记住',
  sitesManage: '管理放行站点',
  sitesTitle: '放行的站点',
  sitesDescription: '这些站点在内置浏览器里打开时不再询问。删除后，下次由页面跳转或弹窗打开时会重新询问。',
  sitesAddLabel: '添加网址',
  sitesAddPlaceholder: 'example.com',
  sitesAdd: '添加',
  sitesEmpty: '还没有放行的站点。',
  sitesRemove: (label) => `移除 ${label}`,
  sitesClear: '全部清除',
  sitesDone: '完成',
  sitesError: (result) =>
    result === 'invalid'
      ? '请输入有效的网址。'
      : result === 'exists'
        ? '这个站点已经在列表里。'
        : result === 'blocked'
          ? '这个站点受安全限制，不能添加。'
          : '放行站点已达上限，无法添加更多。',
  sitesLoadError: '读取放行站点失败。'
}

const EN: BrowserText = {
  inactive: 'Activate this conversation before using the built-in browser.',
  foreignOwner: 'The built-in browser belongs to another conversation; switch back or reopen it here.',
  notOpen: 'The built-in browser is not open.',
  open: 'Open browser',
  opening: 'Opening…',
  tabLabel: 'Built-in browser tabs',
  viewportLabel: 'Web page area',
  siteAskTitle: 'Allow this site',
  siteAskLead: (origin) => `The built-in browser wants to open ${origin}.`,
  siteAskDetail:
    'Allowing remembers this site, so the browser will not ask again. Removing it from allowed sites makes the browser ask again. Denying only cancels this attempt; click again to choose.',
  siteAskDeny: 'Not this time',
  siteAskAllow: 'Allow and remember',
  sitesManage: 'Manage allowed sites',
  sitesTitle: 'Allowed sites',
  sitesDescription:
    'The built-in browser opens these sites without asking. Remove one and the next page navigation or popup asks again.',
  sitesAddLabel: 'Add URL',
  sitesAddPlaceholder: 'example.com',
  sitesAdd: 'Add',
  sitesEmpty: 'No allowed sites yet.',
  sitesRemove: (label) => `Remove ${label}`,
  sitesClear: 'Clear all',
  sitesDone: 'Done',
  sitesError: (result) =>
    result === 'invalid'
      ? 'Enter a valid web address.'
      : result === 'exists'
        ? 'That site is already allowed.'
        : result === 'blocked'
          ? 'This site cannot be added because of safety restrictions.'
          : 'The allowed sites list is full.',
  sitesLoadError: 'Could not read the allowed sites.'
}

export function browserText(lang: Lang): BrowserText {
  return lang === 'en-US' ? EN : ZH
}
