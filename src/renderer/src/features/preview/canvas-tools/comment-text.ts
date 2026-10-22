import type { Lang } from '../../../i18n'

export interface CanvasCommentText {
  tool: string
  panelTitle: string
  panelEmpty: string
  panelHint: string
  composerTitle: string
  contentLabel: string
  contentPlaceholder: string
  save: string
  cancel: string
  saveHint: string
  selectAll: string
  selectRow: (index: number, summary: string) => string
  send: string
  clearSent: string
  sent: string
  invalid: string
  invalidHint: string
  orphanHint: string
  locate: string
  edit: string
  remove: string
  editSave: string
  editCancel: string
  sending: string
  sendEmpty: string
  sendFailed: string
  sendDone: (count: number) => string
  sendPartial: (count: number, images: number) => string
  countLabel: (count: number, selected: number) => string
  promptHeader: (file: string) => string
  promptComment: string
  stamp: (time: string) => string
  promptTime: (seconds: string) => string
}

const ZH: CanvasCommentText = {
  tool: '评论',
  panelTitle: '画布评论',
  panelEmpty: '还没有评论',
  panelHint: '用评论工具点选页面元素，在弹出的输入框里写评论。',
  composerTitle: '新建评论',
  contentLabel: '评论内容',
  contentPlaceholder: '写下你的评论…',
  save: '保存',
  cancel: '取消',
  saveHint: 'Ctrl/⌘ + Enter 保存',
  selectAll: '全选',
  selectRow: (index, summary) => `选择评论 ${index}：${summary}`,
  send: '发送选中到聊天',
  clearSent: '清空已发送',
  sent: '已发送',
  invalid: '已失效',
  invalidHint: '页面上已找不到这个元素，定位可能不准',
  orphanHint: '这个元素所在的画框当前没有显示',
  locate: '定位到元素',
  edit: '编辑评论',
  remove: '删除评论',
  editSave: '保存修改',
  editCancel: '放弃修改',
  sending: '正在截图并发送…',
  sendEmpty: '先勾选要发送的评论',
  sendFailed: '没能插入到聊天输入框，请打开聊天面板后重试',
  sendDone: (count) => `已把 ${count} 条评论插入聊天输入框`,
  sendPartial: (count, images) =>
    images < count ? `已插入 ${count} 条评论，其中 ${images} 张元素截图（其余截图失败，只发了文字）` : `已插入 ${count} 条评论`,
  countLabel: (count, selected) => (count ? `${count} 条 · 已选 ${selected}` : '0 条'),
  promptHeader: (file) => `请按下面的画布评论修改 ${file}：`,
  promptComment: '评论：',
  stamp: (time) => `@ ${time}`,
  promptTime: (seconds) => `时间点：${seconds} 秒`
}

const EN: CanvasCommentText = {
  tool: 'Comments',
  panelTitle: 'Canvas comments',
  panelEmpty: 'No comments yet',
  panelHint: 'Pick the comment tool and click an element to write a comment.',
  composerTitle: 'New comment',
  contentLabel: 'Comment',
  contentPlaceholder: 'Write a comment…',
  save: 'Save',
  cancel: 'Cancel',
  saveHint: 'Ctrl/⌘ + Enter to save',
  selectAll: 'Select all',
  selectRow: (index, summary) => `Select comment ${index}: ${summary}`,
  send: 'Send selected to chat',
  clearSent: 'Clear sent',
  sent: 'Sent',
  invalid: 'Stale',
  invalidHint: 'This element is gone from the page; the pin may be off',
  orphanHint: 'The frame holding this element is hidden right now',
  locate: 'Locate element',
  edit: 'Edit comment',
  remove: 'Delete comment',
  editSave: 'Save edit',
  editCancel: 'Discard edit',
  sending: 'Capturing and sending…',
  sendEmpty: 'Select comments to send first',
  sendFailed: 'Could not insert into the chat composer. Open the chat panel and retry.',
  sendDone: (count) => `Inserted ${count} comments into the chat composer`,
  sendPartial: (count, images) =>
    images < count ? `Inserted ${count} comments with ${images} element captures (the rest went as text only)` : `Inserted ${count} comments`,
  countLabel: (count, selected) => (count ? `${count} · ${selected} selected` : '0'),
  promptHeader: (file) => `Please revise ${file} following the canvas comments below:`,
  promptComment: 'Comment: ',
  stamp: (time) => `@ ${time}`,
  promptTime: (seconds) => `Time: ${seconds}s`
}

export const CANVAS_COMMENT_TEXT: Readonly<Record<Lang, CanvasCommentText>> = {
  'zh-CN': ZH,
  'en-US': EN
}

export function canvasCommentText(lang: Lang): CanvasCommentText {
  return CANVAS_COMMENT_TEXT[lang] ?? ZH
}
