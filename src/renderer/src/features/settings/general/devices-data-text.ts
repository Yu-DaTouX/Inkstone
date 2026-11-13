import type { Lang } from '../../../i18n'

export interface DevicesDataText {
  viaDirect: string
  viaRelay: string
  plaintext: string
  pairRelayWaiting: string
  online: string
  network: string
  relayNeedsUrl: string
  relayUrlDesc: string
  dataBackupVerifyDesc: string
  dataBackupRestore: string
  dataBackupRestoreDesc: string
  dataBackupRestored: string
  dataBackupOpenRestored: string
  dataMoveDesc: string
  dataExportDesc: string
  dataImportDesc: string
  sessionTransfer: string
  exportSession: string
  importSession: string
  exporting: string
  importing: string
  exportDone: string
  importDone: string
  transferFailed: string
}

const ZH: DevicesDataText = {
  viaDirect: '直连',
  viaRelay: '加密通道',
  plaintext: '未加密',
  pairRelayWaiting: '中继未连接，暂不能经中继配对。',
  online: '在线',
  network: '网络',
  relayNeedsUrl: '需先填写中继地址。',
  relayUrlDesc: '自建或可信的中继地址，以 https:// 开头。',
  dataBackupVerifyDesc: '检查备份包是否完整，不会恢复数据。',
  dataBackupRestore: '恢复备份',
  dataBackupRestoreDesc: '恢复到新的独立目录，不覆盖当前数据；新窗口需重新登录，远程访问关闭。',
  dataBackupRestored: '已恢复 {files} 个文件 · {size}',
  dataBackupOpenRestored: '打开恢复的数据',
  dataMoveDesc: '移到其它盘，完成后自动重启。',
  dataExportDesc: '导出为会话包，在另一台电脑导入。',
  dataImportDesc: '选择一个会话包，导入为新会话。',
  sessionTransfer: '会话导入导出',
  exportSession: '导出当前会话',
  importSession: '导入会话包',
  exporting: '正在导出…',
  importing: '正在导入…',
  exportDone: '已导出到 {path}',
  importDone: '已导入为新会话 {id}',
  transferFailed: '操作失败'
}

const EN: DevicesDataText = {
  viaDirect: 'Direct',
  viaRelay: 'Encrypted',
  plaintext: 'Unencrypted',
  pairRelayWaiting: 'Relay not connected yet; relay pairing is unavailable.',
  online: 'Online',
  network: 'Network',
  relayNeedsUrl: 'Enter a relay address first.',
  relayUrlDesc: 'A relay you host or trust, starting with https://.',
  dataBackupVerifyDesc: 'Check a backup is intact; nothing is restored.',
  dataBackupRestore: 'Restore backup',
  dataBackupRestoreDesc: 'Restores to a new folder, current data untouched; the new window needs sign-in and has remote access off.',
  dataBackupRestored: 'Restored {files} files · {size}',
  dataBackupOpenRestored: 'Open restored data',
  dataMoveDesc: 'Move to another drive; restarts when done.',
  dataExportDesc: 'Export a session bundle and import it on another computer.',
  dataImportDesc: 'Pick a session bundle and import it as a new session.',
  sessionTransfer: 'Session export and import',
  exportSession: 'Export current session',
  importSession: 'Import session bundle',
  exporting: 'Exporting…',
  importing: 'Importing…',
  exportDone: 'Exported to {path}',
  importDone: 'Imported as new session {id}',
  transferFailed: 'Operation failed'
}

export function devicesDataText(lang: Lang): DevicesDataText {
  return lang === 'en-US' ? EN : ZH
}
