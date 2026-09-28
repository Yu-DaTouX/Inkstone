/**
 * 砚对砚互通（需求稿 5.4 / 第 6 节）：两台运行砚的电脑之间的结构化访问。
 *
 * 与手机接入共用配对与传输（`remote-protocol.ts`），但授权模型不同：
 *   · 手机是**自己的设备**，配对即可访问（现有行为不变）；
 *   · 对方砚可能属于**别人**。配对只建立身份，令牌本身不授予任何权限。
 *     每次连接都要由这台电脑的所有者批准「本次连接」的项目与操作范围。
 *
 * 本次连接授权的规则（第 6 节）：
 *   · 所有者勾选开放的项目和允许的操作类别；超出范围的请求一律拒绝，需要重新申请；
 *   · 授权只存在内存里，绑定对方保持的事件流：流断开即失效，重连必须重新批准，
 *     砚重启后全部失效；所有者可随时撤销；
 *   · 查看是读取对方开放的内容；导入是在接收方形成带来源的副本。两者分开授权；
 *   · 凭证、个人记忆不在开放范围内；敏感确认仍只能在电脑本机处理。
 *
 * 只放纯类型与常量。
 */

/** 操作类别：查看 / 复制副本（会话、成果、项目记忆）/ 发消息与中止任务 */
export type PeerOperation = 'read' | 'transfer' | 'send'
export const PEER_OPERATIONS: PeerOperation[] = ['read', 'transfer', 'send']

/** 对方砚发起连接后，等所有者批准的最长时间 */
export const PEER_APPROVAL_TIMEOUT_MS = 2 * 60_000
/** 批准后必须在这段时间内打开事件流，否则授权作废 */
export const PEER_ACTIVATION_TIMEOUT_MS = 30_000
/** 请求头：本次连接的 id */
export const PEER_CONNECTION_HEADER = 'x-yan-connection'
/** 单次导入的成果文件上限（与手机下载一致） */
export const PEER_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024

/** POST /remote/v1/peer/connect */
export interface PeerConnectRequest {
  operations: PeerOperation[]
  /** 连接者写给所有者的说明（最多 200 字） */
  note?: string
}

export interface PeerProjectRef {
  id: string
  name: string
}

/** 所有者批准后的授权（连接者也会收到一份，用来显示自己能做什么） */
export interface PeerGrantView {
  connectionId: string
  deviceId: string
  deviceName: string
  projects: PeerProjectRef[]
  operations: PeerOperation[]
  grantedAt: number
  /** 事件流打开的时间；null = 已批准但还没连上 */
  activatedAt: number | null
}

/** 推给所有者界面的审批请求 */
export interface PeerApprovalRequest {
  requestId: string
  deviceId: string
  deviceName: string
  operations: PeerOperation[]
  note: string
  /** 可以开放的项目（所有者从中勾选） */
  projects: PeerProjectRef[]
  expiresAt: number
}

export interface PeerApprovalDecision {
  requestId: string
  approve: boolean
  projectIds: string[]
  operations: PeerOperation[]
}

/* ── 导出包：对方砚复制一份会话时拿到的内容 ─────────────────── */

export interface PeerExportedArtifact {
  id: string
  filename: string
  mediaType: string
  bytes: number
  /** 源电脑上文件是否还在；不在时接收方标为缺失，不假装已传输 */
  available: boolean
}

export interface PeerSessionExport {
  version: 1
  source: {
    computer: string
    sessionId: string
    projectId: string
    projectName: string
    title: string
    exportedAt: number
    updatedAt: number
    messageCount: number
  }
  /** 会话消息（去掉电脑上的绝对路径与内嵌图片数据） */
  messages: unknown[]
  artifacts: PeerExportedArtifact[]
  truncated: boolean
}

/** 共享项目记忆：只导出已确认条目，保留作者（源电脑）与版本 */
export interface PeerKnowledgeExport {
  version: 1
  source: { computer: string; projectId: string; projectName: string; exportedAt: number }
  entries: Array<{ id: string; revision: number; kind: string; text: string; tags: string[]; confidenceClass: string; updatedAt: string }>
}

/* ── 连接者一侧 ─────────────────────────────────────────────── */

/** 本机保存的对方砚（令牌加密存放，不在这里出现） */
export interface PeerRecordView {
  id: string
  /** 对方电脑名（配对时对方报告） */
  computer: string
  address: string
  pairedAt: number
}

export type PeerConnectionState =
  | { state: 'idle' }
  | { state: 'waiting'; since: number }
  | { state: 'connected'; grant: PeerGrantView }
  | { state: 'failed'; error: string }

export interface PeerStatusView {
  peers: Array<PeerRecordView & { connection: PeerConnectionState }>
  imports: PeerImportView[]
}

/** 已导入的副本 */
export interface PeerImportView {
  id: string
  kind: 'session'
  title: string
  computer: string
  projectName: string
  sourceSessionId: string
  importedAt: number
  exportedAt: number
  messageCount: number
  artifacts: Array<{ id: string; filename: string; status: 'copied' | 'missing' | 'too_large' }>
}
