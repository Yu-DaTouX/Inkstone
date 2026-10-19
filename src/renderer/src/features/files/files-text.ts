import type { Lang } from '../../i18n'

export interface FilesText {
  title: string
  treeLabel: string
  loading: string
  listing: string
  refreshing: string
  empty: string
  error: string
  retry: string
  permission: string
  missing: string
  invalid: string
  noCwd: string
  partial: string
  refresh: string
  collapseAll: string
  showTree: string
  hideTree: string
  resizeTree: string
  goToFile: string
  searchLabel: string
  searchPlaceholder: string
  searchClear: string
  searching: string
  searchEmpty: string
  searchFailed: string
  contentFailed: string
  contentHint: string
  searchTruncated: string
  attach: string
  copy: string
  copyAbsolute: string
  copyRelative: string
  copyName: string
  copyAbsolutePlural: string
  copyRelativePlural: string
  copyNamePlural: string
  openIn: string
  openDefault: string
  openPreview: string
  reveal: string
  openTerminal: string
  selectedCount: string
  linkTo: string
  linkDangling: string
  linkCycle: string
  linkExternal: string
}

const ZH: FilesText = {
  title: '文件',
  treeLabel: '项目文件',
  loading: '正在加载',
  listing: '正在列出此文件夹',
  refreshing: '正在刷新文件',
  empty: '文件夹为空',
  error: '无法读取此文件夹。',
  retry: '重试',
  permission: '没有权限读取此文件夹。',
  missing: '此文件夹已不存在。',
  invalid: '无法读取此文件夹。',
  noCwd: '此会话没有工作目录',
  partial: '内容较多，只列出了前面一部分',
  refresh: '刷新',
  collapseAll: '折叠全部',
  showTree: '显示文件树',
  hideTree: '隐藏文件树',
  resizeTree: '调整文件树大小',
  goToFile: '转到文件或搜索',
  searchLabel: '筛选文件',
  searchPlaceholder: '筛选文件，或输入 ? 搜索文件内容',
  searchClear: '清除筛选',
  searching: '正在搜索文件',
  searchEmpty: '没有匹配的文件',
  searchFailed: '无法搜索文件名。',
  contentFailed: '无法搜索文件内容。',
  contentHint: '在 ? 后输入文字以搜索文件内容',
  searchTruncated: '结果较多，只显示前面一部分',
  attach: '作为上下文附加',
  copy: '复制',
  copyAbsolute: '绝对路径',
  copyRelative: '相对路径',
  copyName: '文件名',
  copyAbsolutePlural: '绝对路径',
  copyRelativePlural: '相对路径',
  copyNamePlural: '文件名',
  openIn: '打开方式',
  openDefault: '默认程序',
  openPreview: '在预览中打开',
  reveal: '在资源管理器中显示',
  openTerminal: '在终端中打开',
  selectedCount: '已选择 {n} 项',
  linkTo: '链接到 {target}',
  linkDangling: '链接目标不存在',
  linkCycle: '循环链接，无法展开',
  linkExternal: '链接到工作目录之外：{target}'
}

const EN: FilesText = {
  title: 'Files',
  treeLabel: 'Project files',
  loading: 'Loading',
  listing: 'Listing this folder',
  refreshing: 'Refreshing files',
  empty: 'Folder is empty',
  error: 'Couldn’t read this folder.',
  retry: 'Try again',
  permission: 'No permission to read this folder.',
  missing: 'This folder no longer exists.',
  invalid: 'Couldn’t read this folder.',
  noCwd: 'No working directory for this session',
  partial: 'Too many entries; only the first part is shown',
  refresh: 'Refresh',
  collapseAll: 'Collapse all',
  showTree: 'Show file tree',
  hideTree: 'Hide file tree',
  resizeTree: 'Resize file tree',
  goToFile: 'Go to file or search',
  searchLabel: 'Filter files',
  searchPlaceholder: 'Filter, or ? to search in files',
  searchClear: 'Clear filter',
  searching: 'Searching files',
  searchEmpty: 'No matching files',
  searchFailed: 'Couldn’t search filenames.',
  contentFailed: 'Couldn’t search file contents.',
  contentHint: 'Type after ? to search in files',
  searchTruncated: 'Too many matches; only the first part is shown',
  attach: 'Attach as context',
  copy: 'Copy',
  copyAbsolute: 'Absolute path',
  copyRelative: 'Relative path',
  copyName: 'Filename',
  copyAbsolutePlural: 'Absolute paths',
  copyRelativePlural: 'Relative paths',
  copyNamePlural: 'Filenames',
  openIn: 'Open in',
  openDefault: 'Default app',
  openPreview: 'Open in preview',
  reveal: 'Show in Explorer',
  openTerminal: 'Open in terminal',
  selectedCount: '{n} items selected',
  linkTo: 'Link to {target}',
  linkDangling: 'Link target is missing',
  linkCycle: 'Circular link; cannot expand',
  linkExternal: 'Links outside the working directory: {target}'
}

export function filesText(lang: Lang): FilesText {
  return lang === 'en-US' ? EN : ZH
}
