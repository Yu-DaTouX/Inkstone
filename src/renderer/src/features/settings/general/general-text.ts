import type { Lang } from '../../../i18n'

export interface GeneralText {
  loading: string
  cancel: string
  confirm: string
  enabled: string

  sessionNote: string
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
  sessionLoopAutoContinue: string
  sessionLoopAutoContinueDesc: string

  notifNote: string
  notifSystem: string
  notifSystemDesc: string
  notifSystemTest: string
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
  securityDangerConfirm: string
  securityDangerConfirmDesc: string

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

  dataNote: string
  dataLocation: string
  dataLocationDesc: string
  dataSize: string
  dataMove: string
  dataPick: string
  dataTarget: string
  dataMoveConfirm: string
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
  dataExport: string
  dataExportDesc: string
  dataExportAction: string
  dataExportDone: string
  dataDangerNote: string
  dataUnavailable: string

  aboutNote: string
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
  aboutUpdateState: string
  aboutUpdateCheck: string
  aboutUpdateDownload: string
  aboutUpdateInstall: string
  aboutUpdateReleases: string
  aboutUpdateInstallConfirm: string
  aboutCredentials: string
  aboutCredentialsDesc: string
  aboutCredentialsAction: string
  aboutPhaseIdle: string
  aboutPhaseChecking: string
  aboutPhaseCurrent: string
  aboutPhaseAvailable: string
  aboutPhaseDownloading: string
  aboutPhaseDownloaded: string
  aboutPhaseError: string
  aboutPhaseManual: string
  aboutUnavailable: string
}

const ZH: GeneralText = {
  loading: '正在读取…',
  cancel: '取消',
  confirm: '确定',
  enabled: '已开启',

  sessionNote: '这些是会话的通用行为；默认模型与权限档在各自分区，改动立即写入设置。',
  sessionAutoArchive: '自动归档闲置会话',
  sessionAutoArchiveDesc: '超过天数没有动静、没置顶、没有运行实例的会话会被归档，随时可在「已归档」找回。',
  archiveNever: '从不',
  archiveDays: '{n} 天',
  sessionKeepAwake: '有会话在跑时保持电脑不睡眠',
  sessionKeepAwakeDesc: 'Agent 运行时阻止系统进入睡眠，跑完自动恢复。',
  sessionKeepAwakeBattery: '靠电池供电时也保持唤醒',
  sessionKeepAwakeBatteryDesc: '关闭后，拔掉电源时不再阻止睡眠。',
  sessionCheckpoints: '发送前给项目文件存检查点',
  sessionCheckpointsDesc: '每轮发送前留一次可回退的影子快照；关掉后回退能力不可用。',
  sessionSubagentNotify: '子 Agent 结束时通知发起会话',
  sessionSubagentNotifyDesc: '子 Agent 跑完后唤醒父会话继续汇总。',
  sessionLoopAutoContinue: '循环中止后自动继续',
  sessionLoopAutoContinueDesc: '安全中止后同一任务最多自动续一次，再次循环即停；关闭后等你发送。排队含图片时只告警，不自动中止。',

  notifNote: '提醒按事件分别开关；系统通知只会在窗口不在前台时弹出。',
  notifSystem: '系统通知',
  notifSystemDesc: '窗口不在前台时，用 Windows 通知中心提醒回合完成 / 需要回答 / 出错。',
  notifSystemTest: '试发一条',
  notifSystemHelp: '用于确认系统允许砚发通知；只在当前设备上弹一次。',
  notifSound: '提示音总开关',
  notifSoundDesc: '总开关关闭后，下面各事件既不出声也不通知。',
  notifEventDone: '回合完成',
  notifEventQuestion: '需要你回答',
  notifEventError: '出错',
  notifPreview: '试听',

  securityMode: '权限档',
  securityModeDanger: '自动批准（危险时问）',
  securityModeDangerDesc: '只有明确危险的操作才弹确认卡；缺省档。',
  securityModeAll: '不受限制',
  securityModeAllDesc: '砚不再审批也不拦截；需要一次确认。',
  securityAllConfirmTitle: '切到「不受限制」？',
  securityAllConfirmBody: '高危命令、写入项目之外等操作将不再询问。可随时切回。',
  securityAllConfirmContinue: '仍然切换',
  securityOutside: '写入项目之外时确认',
  securityOutsideDesc: '在「自动批准」档下，写到项目之外的路径前也弹确认卡。',
  securityOutsideDisabled: '仅在「自动批准」档生效。',
  securityAllowRoots: '已记住的允许目录',
  securityAllowRootsDesc: '在确认卡里选「允许并记住」后加入；这里只能移除，移除后下次写入会重新询问。',
  securityAllowRootsEmpty: '还没有记住任何目录。',
  securityAllowRootsRemove: '移除',
  securityDangerConfirm: '危险操作确认',
  securityDangerConfirmDesc: '强制推送、删除等危险命令在「自动批准」档下始终先问，不提供「全部允许」。',

  devicesEnable: '手机接入',
  devicesEnableDesc: '允许手机查看电脑上的会话、回复问题、发送文字；任务仍在这台电脑执行。',
  devicesRunning: '运行中',
  devicesStopped: '已停止',
  devicesPair: '配对新手机',
  devicesPairDesc: '用手机扫二维码，或复制链接；令牌只在配对那一刻交给手机。',
  devicesPairStart: '生成配对码',
  devicesPairCancel: '取消配对',
  devicesPairCode: '配对码',
  devicesPairExpires: '{seconds} 秒后过期',
  devicesPairCopy: '复制链接',
  devicesPairCopied: '已复制',
  devicesPairNeedsRunning: '先打开上面的「手机接入」开关。',
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

  dataNote: '数据默认在本机用户目录；移动目录与备份都是未来动作，需要你明确点击后才会执行。',
  dataLocation: '数据位置',
  dataLocationDesc: '会话、凭证、语音模型与浏览器配置的实际位置。',
  dataSize: '占用',
  dataMove: '移动到其它盘',
  dataPick: '选择目标目录',
  dataTarget: '将迁移到：{path}',
  dataMoveConfirm: '迁移并重启',
  dataMoving: '正在安排迁移…',
  dataOpen: '打开位置',
  dataNotMovable: '当前环境不支持移动数据目录。',
  dataStranded: '原位置不在，迁移前的备份还在：{path}',
  dataLastFailed: '上次迁移失败：{error}',
  dataBackup: '备份与校验',
  dataBackupDesc: '把设置与会话打成一个可校验的备份包。',
  dataBackupCreate: '创建备份',
  dataBackupVerify: '校验备份',
  dataBackupWorking: '处理中…',
  dataBackupChecked: '已校验 {files} 个文件 · {size}',
  dataExport: '导出会话',
  dataExportDesc: '把当前会话导出成文件，便于备份或换机；登录凭证不随会话导出。',
  dataExportAction: '导出当前会话',
  dataExportDone: '已导出：{path}',
  dataDangerNote: '迁移数据目录属于危险动作，只在上面的确认按钮被点击后才提交。',
  dataUnavailable: '数据接口尚未接线，暂时不能读取位置或备份。',

  aboutNote: '版本与构建信息来自当前安装包。',
  aboutVersion: '正式版本',
  aboutBuild: '构建',
  aboutOpenSource: '开源与仓库',
  aboutOpen: '打开项目主页',
  aboutPi: 'Agent 内核（pi）',
  aboutPiDesc: '当前使用哪个 pi 入口，以及来源。',
  aboutRedetect: '重新检测',
  aboutRedetecting: '检测中…',
  aboutUpdates: '应用更新',
  aboutUpdateAuto: '启动时检查更新',
  aboutUpdateAutoDesc: '发现新版本时在通知区留一条提醒；不自动下载。',
  aboutUpdateState: '更新状态',
  aboutUpdateCheck: '检查更新',
  aboutUpdateDownload: '下载',
  aboutUpdateInstall: '安装并重启',
  aboutUpdateReleases: '打开发布页',
  aboutUpdateInstallConfirm: '现在安装并重启？请先保存正在编辑的内容。',
  aboutCredentials: '模型凭证',
  aboutCredentialsDesc: '登录与 API Key 只在「模型与服务」分区配置，这里不重复。',
  aboutCredentialsAction: '去「模型与服务」',
  aboutPhaseIdle: '未检查',
  aboutPhaseChecking: '检查中…',
  aboutPhaseCurrent: '已是最新',
  aboutPhaseAvailable: '有新版本',
  aboutPhaseDownloading: '下载中…',
  aboutPhaseDownloaded: '已下载，待安装',
  aboutPhaseError: '检查失败',
  aboutPhaseManual: '请到发布页手动更新',
  aboutUnavailable: '更新接口尚未接线，暂时不能检查。'
}

const EN: GeneralText = {
  loading: 'Loading…',
  cancel: 'Cancel',
  confirm: 'Confirm',
  enabled: 'On',

  sessionNote: 'General session behaviour. Default model and permission tier live in their own sections; changes save immediately.',
  sessionAutoArchive: 'Auto-archive idle sessions',
  sessionAutoArchiveDesc: 'Sessions idle past the limit, not pinned and with no running instance are archived and can be restored from Archived.',
  archiveNever: 'Never',
  archiveDays: '{n} days',
  sessionKeepAwake: 'Keep the computer awake while running',
  sessionKeepAwakeDesc: 'Prevents sleep during a run and restores normal sleep afterwards.',
  sessionKeepAwakeBattery: 'Also on battery',
  sessionKeepAwakeBatteryDesc: 'When off, unplugging no longer blocks sleep.',
  sessionCheckpoints: 'Snapshot project files before sending',
  sessionCheckpointsDesc: 'Takes a rewindable shadow snapshot before each turn; rewind is unavailable when off.',
  sessionSubagentNotify: 'Notify the parent session when a subagent finishes',
  sessionSubagentNotifyDesc: 'Wakes the parent session to summarise after a subagent completes.',
  sessionLoopAutoContinue: 'Auto-continue after a loop stop',
  sessionLoopAutoContinueDesc: 'After a safe stop the same task continues at most once; a second loop stops. Off waits for you. With queued images it only warns and does not auto-stop.',

  notifNote: 'Alerts are toggled per event; system notifications only fire when the window is not focused.',
  notifSystem: 'System notifications',
  notifSystemDesc: 'Use the Windows notification centre for turn done / needs you / error while the window is unfocused.',
  notifSystemTest: 'Send one',
  notifSystemHelp: 'Checks that the system allows Inkstone notifications; shown once on this device.',
  notifSound: 'Sound',
  notifSoundDesc: 'When off, events neither chime nor notify.',
  notifEventDone: 'Turn done',
  notifEventQuestion: 'Needs you',
  notifEventError: 'Error',
  notifPreview: 'Preview',

  securityMode: 'Permission tier',
  securityModeDanger: 'Auto-approve (ask when dangerous)',
  securityModeDangerDesc: 'Only explicitly dangerous operations show a confirmation card; the default.',
  securityModeAll: 'Unrestricted',
  securityModeAllDesc: 'Inkstone no longer approves or blocks; requires one confirmation.',
  securityAllConfirmTitle: 'Switch to “Unrestricted”?',
  securityAllConfirmBody: 'Dangerous commands and writes outside the project will no longer ask. You can switch back at any time.',
  securityAllConfirmContinue: 'Switch anyway',
  securityOutside: 'Confirm writes outside the project',
  securityOutsideDesc: 'In the auto-approve tier, also show a confirmation card before writing outside the project.',
  securityOutsideDisabled: 'Only applies in the auto-approve tier.',
  securityAllowRoots: 'Remembered allowed folders',
  securityAllowRootsDesc: 'Added when you pick “allow and remember” on a confirmation card. You can only remove here; the next write asks again.',
  securityAllowRootsEmpty: 'No folders remembered yet.',
  securityAllowRootsRemove: 'Remove',
  securityDangerConfirm: 'Dangerous-operation confirmation',
  securityDangerConfirmDesc: 'Force-push, delete and similar always ask in auto-approve; there is no “allow all”.',

  devicesEnable: 'Phone access',
  devicesEnableDesc: 'Lets a phone view sessions, answer questions and send text; work still runs on this computer.',
  devicesRunning: 'Running',
  devicesStopped: 'Stopped',
  devicesPair: 'Pair a new phone',
  devicesPairDesc: 'Scan the QR with the phone or copy the link. The token is handed over only at pairing time.',
  devicesPairStart: 'Generate pairing code',
  devicesPairCancel: 'Cancel pairing',
  devicesPairCode: 'Pairing code',
  devicesPairExpires: 'expires in {seconds}s',
  devicesPairCopy: 'Copy link',
  devicesPairCopied: 'Copied',
  devicesPairNeedsRunning: 'Turn on Phone access above first.',
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

  dataNote: 'Data lives in the local user folder by default; moving and backups are future actions that require an explicit click.',
  dataLocation: 'Data location',
  dataLocationDesc: 'Where sessions, credentials, voice models and browser profile actually live.',
  dataSize: 'Size',
  dataMove: 'Move to another drive',
  dataPick: 'Choose target folder',
  dataTarget: 'Will move to: {path}',
  dataMoveConfirm: 'Move and restart',
  dataMoving: 'Scheduling move…',
  dataOpen: 'Open location',
  dataNotMovable: 'Moving the data folder is not supported in this environment.',
  dataStranded: 'The old location is gone; the pre-move backup is still here: {path}',
  dataLastFailed: 'Last move failed: {error}',
  dataBackup: 'Backup and verify',
  dataBackupDesc: 'Pack settings and sessions into a verifiable backup.',
  dataBackupCreate: 'Create backup',
  dataBackupVerify: 'Verify backup',
  dataBackupWorking: 'Working…',
  dataBackupChecked: 'Verified {files} files · {size}',
  dataExport: 'Export session',
  dataExportDesc: 'Export the current session for backup or another machine; credentials never travel with it.',
  dataExportAction: 'Export current session',
  dataExportDone: 'Exported: {path}',
  dataDangerNote: 'Moving the data folder is dangerous and is only submitted after the confirmation button above is clicked.',
  dataUnavailable: 'The data bridge is not wired, so location and backup cannot be read yet.',

  aboutNote: 'Version and build information come from the installed package.',
  aboutVersion: 'Release',
  aboutBuild: 'Build',
  aboutOpenSource: 'Open source & repository',
  aboutOpen: 'Open project home',
  aboutPi: 'Agent runtime (pi)',
  aboutPiDesc: 'Which pi entry is in use and where it comes from.',
  aboutRedetect: 'Re-detect',
  aboutRedetecting: 'Detecting…',
  aboutUpdates: 'App updates',
  aboutUpdateAuto: 'Check for updates on start',
  aboutUpdateAutoDesc: 'Leaves a notice when a new version exists; never auto-downloads.',
  aboutUpdateState: 'Update state',
  aboutUpdateCheck: 'Check',
  aboutUpdateDownload: 'Download',
  aboutUpdateInstall: 'Install and restart',
  aboutUpdateReleases: 'Open releases',
  aboutUpdateInstallConfirm: 'Install and restart now? Save anything you are editing first.',
  aboutCredentials: 'Model credentials',
  aboutCredentialsDesc: 'Sign-in and API keys are configured under Models & services only; not duplicated here.',
  aboutCredentialsAction: 'Open Models & services',
  aboutPhaseIdle: 'Not checked',
  aboutPhaseChecking: 'Checking…',
  aboutPhaseCurrent: 'Up to date',
  aboutPhaseAvailable: 'Update available',
  aboutPhaseDownloading: 'Downloading…',
  aboutPhaseDownloaded: 'Downloaded, ready to install',
  aboutPhaseError: 'Check failed',
  aboutPhaseManual: 'Update manually from the releases page',
  aboutUnavailable: 'The update bridge is not wired; cannot check yet.'
}

export function generalText(lang: Lang): GeneralText {
  return lang === 'en-US' ? EN : ZH
}
