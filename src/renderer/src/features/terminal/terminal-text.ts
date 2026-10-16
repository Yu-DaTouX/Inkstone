/**
 * 终端面板自己的一小段文案。
 *
 * 为什么不在两份 i18n JSON 里加键：它们是与 v2 共用的热点文件，v3 终端尚未定稿，
 * 现在加键会给 v2 留下无用条目（与 `app/v3-text.ts` 同一约定）。能用现有键的
 * （`term.new` / `term.close` / `tile.endTerminal` / `term.exited` / `term.retry` …）
 * 一律走 `useT()`，这里只放 v3 终端独有的短语。
 */
import type { Lang } from '../../i18n'

export interface TerminalText {
  activateFirst: string
  starting: string
  connecting: string
  startFailed: string
  attachFailed: string
  bufferOverflow: string
  empty: string
}

const ZH: TerminalText = {
  activateFirst: '先激活这条会话，终端才会运行。',
  starting: '正在启动终端…',
  connecting: '正在连接终端…',
  startFailed: '终端启动失败，可重试',
  attachFailed: '终端连接失败，可重试',
  bufferOverflow: '终端连接缓冲超限，请重新连接',
  empty: '没有打开的终端'
}

const EN: TerminalText = {
  activateFirst: 'Activate this conversation to run the terminal.',
  starting: 'Starting terminal…',
  connecting: 'Connecting to terminal…',
  startFailed: 'Could not start the terminal. You can retry.',
  attachFailed: 'Could not connect to the terminal. You can retry.',
  bufferOverflow: 'Terminal connection buffer exceeded; reconnect.',
  empty: 'No terminal open'
}

export function terminalText(lang: Lang): TerminalText {
  return lang === 'en-US' ? EN : ZH
}
