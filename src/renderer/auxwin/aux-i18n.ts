/**
 * 辅助小窗的本地文案（v3 WP-25d / WP-12）。
 *
 * 刻意不并进主界面的 i18n 目录：独立入口、独立窗口，键很少；并进共享目录会
 * 让多个 agent 在同一个 JSON 上冲突。中英文在这里必须成对出现（`Record` 保证）。
 */
import type { AuxLocale, MiniStatusKey, QuickAskErrorCode } from './aux-bridge'

type Dict = {
  quickAskTitle: string
  placeholder: string
  targetNew: string
  targetCurrent: string
  project: string
  model: string
  useDefault: string
  send: string
  expand: string
  hint: string
  noCurrent: string
  miniTitle: string
  miniEmpty: string
  miniOpen: string
  miniClose: string
  statusNeedsYou: string
  statusStalled: string
  statusFailed: string
  statusDone: string
  statusQueued: string
  statusRunning: string
  errEmpty: string
  errNoCurrent: string
  errStartFailed: string
  errCreateFailed: string
  errModelFailed: string
  errSendFailed: string
  errUnavailable: string
}

const ZH: Dict = {
  quickAskTitle: '快速提问',
  placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）',
  targetNew: '新会话',
  targetCurrent: '当前会话',
  project: '项目',
  model: '模型',
  useDefault: '默认',
  send: '发送',
  expand: '发送并展开',
  hint: 'Enter 发送 · Ctrl+Enter 发送并展开 · Esc 关闭',
  noCurrent: '当前没有会话',
  miniTitle: '运行中',
  miniEmpty: '暂无需要处理的运行',
  miniOpen: '打开',
  miniClose: '关闭',
  statusNeedsYou: '等你确认',
  statusStalled: '停滞',
  statusFailed: '失败',
  statusDone: '刚完成',
  statusQueued: '排队',
  statusRunning: '运行中',
  errEmpty: '先写一个问题',
  errNoCurrent: '当前没有会话，请选择新会话',
  errStartFailed: '模型没有启动',
  errCreateFailed: '无法创建会话',
  errModelFailed: '无法切换模型',
  errSendFailed: '发送失败',
  errUnavailable: '暂不可用'
}

const EN: Dict = {
  quickAskTitle: 'Quick ask',
  placeholder: 'Ask anything… (Enter to send, Shift+Enter for newline)',
  targetNew: 'New session',
  targetCurrent: 'Current session',
  project: 'Project',
  model: 'Model',
  useDefault: 'Default',
  send: 'Send',
  expand: 'Send & open',
  hint: 'Enter to send · Ctrl+Enter send & open · Esc to close',
  noCurrent: 'No current session',
  miniTitle: 'Running',
  miniEmpty: 'Nothing needs you right now',
  miniOpen: 'Open',
  miniClose: 'Close',
  statusNeedsYou: 'Needs you',
  statusStalled: 'Stalled',
  statusFailed: 'Failed',
  statusDone: 'Done',
  statusQueued: 'Queued',
  statusRunning: 'Running',
  errEmpty: 'Type a question first',
  errNoCurrent: 'No current session — choose New session',
  errStartFailed: 'The model did not start',
  errCreateFailed: 'Could not create the session',
  errModelFailed: 'Could not switch the model',
  errSendFailed: 'Send failed',
  errUnavailable: 'Not available right now'
}

export function auxDict(locale: AuxLocale): Dict {
  return locale === 'en-US' ? EN : ZH
}

export function statusWord(locale: AuxLocale, status: MiniStatusKey): string {
  const d = auxDict(locale)
  switch (status) {
    case 'needs-you':
      return d.statusNeedsYou
    case 'stalled':
      return d.statusStalled
    case 'failed':
      return d.statusFailed
    case 'done':
      return d.statusDone
    case 'queued':
      return d.statusQueued
    default:
      return d.statusRunning
  }
}

export function errorWord(locale: AuxLocale, code: QuickAskErrorCode | undefined): string {
  const d = auxDict(locale)
  switch (code) {
    case 'empty':
      return d.errEmpty
    case 'no-current':
      return d.errNoCurrent
    case 'start-failed':
      return d.errStartFailed
    case 'create-failed':
      return d.errCreateFailed
    case 'model-failed':
      return d.errModelFailed
    case 'send-failed':
      return d.errSendFailed
    default:
      return d.errUnavailable
  }
}
