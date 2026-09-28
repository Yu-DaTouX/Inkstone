/**
 * 砚远程协议（电脑 ↔ 手机）。桌面端 `src/main/remote-server.ts` 与手机客户端共用这份定义。
 *
 * 边界（需求稿 5.2 / 6）：
 *   · 任务始终在电脑上执行；手机查看状态、回复问题、提交文字（语音转写后也是文字）。
 *   · 砚桌面应用运行期间才可访问；手机断线不终止电脑上的任务。
 *   · 网络可达 ≠ 获得权限：每台手机单独配对、单独令牌、可随时撤销。
 *   · 标记为敏感的确认（删除、授权、付费……）手机只能看，必须在电脑上确认。
 *   · 断线恢复靠事件序号补齐；写操作带幂等键，重复提交不重复执行。
 *
 * 只放纯类型与常量：不依赖 Electron、Node 或 React Native 运行时。
 */

export const REMOTE_PROTOCOL_VERSION = 2
/** 默认监听端口（与 v1 相同，便于已有客户端继续连接） */
export const REMOTE_DEFAULT_PORT = 37892
/** 配对码有效期 */
export const REMOTE_PAIRING_TTL_MS = 5 * 60_000
/** 配对码：6 位数字，由电脑端显示、手机端输入 */
export const REMOTE_PAIRING_CODE_RE = /^\d{6}$/
/** 事件补齐的缓冲条数；断线超过这么多事件时，客户端应改为整体刷新 */
export const REMOTE_EVENT_BUFFER = 1_000
/** 写操作的幂等键：客户端生成，同一键在有效期内只执行一次 */
export const REMOTE_IDEMPOTENCY_HEADER = 'idempotency-key'
export const REMOTE_IDEMPOTENCY_TTL_MS = 10 * 60_000
export const REMOTE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/
/** 手机端下载单个成果文件的上限 */
export const REMOTE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024

/** GET /remote/v1/info */
export interface RemoteInfo {
  ok: true
  apiVersion: number
  transport: Array<'http' | 'sse'>
  tokenRequired: true
  capabilities: string[]
  /** 当前令牌对应的设备（使用旧的一次性环境变量令牌时为 null） */
  device: RemoteDeviceSummary | null
  computer?: { name: string }
}

/* ---------------------------------------------------------------- 配对与设备 */

/** POST /remote/v1/pair（不需要令牌；配对码有效期内一次有效） */
export interface RemotePairRequest {
  code: string
  /** 手机自报的名称，只用于在电脑上辨认，最多 60 字 */
  deviceName: string
  /**
   * 设备类型：缺省 phone（自己的手机，配对即可访问）；
   * peer 是另一台砚，配对只建立身份，每次连接另需所有者批准（见 peer-protocol.ts）。
   */
  kind?: 'phone' | 'peer'
}

export interface RemotePairResponse {
  ok: true
  deviceId: string
  /** 只在配对这一刻返回一次；电脑端只存它的哈希 */
  token: string
  apiVersion: number
  computer?: { name: string }
  device?: RemoteDeviceSummary
}

export interface RemoteImageInput {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  data: string
}

export interface RemoteModel {
  id: string
  provider: string
  name: string
  input?: string[]
}

export interface RemoteDeviceSummary {
  id: string
  name: string
  /** 缺省（旧记录）按 phone 处理 */
  kind?: 'phone' | 'peer'
  createdAt: number
  lastSeenAt: number | null
}

/** 电脑端设置页看到的设备（含撤销状态） */
export interface RemoteDeviceRecord extends RemoteDeviceSummary {
  revokedAt: number | null
}

/** 电脑端设置页的远程访问状态 */
export interface RemoteAccessStatus {
  enabled: boolean
  running: boolean
  host: string
  port: number
  /** 可供手机填写的地址（Tailscale IP 优先，其次局域网地址） */
  addresses: Array<{ kind: 'tailscale' | 'lan' | 'loopback'; address: string }>
  pairing: { code: string; expiresAt: number } | null
  devices: RemoteDeviceRecord[]
  /** 当前有效的砚对砚连接授权（本次连接，断开即失效） */
  grants: import('./peer-protocol').PeerGrantView[]
  error: string | null
}

export interface RemoteAccessSettings {
  enabled: boolean
  /** 监听地址：'tailscale' 自动取 Tailscale IP；'loopback' 只在本机；也可填具体 IP */
  bind: 'tailscale' | 'loopback' | string
  port: number
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
  bind: 'tailscale',
  port: REMOTE_DEFAULT_PORT
}

/* ---------------------------------------------------------------- 事件流 */

/**
 * GET /remote/v1/events?since=<seq>（SSE）。
 *
 * 每条事件带单调递增的 `seq`。重连时带上最后收到的 seq，服务端补发之后的事件；
 * 缓冲里已经没有那么早的事件时，先发一条 `resync`，客户端应重新拉取快照与历史。
 */
export interface RemoteEventEnvelope {
  seq: number
  at: number
  channel: string
  payload: unknown
  runtime?: unknown
}

export interface RemoteResyncEvent {
  reason: 'buffer_overflow' | 'server_restarted'
  latestSeq: number
}

/* ---------------------------------------------------------------- 问题 */

/** GET /remote/v1/questions：当前等待回答的问题（按会话） */
export interface RemotePendingQuestion {
  id: string
  sessionId: string | null
  runId: string
  method: 'select' | 'input' | 'confirm' | 'editor'
  title: string
  message: string
  options?: string[]
  placeholder?: string
  /** 敏感确认：手机只能查看，需要在电脑上处理 */
  sensitive: boolean
  /** 0 = 电脑端还没开始计时 */
  deadline: number
}

/** POST /remote/v1/questions/:id/answer（需要幂等键） */
export type RemoteAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

/* ---------------------------------------------------------------- 成果 */

/** 历史消息里的成果在远程端只保留这些字段（不带电脑上的绝对路径） */
export interface RemoteArtifact {
  id: string
  filename: string
  mediaType: string
  kind: 'image' | 'svg' | 'code' | 'document' | 'binary'
  bytes: number
  createdAt: number
  previewable: boolean
  unavailable?: boolean
}

/* ---------------------------------------------------------------- 错误 */

export interface RemoteError {
  ok: false
  error: string
  /** 机器可读的原因（例如 'sensitive_confirmation_requires_desktop'） */
  code?: string
}
