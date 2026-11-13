export interface WorkbenchPaneText {
  logFilter: string
  logNoMatch: string
  clearFilter: string
  copyLogs: string
  copied: string
  copyFailed: string
}

const zh: WorkbenchPaneText = {
  logFilter: '过滤日志',
  logNoMatch: '没有匹配的日志行。',
  clearFilter: '清除过滤',
  copyLogs: '复制当前日志',
  copied: '已复制',
  copyFailed: '复制日志失败'
}

const en: WorkbenchPaneText = {
  logFilter: 'Filter logs',
  logNoMatch: 'No matching log lines.',
  clearFilter: 'Clear filter',
  copyLogs: 'Copy visible logs',
  copied: 'Copied',
  copyFailed: 'Could not copy the logs'
}

export function workbenchPaneText(lang: string): WorkbenchPaneText {
  return lang === 'en-US' ? en : zh
}
