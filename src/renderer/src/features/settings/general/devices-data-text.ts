import type { Lang } from '../../../i18n'

export interface DevicesDataText {
  viaDirect: string
  viaRelay: string
  pairViaRelay: string
  pairRelayWaiting: string
  online: string
  network: string
  relayNeedsUrl: string
  relayUrlDesc: string
  dataBackupVerifyDesc: string
  dataMoveDesc: string
  dataExportDesc: string
  dataImportDesc: string
  sessionTransfer: string
}

const ZH: DevicesDataText = {
  viaDirect: '直连',
  viaRelay: '中继',
  pairViaRelay: '经中继配对',
  pairRelayWaiting: '中继未连接，暂不能经中继配对。',
  online: '在线',
  network: '网络',
  relayNeedsUrl: '先在下方填写中继地址才能开启。',
  relayUrlDesc: '自建或他人提供的中继服务地址，以 https:// 开头。',
  dataBackupVerifyDesc: '检查一个已有的备份包是否完整。',
  dataMoveDesc: '把数据目录移到其它盘，完成后自动重启。迁移有风险，确认后才执行。',
  dataExportDesc: '会话不随文件夹同步；导出为会话包（不含登录凭证），在另一台电脑导入后生成新会话。',
  dataImportDesc: '选择一个会话包，导入为新会话。',
  sessionTransfer: '会话导入导出'
}

const EN: DevicesDataText = {
  viaDirect: 'Direct',
  viaRelay: 'Relay',
  pairViaRelay: 'Pair via relay',
  pairRelayWaiting: 'Relay not connected yet; relay pairing is unavailable.',
  online: 'Online',
  network: 'Network',
  relayNeedsUrl: 'Enter a relay address below to turn this on.',
  relayUrlDesc: 'Address of a relay you host or trust, starting with https://.',
  dataBackupVerifyDesc: 'Check that an existing backup bundle is intact.',
  dataMoveDesc: 'Move the data folder to another drive; Inkstone restarts when done. Moving is risky and only runs after you confirm.',
  dataExportDesc:
    'Sessions are not synced through the folder; export a bundle (no credentials) and import it on another computer as a new session.',
  dataImportDesc: 'Pick a session bundle and import it as a new session.',
  sessionTransfer: 'Session export and import'
}

export function devicesDataText(lang: Lang): DevicesDataText {
  return lang === 'en-US' ? EN : ZH
}
