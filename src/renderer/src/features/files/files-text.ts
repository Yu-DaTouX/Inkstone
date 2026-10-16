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
  addContext: '加入当前会话上下文'
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
  addContext: 'Add to the current chat'
}

export function filesText(lang: Lang): FilesText {
  return lang === 'en-US' ? EN : ZH
}
