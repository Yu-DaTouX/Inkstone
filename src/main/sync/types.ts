/**
 * 跨设备同步（WP-53 A 阶段）的数据形状。
 *
 * 这里是纯类型定义，不依赖 Electron / pi：同步核心可以在 Node 里直接跑，
 * 接线层（IPC、设置界面）只负责把真实路径与文件夹传进来。
 *
 * 一条记录 = 一个可独立同步的最小单元（一份设置、一个提示词模板、一个技能、
 * 一条书签、一个定时任务定义），带稳定的设备无关 key。冲突与合并都以「条」为单位。
 */

/** 参与同步的类别。会话本体不在其中，只提供导出 / 导入。 */
export type SyncRecordKind = 'settings' | 'prompt' | 'skill' | 'bookmark' | 'schedule'

/** 本地读出的一条记录（尚未带设备信息）。 */
export interface SyncRecord {
  /** 设备无关的稳定标识，例如 `settings`、`prompt:review`、`schedule:ab12cd34`。 */
  key: string
  kind: SyncRecordKind
  /** 规范化后的内容：文件类为原文，对象类为键序稳定的 JSON。 */
  payload: string
  /** 本机看到的最后修改时间（毫秒）；只用于展示与冲突副本命名。 */
  modifiedAt: number
}

/** 同步目录里落盘的一条记录。 */
export interface RemoteRecord extends SyncRecord {
  deviceId: string
  deviceName: string
  /** payload 的 sha256；用于跨设备比对内容是否一致。 */
  hash: string
}

/** 本机上次同步的基线：记住每一端当时的 payload 哈希。 */
export interface BaselineEntry {
  /** 上次同步后本机版本的哈希（没有本机版本时缺省）。 */
  localHash?: string
  /** 上次同步后同步目录里版本的哈希（没有远端版本时缺省）。 */
  remoteHash?: string
  syncedAt: number
}

export interface BaselineFile {
  v: 1
  deviceId: string
  records: Record<string, BaselineEntry>
}

/** 冲突记录：两端自上次同步后都改过同一条且内容不同。两份都保留。 */
export interface ConflictRecord {
  id: string
  key: string
  kind: SyncRecordKind
  detectedAt: number
  /** 本机（保留不动）版本的信息。 */
  localDeviceId?: string
  localDeviceName?: string
  localModifiedAt?: number
  localHash?: string
  localPayload?: string
  /** 他端版本的信息；会被写成带设备名与时间后缀的副本。 */
  remoteDeviceId: string
  remoteDeviceName: string
  remoteModifiedAt: number
  remoteHash: string
  remotePayload: string
  /** 人类可读的后缀，供界面显示，例如「来自 DESKTOP-B · 2026-10-15 12-00-00」。 */
  suffix: string
}

/** 一次同步的结果。任何一项失败都不抛异常，如实记进 skipped / errors。 */
export interface SyncReport {
  ok: boolean
  deviceId: string
  deviceName: string
  /** 本机版本写进同步目录的 key。 */
  pushed: string[]
  /** 他端版本合并进本机的 key。 */
  pulled: string[]
  /** 本次检测到的冲突。 */
  conflicts: ConflictRecord[]
  /** 读不了或形状不对、已跳过的文件（绝对路径 + 原因）。 */
  skipped: string[]
  errors: string[]
  at: number
}

export interface SyncPaths {
  settingsFile: string
  promptsDir: string
  skillsDir: string
  schedulesFile: string
  interactionStateDir: string
}
