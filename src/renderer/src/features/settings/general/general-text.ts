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
  appearanceSendKeyDesc: '另一种组合用来换行；Shift+Enter 始终换行。',
  appearanceSendKeyEnter: 'Enter',
  appearanceSendKeyCtrl: 'Ctrl+Enter',

  sessionContextLede: '压缩由 pi 原生完成，这里的设置对所有会话生效。',
  sessionKeepAwakeBatteryOff: '先打开上一项才能设置。',
  sessionAutoArchive: '自动归档闲置会话',
  sessionAutoArchiveDesc: '闲置会话自动归档，可在「已归档」找回。',
  archiveNever: '从不',
  archiveDays: '{n} 天',
  sessionKeepAwake: '有会话在跑时保持电脑不睡眠',
  sessionKeepAwakeDesc: 'Agent 运行时阻止系统进入睡眠，跑完自动恢复。',
  sessionKeepAwakeBattery: '靠电池供电时也保持唤醒',
  sessionKeepAwakeBatteryDesc: '关闭后，拔掉电源时不再阻止睡眠。',
  sessionCheckpoints: '发送前给项目文件存检查点',
  sessionCheckpointsDesc: '每轮发送前存可回退快照；关闭后无法回退。',
  sessionSubagentNotify: '子 Agent 结束时通知发起会话',
  sessionSubagentNotifyDesc: '子 Agent 跑完后唤醒父会话继续汇总。',
  sessionSubagentModel: '子 Agent 默认模型',
  sessionSubagentModelDesc: '没有指定模型时使用；选「跟随会话」则用当前会话的模型。',
  sessionSubagentModelFollow: '跟随会话',
  sessionSubagentModelForce: '强制使用默认模型',
  sessionSubagentModelForceDesc: '开启后，即使任务里指定了其他模型，也一律使用上面的默认模型。',
  sessionLoopAutoContinue: '循环停止后自动继续',
  sessionLoopAutoContinueDesc: '循环被安全停止后自动续一次；关闭则等你发送。',
  sessionDelivery: '消息投递',
  sessionSteeringMode: '运行中插话',
  sessionSteeringModeDesc: 'Agent 工作时发出的插话，在下一步之前逐条或一次全部送达。',
  sessionFollowUpMode: '排队消息',
  sessionFollowUpModeDesc: '排到本轮结束后的消息，逐条或一次全部送达。',
  queueOneAtATime: '逐条',
  queueAll: '全部',
  sessionAutoRetry: '自动重试',
  sessionAutoRetryDesc: '模型服务临时出错（限流、过载、5xx）时自动重试；开关立即对正在运行的会话生效。',

  notifSystem: '系统通知',
  notifSystemDesc: '窗口在后台时弹出系统通知。',
  notifSystemTest: '发送',
  notifSystemTestLabel: '试发一条系统通知',
  notifSystemNeedsSound: '先打开提示音总开关才能设置。',
  notifVolume: '音量',
  notifSystemHelp: '确认系统允许砚发通知。',
  notifSound: '提示音总开关',
  notifSoundDesc: '关闭后，下面各事件既不出声也不弹系统通知。',
  notifEventDone: '回合完成',
  notifEventQuestion: '需要你回答',
  notifEventError: '出错',
  notifPreview: '试听',

  securityMode: '权限档',
  securityModeDanger: '自动批准',
  securityModeDangerDesc: '常规操作直接执行，危险操作先问你；是提醒，不是沙箱。',
  securityModeAll: '不受限制',
  securityModeAllDesc: '砚不审批也不拦截，工具按原生行为执行；切换前需确认一次。',
  securityAllConfirmTitle: '切到「不受限制」？',
  securityAllConfirmBody: '高危命令和项目外写入将不再询问，可随时切回。',
  securityAllConfirmContinue: '仍然切换',
  securityOutside: '写入项目之外时确认',
  securityOutsideDesc: '「自动批准」档下，写项目之外前也要确认。',
  securityOutsideDisabled: '仅在「自动批准」档生效。',
  securityAllowRoots: '已记住的允许目录',
  securityAllowRootsDesc: '在确认卡选「允许并记住」后加入；只能移除。',
  securityAllowRootsEmpty: '还没有记住任何目录。',
  securityAllowRootsRemove: '移除',

  devicesEnable: '手机接入',
  devicesEnableDesc: '允许手机查看会话、回复、发文字；任务仍在本机运行。',
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
  devicesPairNeedsRunning: '先打开上面的「手机接入」开关。',
  devicesPairLoopback: '现在只监听本机，手机和其他电脑连不上；请先改选其他监听地址。',
  devicesPairQr: '配对链接二维码',
  devicesBind: '监听地址',
  devicesBindDesc: '手机或其他电脑通过哪张网络连进来。Tailscale 与 Radmin VPN 只在各自的虚拟局域网内可见；局域网对同一网络内的设备可见。',
  devicesBindTailscale: 'Tailscale',
  devicesBindRadmin: 'Radmin VPN',
  devicesBindLan: '局域网',
  devicesBindLoopback: '仅本机',
  devicesBindLanAddress: '局域网地址',
  devicesBindLanNone: '没有找到局域网地址，请确认已连上网络。',
  devicesBindRadminNone: '没有找到 Radmin VPN 地址，请先在 Radmin VPN 里连上网络。',
  devicesStartFailed: '没能开启：{error}',
  devicesList: '已配对设备',
  devicesListDesc: '撤销后设备需要重新配对才能连接。',
  devicesNone: '还没有配对过设备。',
  devicesPairedAt: '配对于 {time}',
  devicesLastSeen: '最近连接 {time}',
  devicesNever: '从未',
  devicesRevoke: '撤销',
  devicesRevokedAt: '已撤销 · {time}',
  devicesForget: '移除记录',
  devicesPeer: '砚对砚授权',
  devicesPeerDesc: '已连接到这台电脑的其他砚；断开即失效。',
  devicesPeerNone: '当前没有其他砚连接。',
  devicesPeerRevoke: '断开',
  devicesSyncConfigured: '已配置：{path}',

  dataLocation: '数据位置',
  dataLocationDesc: '会话、凭证等数据的存放位置。',
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
  dataBackup: '备份与校验',
  dataBackupDesc: '把设置与会话打成一个可校验的备份包。',
  dataBackupCreate: '创建备份',
  dataBackupVerify: '校验备份',
  dataBackupWorking: '处理中…',
  dataBackupChecked: '已校验 {files} 个文件 · {size}',

  aboutVersion: '版本',
  aboutBuild: '构建',
  aboutOpenSource: '开源与仓库',
  aboutOpen: '打开项目主页',
  aboutPi: 'Agent 内核（pi）',
  aboutPiDesc: '当前使用哪个 pi 入口，以及来源。',
  aboutRedetect: '重新检测',
  aboutRedetecting: '检测中…',
  aboutUpdates: '应用更新',
  aboutUpdateAuto: '启动时检查更新',
  aboutUpdateAutoDesc: '有新版本时提醒，不自动下载。',
  aboutUpdateCheck: '检查更新',
  aboutUpdateDownload: '下载',
  aboutUpdateInstall: '安装并重启',
  aboutUpdateReleases: '打开发布页',
  aboutUpdateInstallConfirm: '现在安装并重启？请先保存正在编辑的内容。',
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
  appearanceSendKeyDesc: 'The other combination adds a line; Shift+Enter always adds a line.',
  appearanceSendKeyEnter: 'Enter',
  appearanceSendKeyCtrl: 'Ctrl+Enter',

  sessionContextLede: 'Compaction is done natively by pi; these settings apply to all sessions.',
  sessionKeepAwakeBatteryOff: 'Turn on the option above first.',
  sessionAutoArchive: 'Auto-archive idle sessions',
  sessionAutoArchiveDesc: 'Idle sessions are archived; restore from Archived.',
  archiveNever: 'Never',
  archiveDays: '{n} days',
  sessionKeepAwake: 'Keep the computer awake while running',
  sessionKeepAwakeDesc: 'Prevents sleep during a run and restores normal sleep afterwards.',
  sessionKeepAwakeBattery: 'Also on battery',
  sessionKeepAwakeBatteryDesc: 'When off, unplugging no longer blocks sleep.',
  sessionCheckpoints: 'Snapshot project files before sending',
  sessionCheckpointsDesc: 'Snapshot before each turn; rewind is off when disabled.',
  sessionSubagentNotify: 'Notify the parent session when a subagent finishes',
  sessionSubagentNotifyDesc: 'Wakes the parent session to summarise after a subagent completes.',
  sessionSubagentModel: 'Default subagent model',
  sessionSubagentModelDesc: 'Used when a task names no model; "Follow session" uses the current session model.',
  sessionSubagentModelFollow: 'Follow session',
  sessionSubagentModelForce: 'Always use the default model',
  sessionSubagentModelForceDesc: 'When on, the default model is used even if a task names another one.',
  sessionLoopAutoContinue: 'Auto-continue after a loop stop',
  sessionLoopAutoContinueDesc: 'Continue once after a safe loop stop; off waits for you.',
  sessionDelivery: 'Message delivery',
  sessionSteeringMode: 'Steering while running',
  sessionSteeringModeDesc: 'Messages sent while the agent works arrive before its next step, one at a time or all at once.',
  sessionFollowUpMode: 'Queued messages',
  sessionFollowUpModeDesc: 'Messages queued for after the turn arrive one at a time or all at once.',
  queueOneAtATime: 'One at a time',
  queueAll: 'All at once',
  sessionAutoRetry: 'Auto-retry',
  sessionAutoRetryDesc: 'Retry automatically on transient provider errors (rate limits, overload, 5xx); the switch applies to running sessions immediately.',

  notifSystem: 'System notifications',
  notifSystemDesc: 'System notification when the window is in background.',
  notifSystemTest: 'Send',
  notifSystemTestLabel: 'Send a test notification',
  notifSystemNeedsSound: 'Turn on Sound first.',
  notifVolume: 'Volume',
  notifSystemHelp: 'Check that Inkstone may notify.',
  notifSound: 'Sound',
  notifSoundDesc: 'When off, the events below neither chime nor show a system notification.',
  notifEventDone: 'Turn done',
  notifEventQuestion: 'Needs you',
  notifEventError: 'Error',
  notifPreview: 'Preview',

  securityMode: 'Permission tier',
  securityModeDanger: 'Auto approve',
  securityModeDangerDesc: 'Routine operations run directly; dangerous operations require approval. This is a guardrail, not a sandbox.',
  securityModeAll: 'Unrestricted',
  securityModeAllDesc: 'No additional Inkstone approvals or interception; tools retain native behavior. Switching asks once.',
  securityAllConfirmTitle: 'Switch to “Unrestricted”?',
  securityAllConfirmBody: 'Dangerous commands and writes outside the project will no longer ask. You can switch back.',
  securityAllConfirmContinue: 'Switch anyway',
  securityOutside: 'Confirm writes outside the project',
  securityOutsideDesc: 'In auto-approve, also confirm writes outside the project.',
  securityOutsideDisabled: 'Only applies in the auto-approve tier.',
  securityAllowRoots: 'Remembered allowed folders',
  securityAllowRootsDesc: 'Added via “allow and remember”; you can only remove here.',
  securityAllowRootsEmpty: 'No folders remembered yet.',
  securityAllowRootsRemove: 'Remove',

  devicesEnable: 'Phone access',
  devicesEnableDesc: 'Phone can view sessions, reply and send text; tasks run here.',
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
  devicesPairNeedsRunning: 'Turn on Phone access above first.',
  devicesPairLoopback: 'Only this computer is listening, so phones and other computers cannot connect. Pick another listen address first.',
  devicesPairQr: 'Pairing link QR code',
  devicesBind: 'Listen address',
  devicesBindDesc: 'The network phones or other computers use to reach this one. Tailscale and Radmin VPN are only visible inside their virtual networks; LAN is visible to devices on the same network.',
  devicesBindTailscale: 'Tailscale',
  devicesBindRadmin: 'Radmin VPN',
  devicesBindLan: 'LAN',
  devicesBindLoopback: 'This computer only',
  devicesBindLanAddress: 'LAN address',
  devicesBindLanNone: 'No LAN address found. Check that you are connected to a network.',
  devicesBindRadminNone: 'No Radmin VPN address found. Join a network in Radmin VPN first.',
  devicesStartFailed: 'Could not turn on: {error}',
  devicesList: 'Paired devices',
  devicesListDesc: 'A revoked device must pair again before it can connect.',
  devicesNone: 'No devices paired yet.',
  devicesPairedAt: 'paired {time}',
  devicesLastSeen: 'last seen {time}',
  devicesNever: 'never',
  devicesRevoke: 'Revoke',
  devicesRevokedAt: 'revoked · {time}',
  devicesForget: 'Forget',
  devicesPeer: 'Peer links',
  devicesPeerDesc: 'Other Inkstone machines connected to this computer; disconnecting ends the grant.',
  devicesPeerNone: 'No other Inkstone machine is connected.',
  devicesPeerRevoke: 'Disconnect',
  devicesSyncConfigured: 'Configured: {path}',

  dataLocation: 'Data location',
  dataLocationDesc: 'Where sessions, credentials and other data live.',
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
  dataBackup: 'Backup and verify',
  dataBackupDesc: 'Pack settings and sessions into a verifiable backup.',
  dataBackupCreate: 'Create backup',
  dataBackupVerify: 'Verify backup',
  dataBackupWorking: 'Working…',
  dataBackupChecked: 'Verified {files} files · {size}',

  aboutVersion: 'Version',
  aboutBuild: 'Build',
  aboutOpenSource: 'Open source & repository',
  aboutOpen: 'Open project home',
  aboutPi: 'Agent runtime (pi)',
  aboutPiDesc: 'Which pi entry is in use and where it comes from.',
  aboutRedetect: 'Re-detect',
  aboutRedetecting: 'Detecting…',
  aboutUpdates: 'App updates',
  aboutUpdateAuto: 'Check for updates on start',
  aboutUpdateAutoDesc: 'Notify on new versions; never auto-download.',
  aboutUpdateCheck: 'Check',
  aboutUpdateDownload: 'Download',
  aboutUpdateInstall: 'Install and restart',
  aboutUpdateReleases: 'Open releases',
  aboutUpdateInstallConfirm: 'Install and restart now? Save anything you are editing first.',
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
