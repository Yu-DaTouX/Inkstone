export interface WorkbenchPaneText {
  logFilter: string
  logNoMatch: string
  copyLogs: string
  copied: string
  copyFailed: string
  quotaHint: string
  quotaManage: string
}

const zh: WorkbenchPaneText = {
  logFilter: '过滤日志',
  logNoMatch: '没有匹配的日志行。',
  copyLogs: '复制当前日志',
  copied: '已复制',
  copyFailed: '复制日志失败',
  quotaHint: '这里显示服务商给出的 5 小时 / 周窗口额度，不是本机的 Token 用量；推算值会标明来源。',
  quotaManage: '添加账号、改备注与 CLI 来源仍在设置里管理。'
}

const en: WorkbenchPaneText = {
  logFilter: 'Filter logs',
  logNoMatch: 'No matching log lines.',
  copyLogs: 'Copy visible logs',
  copied: 'Copied',
  copyFailed: 'Could not copy the logs',
  quotaHint: 'Shows the provider’s 5-hour and weekly window quota, not local token usage. Estimated values are labelled.',
  quotaManage: 'Adding accounts, labels and CLI sources are still managed in Settings.'
}

export function workbenchPaneText(lang: string): WorkbenchPaneText {
  return lang === 'en-US' ? en : zh
}
