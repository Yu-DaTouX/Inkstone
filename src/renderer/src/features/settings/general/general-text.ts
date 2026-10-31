import type { Lang } from '../../../i18n'

export interface GeneralText {
  loading: string
  cancel: string
  confirm: string

  appearanceSendKey: string
  appearanceSendKeyDesc: string
  appearanceSendKeyEnter: string
  appearanceSendKeyCtrl: string

  sessionContextLede: string
  sessionKeepAwakeBatteryOff: string
  sessionAutoArchive: string
  sessionAutoArchiveDesc: string
  archiveNever: string
  archiveDays: string
  sessionKeepAwake: string
  sessionKeepAwakeDesc: string
  sessionKeepAwakeBattery: string
  sessionKeepAwakeBatteryDesc: string
  sessionCheckpoints: string
  sessionCheckpointsDesc: string
  sessionWrapUpCard: string
  sessionWrapUpCardDesc: string
  sessionResponseDetail: string
  sessionResponseDetailDesc: string
  responseDetailBrief: string
  responseDetailStandard: string
  responseDetailDetailed: string
  sessionSubagentNotify: string
  sessionSubagentNotifyDesc: string
  sessionSubagentModel: string
  sessionSubagentModelDesc: string
  sessionSubagentModelFollow: string
  sessionSubagentModelForce: string
  sessionSubagentModelForceDesc: string
  sessionLoopAutoContinue: string
  sessionLoopAutoContinueDesc: string
  sessionDelivery: string
  sessionSteeringMode: string
  sessionSteeringModeDesc: string
  sessionFollowUpMode: string
  sessionFollowUpModeDesc: string
  queueOneAtATime: string
  queueAll: string
  sessionAutoRetry: string
  sessionAutoRetryDesc: string

  notifSystem: string
  notifSystemDesc: string
  notifSystemTest: string
  notifSystemTestLabel: string
  notifSystemNeedsSound: string
  notifVolume: string
  notifSystemHelp: string
  notifSound: string
  notifSoundDesc: string
  notifEventDone: string
  notifEventQuestion: string
  notifEventError: string
  notifPreview: string

  securityMode: string
  securityModeDanger: string
  securityModeDangerDesc: string
  securityModeAll: string
  securityModeAllDesc: string
  securityAllConfirmTitle: string
  securityAllConfirmBody: string
  securityAllConfirmContinue: string
  securityOutside: string
  securityOutsideDesc: string
  securityOutsideDisabled: string
  securityAllowRoots: string
  securityAllowRootsDesc: string
  securityAllowRootsEmpty: string
  securityAllowRootsRemove: string
  securityRemoteImages: string
  securityRemoteImagesDesc: string
  securityRemoteImagesManage: string

  devicesEnable: string
  devicesEnableDesc: string
  devicesRunning: string
  devicesStopped: string
  devicesPair: string
  devicesPairDesc: string
  devicesPairStart: string
  devicesPairCancel: string
  devicesPairCode: string
  devicesPairExpires: string
  devicesPairCopy: string
  devicesPairCopied: string
  devicesPairNeedsRunning: string
  devicesPairLoopback: string
  devicesPairQr: string
  devicesBind: string
  devicesBindDesc: string
  devicesBindTailscale: string
  devicesBindRadmin: string
  devicesBindLan: string
  devicesBindLoopback: string
  devicesBindLanAddress: string
  devicesBindLanNone: string
  devicesBindRadminNone: string
  devicesStartFailed: string
  devicesList: string
  devicesListDesc: string
  devicesNone: string
  devicesPairedAt: string
  devicesLastSeen: string
  devicesNever: string
  devicesRevoke: string
  devicesRevokedAt: string
  devicesForget: string
  devicesPeer: string
  devicesPeerDesc: string
  devicesPeerNone: string
  devicesPeerRevoke: string
  devicesSyncConfigured: string

  dataLocation: string
  dataLocationDesc: string
  dataSize: string
  dataMove: string
  dataTarget: string
  dataMoveConfirm: string
  dataMoveScheduled: string
  dataMovePending: string
  dataMoving: string
  dataOpen: string
  dataNotMovable: string
  dataStranded: string
  dataLastFailed: string
  dataBackup: string
  dataBackupDesc: string
  dataBackupCreate: string
  dataBackupVerify: string
  dataBackupWorking: string
  dataBackupChecked: string

  aboutVersion: string
  aboutBuild: string
  aboutOpenSource: string
  aboutOpen: string
  aboutPi: string
  aboutPiDesc: string
  aboutRedetect: string
  aboutRedetecting: string
  aboutUpdates: string
  aboutUpdateAuto: string
  aboutUpdateAutoDesc: string
  aboutUpdateCheck: string
  aboutUpdateDownload: string
  aboutUpdateInstall: string
  aboutUpdateReleases: string
  aboutUpdateInstallConfirm: string
  aboutPhaseIdle: string
  aboutPhaseChecking: string
  aboutPhaseCurrent: string
  aboutPhaseAvailable: string
  aboutPhaseDownloading: string
  aboutPhaseDownloaded: string
  aboutPhaseError: string
  aboutPhaseManual: string
}

const ZH: GeneralText = {
  loading: '正在读取…',
  cancel: '取消',
  confirm: '确定',

  appearanceSendKey: '发送键',
  appearanceSendKeyDesc: 'Shift+Enter 始终换行。',
  appearanceSendKeyEnter: 'Enter',
  appearanceSendKeyCtrl: 'Ctrl+Enter',

  sessionContextLede: 'pi 原生压缩，对所有会话生效。',
  sessionKeepAwakeBatteryOff: '需先开启上一项。',
  sessionAutoArchive: '自动归档闲置会话',
  sessionAutoArchiveDesc: '可在「已归档」找回。',
  archiveNever: '从不',
  archiveDays: '{n} 天',
  sessionKeepAwake: '运行时保持唤醒',
  sessionKeepAwakeDesc: '阻止系统睡眠，跑完自动恢复。',
  sessionKeepAwakeBattery: '用电池时也保持唤醒',
  sessionKeepAwakeBatteryDesc: '关闭后，用电池时允许睡眠。',
  sessionCheckpoints: '发送前存检查点',
  sessionCheckpointsDesc: '每轮存可回退快照；关闭后无法回退。',
  sessionWrapUpCard: '显示下一步建议',
  sessionWrapUpCardDesc: '仅在需要你决定时显示回复按钮。',
  sessionResponseDetail: '回复详细程度',
  sessionResponseDetailDesc: '只控制讲多细，与思考强度无关。',
  responseDetailBrief: '简洁',
  responseDetailStandard: '标准',
  responseDetailDetailed: '详细',
  sessionSubagentNotify: '子 Agent 结束时通知主会话',
  sessionSubagentNotifyDesc: '唤醒主会话继续汇总。',
  sessionSubagentModel: '子 Agent 默认模型',
  sessionSubagentModelDesc: '未指定时使用；「跟随会话」用当前模型。',
  sessionSubagentModelFollow: '跟随会话',
  sessionSubagentModelForce: '强制使用默认模型',
  sessionSubagentModelForceDesc: '忽略任务里指定的其他模型。',
  sessionLoopAutoContinue: '循环停止后自动继续',
  sessionLoopAutoContinueDesc: '安全停止后自动续一次，关闭则等你发送。',
  sessionDelivery: '消息投递',
  sessionSteeringMode: '运行中插话',
  sessionSteeringModeDesc: '运行中发出的插话，逐条或一次送达。',
  sessionFollowUpMode: '排队消息',
  sessionFollowUpModeDesc: '本轮后的排队消息，逐条或一次送达。',
  queueOneAtATime: '逐条',
  queueAll: '全部',
  sessionAutoRetry: '自动重试',
  sessionAutoRetryDesc: '限流、过载、5xx 时自动重试。',

  notifSystem: '系统通知',
  notifSystemDesc: '窗口在后台时弹出系统通知。',
  notifSystemTest: '发送',
  notifSystemTestLabel: '试发一条系统通知',
  notifSystemNeedsSound: '需先开启提示音。',
  notifVolume: '音量',
  notifSystemHelp: '系统需允许砚发通知。',
  notifSound: '提示音总开关',
  notifSoundDesc: '关闭后，下面各事件不出声也不弹通知。',
  notifEventDone: '回合完成',
  notifEventQuestion: '需要你回答',
  notifEventError: '出错',
  notifPreview: '试听',

  securityMode: '权限档',
  securityModeDanger: '自动批准',
  securityModeDangerDesc: '危险操作先问你；只是提醒，不是沙箱。',
  securityModeAll: '不受限制',
  securityModeAllDesc: '不审批也不拦截；切换前需确认。',
  securityAllConfirmTitle: '切到「不受限制」？',
  securityAllConfirmBody: '高危命令和项目外写入将不再询问。',
  securityAllConfirmContinue: '仍然切换',
  securityOutside: '写入项目之外时确认',
  securityOutsideDesc: '「自动批准」下，写项目外也先问。',
  securityOutsideDisabled: '仅在「自动批准」档生效。',
  securityAllowRoots: '已记住的允许目录',
  securityAllowRootsDesc: '在确认卡选「允许并记住」后加入。',
  securityAllowRootsEmpty: '还没有记住任何目录。',
  securityAllowRootsRemove: '移除',
  securityRemoteImages: '远程图片白名单',
  securityRemoteImagesDesc: '名单内站点的图片直接加载，其余先点击。',
  securityRemoteImagesManage: '管理',

  devicesEnable: '手机接入',
  devicesEnableDesc: '手机可查看、回复会话；任务仍在本机运行。',
  devicesRunning: '运行中',
  devicesStopped: '已停止',
  devicesPair: '配对新手机',
  devicesPairDesc: '用手机扫码或复制链接。',
  devicesPairStart: '生成配对码',
  devicesPairCancel: '取消配对',
  devicesPairCode: '配对码',
  devicesPairExpires: '{seconds} 秒后过期',
  devicesPairCopy: '复制链接',
  devicesPairCopied: '已复制',
  devicesPairNeedsRunning: '需先开启手机接入。',
  devicesPairLoopback: '仅监听本机，请换一个监听地址。',
  devicesPairQr: '配对链接二维码',
  devicesBind: '监听地址',
  devicesBindDesc: '手机通过哪张网络连进来。',
  devicesBindTailscale: 'Tailscale',
  devicesBindRadmin: 'Radmin VPN',
  devicesBindLan: '局域网',
  devicesBindLoopback: '仅本机',
  devicesBindLanAddress: '局域网地址',
  devicesBindLanNone: '未找到局域网地址。',
  devicesBindRadminNone: '未找到 Radmin VPN 地址。',
  devicesStartFailed: '没能开启：{error}',
  devicesList: '已配对设备',
  devicesListDesc: '撤销后需重新配对。',
  devicesNone: '还没有配对过设备。',
  devicesPairedAt: '配对于 {time}',
  devicesLastSeen: '最近连接 {time}',
  devicesNever: '从未',
  devicesRevoke: '撤销',
  devicesRevokedAt: '已撤销 · {time}',
  devicesForget: '移除记录',
  devicesPeer: '砚对砚授权',
  devicesPeerDesc: '已连到这台电脑的其他砚；断开即失效。',
  devicesPeerNone: '当前没有其他砚连接。',
  devicesPeerRevoke: '断开',
  devicesSyncConfigured: '已配置：{path}',

  dataLocation: '数据位置',
  dataLocationDesc: '会话、凭证等数据的位置。',
  dataSize: '占用',
  dataMove: '移动到其它盘',
  dataTarget: '将迁移到：{path}',
  dataMoveConfirm: '迁移并重启',
  dataMoveScheduled: '已安排在下次启动砚时迁移数据。',
  dataMovePending: '已安排迁移到：{path}',
  dataMoving: '正在安排迁移…',
  dataOpen: '打开位置',
  dataNotMovable: '当前环境不支持移动数据目录。',
  dataStranded: '原位置丢失，迁移前备份在：{path}',
  dataLastFailed: '上次迁移失败：{error}',
  dataBackup: '备份与恢复',
  dataBackupDesc: '含会话、设置、书签、附件与成果；不含凭证和项目文件。',
  dataBackupCreate: '创建备份',
  dataBackupVerify: '校验备份',
  dataBackupWorking: '处理中…',
  dataBackupChecked: '已校验 {files} 个文件 · {size}',

  aboutVersion: '版本',
  aboutBuild: '构建',
  aboutOpenSource: '开源与仓库',
  aboutOpen: '打开项目主页',
  aboutPi: 'Agent 内核（pi）',
  aboutPiDesc: '当前 pi 入口及来源。',
  aboutRedetect: '重新检测',
  aboutRedetecting: '检测中…',
  aboutUpdates: '应用更新',
  aboutUpdateAuto: '启动时检查更新',
  aboutUpdateAutoDesc: '有新版本时提醒，不自动下载。',
  aboutUpdateCheck: '检查更新',
  aboutUpdateDownload: '下载',
  aboutUpdateInstall: '安装并重启',
  aboutUpdateReleases: '打开发布页',
  aboutUpdateInstallConfirm: '现在安装并重启？',
  aboutPhaseIdle: '未检查',
  aboutPhaseChecking: '检查中…',
  aboutPhaseCurrent: '已是最新',
  aboutPhaseAvailable: '有新版本',
  aboutPhaseDownloading: '下载中…',
  aboutPhaseDownloaded: '已下载，待安装',
  aboutPhaseError: '检查失败',
  aboutPhaseManual: '请到发布页手动更新'
}

const EN: GeneralText = {
  loading: 'Loading…',
  cancel: 'Cancel',
  confirm: 'Confirm',

  appearanceSendKey: 'Send key',
  appearanceSendKeyDesc: 'Shift+Enter always adds a newline.',
  appearanceSendKeyEnter: 'Enter',
  appearanceSendKeyCtrl: 'Ctrl+Enter',

  sessionContextLede: 'Native pi compaction, for all sessions.',
  sessionKeepAwakeBatteryOff: 'Turn on the option above first.',
  sessionAutoArchive: 'Archive idle sessions',
  sessionAutoArchiveDesc: 'Find them under Archived.',
  archiveNever: 'Never',
  archiveDays: '{n} days',
  sessionKeepAwake: 'Keep awake while running',
  sessionKeepAwakeDesc: 'Blocks system sleep until the run ends.',
  sessionKeepAwakeBattery: 'Also on battery',
  sessionKeepAwakeBatteryDesc: 'Off lets the system sleep on battery.',
  sessionCheckpoints: 'Save checkpoints before sending',
  sessionCheckpointsDesc: 'Rewind snapshots; off disables rewind.',
  sessionWrapUpCard: 'Show next-step suggestions',
  sessionWrapUpCardDesc: 'Only when a decision is needed.',
  sessionResponseDetail: 'Response detail',
  sessionResponseDetailDesc: 'Controls length, not thinking effort.',
  responseDetailBrief: 'Brief',
  responseDetailStandard: 'Standard',
  responseDetailDetailed: 'Detailed',
  sessionSubagentNotify: 'Notify parent when a subagent ends',
  sessionSubagentNotifyDesc: 'Wakes the parent to summarize.',
  sessionSubagentModel: 'Default subagent model',
  sessionSubagentModelDesc: 'Used when none is given; Follow uses the session model.',
  sessionSubagentModelFollow: 'Follow session',
  sessionSubagentModelForce: 'Always use the default model',
  sessionSubagentModelForceDesc: 'Ignore models named in the task.',
  sessionLoopAutoContinue: 'Auto-continue after a loop stop',
  sessionLoopAutoContinueDesc: 'Continue once after a safe stop; off waits for you.',
  sessionDelivery: 'Message delivery',
  sessionSteeringMode: 'Steering while running',
  sessionSteeringModeDesc: 'Mid-run messages, one by one or all at once.',
  sessionFollowUpMode: 'Queued messages',
  sessionFollowUpModeDesc: 'Queued messages, one by one or all at once.',
  queueOneAtATime: 'One at a time',
  queueAll: 'All at once',
  sessionAutoRetry: 'Auto-retry',
  sessionAutoRetryDesc: 'Retry on rate limits, overload and 5xx.',

  notifSystem: 'System notifications',
  notifSystemDesc: 'System notification when the window is in background.',
  notifSystemTest: 'Send',
  notifSystemTestLabel: 'Send a test notification',
  notifSystemNeedsSound: 'Turn on sounds first.',
  notifVolume: 'Volume',
  notifSystemHelp: 'The OS must allow notifications.',
  notifSound: 'Sound',
  notifSoundDesc: 'Off silences all events below.',
  notifEventDone: 'Turn done',
  notifEventQuestion: 'Needs you',
  notifEventError: 'Error',
  notifPreview: 'Preview',

  securityMode: 'Permission tier',
  securityModeDanger: 'Auto approve',
  securityModeDangerDesc: 'Asks before risky actions; a prompt, not a sandbox.',
  securityModeAll: 'Unrestricted',
  securityModeAllDesc: 'No approvals or blocks; confirm before switching.',
  securityAllConfirmTitle: 'Switch to “Unrestricted”?',
  securityAllConfirmBody: 'Risky commands and outside writes will no longer ask.',
  securityAllConfirmContinue: 'Switch anyway',
  securityOutside: 'Confirm writes outside the project',
  securityOutsideDesc: 'In Auto-approve, also ask before writing outside the project.',
  securityOutsideDisabled: 'Only applies in the auto-approve tier.',
  securityAllowRoots: 'Remembered allowed folders',
  securityAllowRootsDesc: 'Added when you choose Allow and remember.',
  securityAllowRootsEmpty: 'No folders remembered yet.',
  securityAllowRootsRemove: 'Remove',
  securityRemoteImages: 'Remote image allowlist',
  securityRemoteImagesDesc: 'Listed sites load directly; others need a click.',
  securityRemoteImagesManage: 'Manage',

  devicesEnable: 'Phone access',
  devicesEnableDesc: 'Phones can view and reply; tasks still run here.',
  devicesRunning: 'Running',
  devicesStopped: 'Stopped',
  devicesPair: 'Pair a new phone',
  devicesPairDesc: 'Scan the QR code or copy the link.',
  devicesPairStart: 'Generate pairing code',
  devicesPairCancel: 'Cancel pairing',
  devicesPairCode: 'Pairing code',
  devicesPairExpires: 'expires in {seconds}s',
  devicesPairCopy: 'Copy link',
  devicesPairCopied: 'Copied',
  devicesPairNeedsRunning: 'Turn on phone access first.',
  devicesPairLoopback: 'Local only; pick another address.',
  devicesPairQr: 'Pairing link QR code',
  devicesBind: 'Listen address',
  devicesBindDesc: 'Which network phones connect through.',
  devicesBindTailscale: 'Tailscale',
  devicesBindRadmin: 'Radmin VPN',
  devicesBindLan: 'LAN',
  devicesBindLoopback: 'This computer only',
  devicesBindLanAddress: 'LAN address',
  devicesBindLanNone: 'No LAN address found.',
  devicesBindRadminNone: 'No Radmin VPN address.',
  devicesStartFailed: 'Could not turn on: {error}',
  devicesList: 'Paired devices',
  devicesListDesc: 'Revoked devices must pair again.',
  devicesNone: 'No devices paired yet.',
  devicesPairedAt: 'paired {time}',
  devicesLastSeen: 'last seen {time}',
  devicesNever: 'never',
  devicesRevoke: 'Revoke',
  devicesRevokedAt: 'revoked · {time}',
  devicesForget: 'Forget',
  devicesPeer: 'Peer links',
  devicesPeerDesc: 'Other Inkstones linked here; disconnect to revoke.',
  devicesPeerNone: 'No other Inkstone machine is connected.',
  devicesPeerRevoke: 'Disconnect',
  devicesSyncConfigured: 'Configured: {path}',

  dataLocation: 'Data location',
  dataLocationDesc: 'Where sessions and credentials live.',
  dataSize: 'Size',
  dataMove: 'Move to another drive',
  dataTarget: 'Will move to: {path}',
  dataMoveConfirm: 'Move and restart',
  dataMoveScheduled: 'Scheduled: data will move the next time Inkstone starts.',
  dataMovePending: 'Scheduled to move to: {path}',
  dataMoving: 'Scheduling move…',
  dataOpen: 'Open location',
  dataNotMovable: 'Moving the data folder is not supported in this environment.',
  dataStranded: 'Old location is gone; pre-move backup: {path}',
  dataLastFailed: 'Last move failed: {error}',
  dataBackup: 'Backup and restore',
  dataBackupDesc: 'Sessions, settings, bookmarks, attachments and artifacts; no credentials or project files.',
  dataBackupCreate: 'Create backup',
  dataBackupVerify: 'Verify backup',
  dataBackupWorking: 'Working…',
  dataBackupChecked: 'Verified {files} files · {size}',

  aboutVersion: 'Version',
  aboutBuild: 'Build',
  aboutOpenSource: 'Open source & repository',
  aboutOpen: 'Open project home',
  aboutPi: 'Agent runtime (pi)',
  aboutPiDesc: 'Active pi entry and source.',
  aboutRedetect: 'Re-detect',
  aboutRedetecting: 'Detecting…',
  aboutUpdates: 'App updates',
  aboutUpdateAuto: 'Check for updates on start',
  aboutUpdateAutoDesc: 'Notify only; no auto download.',
  aboutUpdateCheck: 'Check',
  aboutUpdateDownload: 'Download',
  aboutUpdateInstall: 'Install and restart',
  aboutUpdateReleases: 'Open releases',
  aboutUpdateInstallConfirm: 'Install and restart now?',
  aboutPhaseIdle: 'Not checked',
  aboutPhaseChecking: 'Checking…',
  aboutPhaseCurrent: 'Up to date',
  aboutPhaseAvailable: 'Update available',
  aboutPhaseDownloading: 'Downloading…',
  aboutPhaseDownloaded: 'Downloaded, ready to install',
  aboutPhaseError: 'Check failed',
  aboutPhaseManual: 'Update manually from the releases page'
}

export function generalText(lang: Lang): GeneralText {
  return lang === 'en-US' ? EN : ZH
}
