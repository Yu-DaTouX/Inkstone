import type { Lang } from '../../i18n'

export interface PreviewText {
  title: string
  empty: string
  emptyHint: string
  loading: string
  failed: string
  binary: string
  binaryHint: string
  imageNote: string
  officeNote: string
  savedNote: string
  truncated: string
  tooManyLines: string
  open: string
  reveal: string
  copyPath: string
  copyPathDone: string
  retry: string
  lineRange: string
  artifacts: string
  notOwner: string
  tabsLabel: string
  closeTab: string
  closeAllTabs: string
  crumbsLabel: string
  edit: string
  viewMode: string
  save: string
  saving: string
  saved: string
  dirty: string
  conflict: string
  saveFailed: string
  reload: string
  discard: string
  closeEditor: string
}

const ZH: PreviewText = {
  title: '预览',
  empty: '没有打开的预览',
  emptyHint: '在文件面板点一个文件，或从成果卡片打开。',
  loading: '正在读取…',
  failed: '无法预览',
  binary: '无法在这里预览这个文件',
  binaryHint: '二进制文件只显示元信息，可用系统程序打开。',
  imageNote: '图片经主进程校验后以只读地址显示。',
  officeNote: '正文由宿主从文件提取，版式以原文件为准。',
  savedNote: '这里只是只读预览，不修改原文件。',
  truncated: '文件较大，只显示前面一部分。',
  tooManyLines: '内容太多，只渲染前 {n} 行。',
  open: '用系统程序打开',
  reveal: '在文件夹中显示',
  copyPath: '复制路径',
  copyPathDone: '已复制',
  retry: '重试',
  lineRange: '第 {start}–{end} 行',
  artifacts: '这条会话的成果',
  notOwner: '该会话不是当前活动会话；激活后即可查看它的成果。',
  tabsLabel: '打开的文件',
  closeTab: '关闭',
  closeAllTabs: '关闭全部',
  crumbsLabel: '文件路径',
  edit: '编辑',
  viewMode: '回到预览',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存',
  dirty: '已修改，未保存',
  conflict: '文件已被外部改动，未覆盖',
  saveFailed: '保存失败',
  reload: '重新加载',
  discard: '放弃改动',
  closeEditor: '关闭编辑'
}

const EN: PreviewText = {
  title: 'Preview',
  empty: 'Nothing to preview',
  emptyHint: 'Pick a file in the Files panel, or open one from an artifact card.',
  loading: 'Reading…',
  failed: 'Cannot preview',
  binary: 'This file cannot be previewed here',
  binaryHint: 'Binary files show metadata only; open them with a system app.',
  imageNote: 'The image is shown from a read-only address validated by the host.',
  officeNote: 'Text is extracted by the host; the original file owns the layout.',
  savedNote: 'This is a read-only preview; the original file is not modified.',
  truncated: 'Large file — only the beginning is shown.',
  tooManyLines: 'Too much content — rendering the first {n} lines only.',
  open: 'Open in system app',
  reveal: 'Show in folder',
  copyPath: 'Copy path',
  copyPathDone: 'Copied',
  retry: 'Retry',
  lineRange: 'Lines {start}–{end}',
  artifacts: 'Artifacts from this chat',
  notOwner: 'This chat is not the active one; activate it to see its artifacts.',
  tabsLabel: 'Open files',
  closeTab: 'Close',
  closeAllTabs: 'Close all',
  crumbsLabel: 'File path',
  edit: 'Edit',
  viewMode: 'Back to preview',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  dirty: 'Unsaved changes',
  conflict: 'File changed on disk; not overwritten',
  saveFailed: 'Could not save',
  reload: 'Reload',
  discard: 'Discard changes',
  closeEditor: 'Close editor'
}

export function previewText(lang: Lang): PreviewText {
  return lang === 'en-US' ? EN : ZH
}
