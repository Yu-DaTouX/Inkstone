import type { Lang } from '../../i18n'
import type { BrowserLoginImportStatus, BrowserSiteAddResult } from '../../../../shared/ipc'

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
  importLogin: string
  importing: string
  importHint: string
  importWaiting: string
  importCancel: string
  importDismiss: string
  importDone(copied: number, failed: number, skipped: number): string
  importFailed: string
  importError(reason: BrowserLoginImportStatus['error']): string
  startAddress: string
  collapseTabs: string
  resizeTabs: string
  viewport: string
  viewportNames: Record<'responsive' | 'mobile' | 'tablet' | 'desktop', string>
  expandTabs: string
  searchEngine: string
  searchEngineCustom: string
  searchEngineCustomLabel: string
  searchEngineInvalid: string
  save: string
  cancel: string
}

const ZH: BrowserText = {
  inactive: '先激活这条会话，才能使用内置浏览器。',
  foreignOwner: '内置浏览器当前归另一条会话；切回去或在这条会话里重新打开。',
  notOpen: '内置浏览器还没有打开。',
  open: '打开浏览器',
  opening: '正在打开…',
  tabLabel: '内置浏览器标签页',
  viewportLabel: '网页显示区域',
  siteAskTitle: '允许加载远程图片',
  siteAskLead: (origin) => `这张图片来自 ${origin}。`,
  siteAskDetail: '允许后记住这个站点，可在「设置 › 权限」里管理；不允许只取消本次加载。',
  siteAskDeny: '本次不加载',
  siteAskAllow: '允许并记住',
  sitesTitle: '远程图片白名单',
  sitesDescription: '来自这些站点的图片会直接加载，移除后再次加载会重新询问。',
  sitesAddLabel: '添加网址',
  sitesAddPlaceholder: 'example.com',
  sitesAdd: '添加',
  sitesEmpty: '还没有允许的站点。',
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
          : '允许列表已达上限，无法添加更多。',
  sitesLoadError: '读取允许列表失败。',
  importLogin: '一键导入登录态',
  importing: '正在导入登录态…',
  importHint: '从默认 Chrome / Edge 当前档案导入全部网站的登录 Cookie，覆盖同名旧值。首次需安装并授权扩展；不含密码和其他设置。',
  importWaiting: '等待来源浏览器连接；首次请按来源页面提示安装扩展。再次点击可取消。',
  importCancel: '取消导入',
  importDismiss: '关闭提示',
  importDone: (copied, failed, skipped) => `已导入 ${copied} 条 Cookie，失败 ${failed} 条，跳过 ${skipped} 条。刷新网页后检查登录状态；部分网站仍需重新登录。`,
  importFailed: '登录态导入未完成，请检查来源浏览器的扩展并重试。',
  importError: (reason) => ({
    connection_failed: '与来源浏览器的连接中断或未收到结果，请重新发起导入。',
    pairing_expired: '本次配对已结束，请重新发起导入。',
    read_failed: '来源浏览器读取 Cookie 失败，请确认扩展已获得全部网站访问权限。',
    invalid_payload: 'Cookie 数据无法解析，请更新砚和导入扩展后重试。',
    import_failed: '未能完成 Cookie 写入，请重新发起导入。'
  })[reason ?? 'import_failed'],
  startAddress: '搜索或输入网址',
  collapseTabs: '取消固定，悬停时展开',
  resizeTabs: '调整标签栏宽度',
  viewport: '视口尺寸',
  viewportNames: { responsive: '自适应面板', mobile: '手机 375×812', tablet: '平板 768×1024', desktop: '桌面 1280×800' },
  expandTabs: '固定展开标签栏',
  searchEngine: '搜索引擎',
  searchEngineCustom: '自定义…',
  searchEngineCustomLabel: '搜索网址（%s 代表关键词）',
  searchEngineInvalid: '需要 http(s) 网址，并包含 %s',
  save: '保存',
  cancel: '取消'
}

const EN: BrowserText = {
  inactive: 'Activate this conversation before using the built-in browser.',
  foreignOwner: 'The built-in browser belongs to another conversation; switch back or reopen it here.',
  notOpen: 'The built-in browser is not open.',
  open: 'Open browser',
  opening: 'Opening…',
  tabLabel: 'Built-in browser tabs',
  viewportLabel: 'Web page area',
  siteAskTitle: 'Load remote image',
  siteAskLead: (origin) => `This image is from ${origin}.`,
  siteAskDetail:
    'Allowing remembers this site; manage the list in Settings › Permissions. Denying only cancels this load.',
  siteAskDeny: 'Not now',
  siteAskAllow: 'Allow and remember',
  sitesTitle: 'Remote image allowlist',
  sitesDescription:
    'Images from these sites load directly; removing one makes its images ask again.',
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
          : 'The allow list is full.',
  sitesLoadError: 'Could not read the allow list.',
  importLogin: 'Import sign-ins',
  importing: 'Importing sign-ins…',
  importHint: 'Import all website cookies from the current profile in your default Chrome / Edge, replacing matching cookies. First use requires the extension. Passwords and other settings are not included.',
  importWaiting: 'Waiting for the source browser. Install the extension there on first use. Click again to cancel.',
  importCancel: 'Cancel import',
  importDismiss: 'Dismiss notification',
  importDone: (copied, failed, skipped) => `Imported ${copied} cookies; ${failed} failed, ${skipped} skipped. Reload and check the website; some sites may require signing in again.`,
  importFailed: 'Import did not complete. Check the source browser extension and try again.',
  importError: (reason) => ({
    connection_failed: 'The source connection was interrupted or no result arrived. Start the import again.',
    pairing_expired: 'This pairing has ended. Start the import again.',
    read_failed: 'The source browser could not read cookies. Check that the extension has access to all websites.',
    invalid_payload: 'Cookie data could not be parsed. Update Inkstone and the import extension, then retry.',
    import_failed: 'Cookie writing did not complete. Start the import again.'
  })[reason ?? 'import_failed'],
  startAddress: 'Search or enter address',
  collapseTabs: 'Unpin, expand on hover',
  resizeTabs: 'Resize tab bar',
  viewport: 'Viewport size',
  viewportNames: { responsive: 'Fit panel', mobile: 'Mobile 375×812', tablet: 'Tablet 768×1024', desktop: 'Desktop 1280×800' },
  expandTabs: 'Pin tabs open',
  searchEngine: 'Search engine',
  searchEngineCustom: 'Custom…',
  searchEngineCustomLabel: 'Search URL (%s is the query)',
  searchEngineInvalid: 'Use an http(s) URL that contains %s',
  save: 'Save',
  cancel: 'Cancel'
}

export function browserText(lang: Lang): BrowserText {
  return lang === 'en-US' ? EN : ZH
}
