import type { Lang } from '../../i18n'

export interface ToolTileText {
  tileOut: string
  noRoom: string
  dock: string
  close: string
  grip: string
  owner: (title: string) => string
}

const ZH: ToolTileText = {
  tileOut: '并排为磁贴',
  noRoom: '宽度不够再并排一块，先关闭一块磁贴或加宽窗口',
  dock: '收回工具栏',
  close: '关闭磁贴',
  grip: '拖动换位，方向键左右移动',
  owner: (title) => `属于 ${title}`
}

const EN: ToolTileText = {
  tileOut: 'Open as a tile',
  noRoom: 'Not enough width for another tile. Close a tile or widen the window',
  dock: 'Move back to the toolbar',
  close: 'Close tile',
  grip: 'Drag to reorder, or use the arrow keys',
  owner: (title) => `For ${title}`
}

export function toolTileText(lang: Lang): ToolTileText {
  return lang === 'en-US' ? EN : ZH
}
