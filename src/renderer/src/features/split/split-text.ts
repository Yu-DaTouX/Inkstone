import type { Lang } from '../../i18n'

export interface SplitText {
  dragLabel: string
  openHere: string
  splitView: string
  swap: string
  moveHere: string
  openWith: string
  openInSplit: string
  openBelow: string
  resizeColumns: string
  resizeRows: string
  grip: string
  activate: (title: string) => string
  runnerLimit: (limit: number) => string
  sameCwdRunning: string
  noRoom: string
}

const zh: SplitText = {
  dragLabel: '在分屏中打开',
  openHere: '在此打开',
  splitView: '分屏',
  swap: '交换',
  moveHere: '移到这里',
  openWith: '打开方式',
  openInSplit: '分屏',
  openBelow: '在下方分屏',
  resizeColumns: '调整面板列宽',
  resizeRows: '调整面板行高',
  grip: '拖动换位，方向键左右移动',
  activate: (title) => `切换到「${title}」`,
  runnerLimit: (limit) => `最多 ${limit} 个会话能同时运行。其余分屏块先显示记录，点进去时会接管空闲的运行实例。`,
  sameCwdRunning: '同一目录有会话在运行，切过来先只读打开',
  noRoom: '分屏已满，先关掉一块再打开'
}

const en: SplitText = {
  dragLabel: 'Open in split view',
  openHere: 'Open here',
  splitView: 'Split view',
  swap: 'Swap',
  moveHere: 'Move here',
  openWith: 'Open with',
  openInSplit: 'Split view',
  openBelow: 'Split view below',
  resizeColumns: 'Resize pane columns',
  resizeRows: 'Resize pane rows',
  grip: 'Drag to reorder, or use the arrow keys',
  activate: (title) => `Switch to “${title}”`,
  runnerLimit: (limit) => `Up to ${limit} sessions can run at once. Other panes show their history and take over an idle runner when you click into them.`,
  sameCwdRunning: 'Another session in this folder is running; this one opens read-only first',
  noRoom: 'Split view is full. Close a pane first.'
}

export function splitText(lang: Lang): SplitText {
  return lang === 'en-US' ? en : zh
}
