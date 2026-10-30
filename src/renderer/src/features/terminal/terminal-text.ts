import type { Lang } from '../../i18n'

export interface TerminalText {
  activateFirst: string
  starting: string
  connecting: string
  startFailed: string
  attachFailed: string
  bufferOverflow: string
  empty: string
  tabTitle: string
  tabNumber: (n: number) => string
  tabs: string
  newTab: string
  closeTab: string
  closeOthers: string
  tabMenu: string
  terminalMenu: string
  viewMenu: string
  fontSize: string
  lineHeight: string
  cursorStyle: string
  cursorBlink: string
  scrollback: string
  cursorBlock: string
  cursorBar: string
  cursorUnderline: string
  lines: (n: number) => string
  copy: string
  paste: string
  selectAll: string
  clear: string
  find: string
  findPlaceholder: string
  findPrev: string
  findNext: string
  findClose: string
  noResults: string
  reload: string
  listFailed: string
  linkHint: (mac: boolean) => string
  addToChat: string
  selectionSource: (label: string, cwd: string) => string
  closeConfirmTitle: string
  closeConfirmList: string
  closeConfirmUnknown: string
  closeConfirmMore: (n: number) => string
  closeConfirmAction: string
  cancel: string
}

const ZH: TerminalText = {
  activateFirst: '先激活这条会话，终端才会运行。',
  starting: '正在启动终端…',
  connecting: '正在连接终端…',
  startFailed: '终端启动失败，可重试',
  attachFailed: '终端连接失败，可重试',
  bufferOverflow: '终端连接缓冲超限，请重新连接',
  empty: '没有打开的终端',
  tabTitle: '终端',
  tabNumber: (n) => `终端 ${n}`,
  tabs: '终端标签',
  newTab: '新建终端',
  closeTab: '关闭终端',
  closeOthers: '关闭其他终端',
  tabMenu: '终端标签菜单',
  terminalMenu: '终端',
  viewMenu: '视图设置',
  fontSize: '字号',
  lineHeight: '行高',
  cursorStyle: '光标样式',
  cursorBlink: '光标闪烁',
  scrollback: '回放行数',
  cursorBlock: '方块',
  cursorBar: '竖线',
  cursorUnderline: '下划线',
  lines: (n) => `${n.toLocaleString()} 行`,
  copy: '复制',
  paste: '粘贴',
  selectAll: '全选',
  clear: '清屏',
  find: '在终端中查找',
  findPlaceholder: '在终端中查找…',
  findPrev: '上一个匹配',
  findNext: '下一个匹配',
  findClose: '关闭查找',
  noResults: '无结果',
  reload: '重新加载',
  listFailed: '终端列表读取失败，可重试',
  linkHint: (mac) => (mac ? '按住 Cmd 点击打开' : '按住 Ctrl 点击打开'),
  addToChat: '加入输入框',
  selectionSource: (label, cwd) => (cwd ? `终端「${label}」输出（${cwd}）：` : `终端「${label}」输出：`),
  closeConfirmTitle: '结束运行中的进程？',
  closeConfirmList: '关闭后，下列进程会被结束：',
  closeConfirmUnknown: '终端里还有命令在运行，关闭会结束它。',
  closeConfirmMore: (n) => `另有 ${n} 个`,
  closeConfirmAction: '关闭并结束',
  cancel: '取消'
}

const EN: TerminalText = {
  activateFirst: 'Activate this conversation to run the terminal.',
  starting: 'Starting terminal…',
  connecting: 'Connecting to terminal…',
  startFailed: 'Could not start the terminal. You can retry.',
  attachFailed: 'Could not connect to the terminal. You can retry.',
  bufferOverflow: 'Terminal connection buffer exceeded; reconnect.',
  empty: 'No terminal open',
  tabTitle: 'Terminal',
  tabNumber: (n) => `Terminal ${n}`,
  tabs: 'Terminal tabs',
  newTab: 'New terminal',
  closeTab: 'Close terminal',
  closeOthers: 'Close other terminals',
  tabMenu: 'Terminal tab menu',
  terminalMenu: 'Terminal',
  viewMenu: 'View options',
  fontSize: 'Font size',
  lineHeight: 'Line height',
  cursorStyle: 'Cursor style',
  cursorBlink: 'Blink cursor',
  scrollback: 'Scrollback',
  cursorBlock: 'Block',
  cursorBar: 'Bar',
  cursorUnderline: 'Underline',
  lines: (n) => `${n.toLocaleString()} lines`,
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  clear: 'Clear terminal',
  find: 'Find in terminal',
  findPlaceholder: 'Find in terminal…',
  findPrev: 'Previous match',
  findNext: 'Next match',
  findClose: 'Close find bar',
  noResults: 'No results',
  reload: 'Reload',
  listFailed: 'Could not list the terminal tabs. You can retry.',
  linkHint: (mac) => (mac ? 'Cmd+click to open' : 'Ctrl+click to open'),
  addToChat: 'Add to composer',
  selectionSource: (label, cwd) => (cwd ? `Terminal "${label}" output (${cwd}):` : `Terminal "${label}" output:`),
  closeConfirmTitle: 'End running processes?',
  closeConfirmList: 'Closing will end these processes:',
  closeConfirmUnknown: 'A command is still running in this terminal. Closing will end it.',
  closeConfirmMore: (n) => `${n} more`,
  closeConfirmAction: 'Close and end',
  cancel: 'Cancel'
}

export function terminalText(lang: Lang): TerminalText {
  return lang === 'en-US' ? EN : ZH
}
