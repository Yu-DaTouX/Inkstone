import type { Lang } from '../../i18n'

export interface FilesText {
  treeLabel: string
  loading: string
  empty: string
  error: string
  permission: string
  missing: string
  invalid: string
  partial: string
  showHidden: string
  hideHidden: string
  refresh: string
  addContext: string
  copyPath: string
  copyRelativePath: string
  copyName: string
  reveal: string
  openWithSystem: string
  collapseAll: string
  searchLabel: string
  searchPlaceholder: string
  searchClear: string
  toggleTree: string
  resizeTree: string
  searching: string
  searchEmpty: string
  searchFailed: string
  searchTruncated: string
  selectedCount: string
  addSelected: string
  clearSelection: string
}

const ZH: FilesText = {
  treeLabel: '项目文件',
  loading: '正在读取目录…',
  empty: '这个目录是空的',
  error: '读取目录失败',
  permission: '没有权限读取这个目录',
  missing: '目录不存在',
  invalid: '工作目录不可用',
  partial: '目录内容较多，只列出了前面一部分',
  showHidden: '显示隐藏项',
  hideHidden: '隐藏隐藏项',
  refresh: '刷新已展开的目录',
  addContext: '加入当前会话上下文',
  copyPath: '复制路径',
  copyRelativePath: '复制相对路径',
  copyName: '复制名称',
  reveal: '在文件夹中显示',
  openWithSystem: '用系统程序打开',
  collapseAll: '折叠全部',
  searchLabel: '筛选文件',
  searchPlaceholder: '筛选，或输入 ? 在文件中搜索',
  searchClear: '清除筛选',
  toggleTree: '显示文件树',
  resizeTree: '调整文件树宽度',
  searching: '正在搜索…',
  searchEmpty: '没有匹配',
  searchFailed: '搜索失败',
  searchTruncated: '结果较多，只显示前面一部分',
  selectedCount: '已选 {n} 项',
  addSelected: '加入上下文',
  clearSelection: '清除选择'
}

const EN: FilesText = {
  treeLabel: 'Project files',
  loading: 'Reading folder…',
  empty: 'This folder is empty',
  error: 'Could not read this folder',
  permission: 'No permission to read this folder',
  missing: 'Folder does not exist',
  invalid: 'The working directory is unavailable',
  partial: 'Too many entries; only the first part is shown',
  showHidden: 'Show hidden items',
  hideHidden: 'Hide hidden items',
  refresh: 'Refresh expanded folders',
  addContext: 'Add to the current chat',
  copyPath: 'Copy path',
  copyRelativePath: 'Copy relative path',
  copyName: 'Copy name',
  reveal: 'Reveal in folder',
  openWithSystem: 'Open with system app',
  collapseAll: 'Collapse all',
  searchLabel: 'Filter files',
  searchPlaceholder: 'Filter, or type ? to search inside files',
  searchClear: 'Clear filter',
  toggleTree: 'Show file tree',
  resizeTree: 'Resize file tree',
  searching: 'Searching…',
  searchEmpty: 'No matches',
  searchFailed: 'Search failed',
  searchTruncated: 'Too many matches; only the first part is shown',
  selectedCount: '{n} selected',
  addSelected: 'Add to chat',
  clearSelection: 'Clear selection'
}

export function filesText(lang: Lang): FilesText {
  return lang === 'en-US' ? EN : ZH
}
