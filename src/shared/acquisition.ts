/**
 * 接入事务的契约（实施-04 §10）—— **纯逻辑**：不碰文件系统、不碰网络、不读凭证。
 *
 * ── 为什么状态机与校验要单独放在这里 ──
 *   接入是整条能力链上**唯一会往本机写东西**的一步（下载文件、登记 receipt、
 *   必要时装包）。它最容易出的错不是「HTTP 失败」，而是**顺序与判据**：
 *   没验证就激活、重试时又装一遍、失败时把用户已有安装一起删了、
 *   把「事务日志写过 activated」当成「资源真的可用」。
 *   这些判断写成纯函数，单测才能直接构造状态去验，不必真的联网装包。
 *
 * ── 三条红线（对应 §10 / §10.1 / §10.2）──
 *   1. **同一个事务只有一个 operationId**：重试复用同一个 ID，不能装两次。
 *   2. **失败只清理本次受管 staging**，用户已有的安装一个字节都不碰。
 *   3. **日志不是证据**：`activated` 只表示我们记录过这一步，
 *      真资源是否可用由 `resumed` 前的复核（receipt + 文件 hash + 连接）决定。
 */

/* ------------------------------------------------------------------ 状态机 */

/**
 * 正常路径的状态序列；分支态另列。
 * `pending-boundary` **不是终态**：它是「本轮不能装，等当前回合安全结束再进 acquiring」，
 * 所以它必须能回到主路径（§10.1：pi 包不能在 `acquire` 内部等回合结束，那会互相等待）。
 */
export const ACQUISITION_MAIN_PATH = [
  'discovered',
  'inspected',
  'prepared',
  'acquiring',
  'verifying',
  'activated',
  'resumed'
] as const

export const ACQUISITION_BRANCH_STATES = [
  'needs-auth',
  'needs-authorization',
  'pending-boundary',
  'failed',
  'cancelled'
] as const

export type AcquisitionMainState = (typeof ACQUISITION_MAIN_PATH)[number]
export type AcquisitionState = AcquisitionMainState | (typeof ACQUISITION_BRANCH_STATES)[number]

/** 不再自动推进的状态。`pending-boundary` 故意不在里面 —— 它等的是调度，不是用户。 */
export const ACQUISITION_TERMINAL_STATES: readonly AcquisitionState[] = [
  'resumed',
  'failed',
  'cancelled',
  'needs-auth',
  'needs-authorization'
]

const MAIN_TRANSITIONS: Record<AcquisitionMainState, readonly AcquisitionState[]> = {
  discovered: ['inspected', 'failed', 'cancelled'],
  inspected: ['prepared', 'failed', 'cancelled'],
  prepared: ['acquiring', 'needs-auth', 'needs-authorization', 'pending-boundary', 'failed', 'cancelled'],
  /* 装完之后要先**验证**才能激活；verifying 失败可以退回 prepared 重试（同一 operationId）。 */
  acquiring: ['verifying', 'failed', 'cancelled'],
  /* `pending-boundary` 也可从验证后进入：制品已核验，但本 runner 还不能热加载/重启。 */
  verifying: ['activated', 'prepared', 'pending-boundary', 'failed', 'cancelled'],
  activated: ['resumed', 'failed', 'cancelled'],
  resumed: []
}

const BRANCH_TRANSITIONS: Partial<Record<AcquisitionState, readonly AcquisitionState[]>> = {
  'needs-auth': ['prepared', 'cancelled'],
  'needs-authorization': ['prepared', 'cancelled'],
  /* 边界解除后回到主路径；也可以被取消。 */
  'pending-boundary': ['acquiring', 'failed', 'cancelled'],
  failed: ['prepared', 'cancelled'],
  cancelled: []
}

export function isTerminalAcquisitionState(state: AcquisitionState): boolean {
  return ACQUISITION_TERMINAL_STATES.includes(state)
}

export function allowedAcquisitionTransitions(state: AcquisitionState): readonly AcquisitionState[] {
  const main = MAIN_TRANSITIONS[state as AcquisitionMainState]
  if (main) return main
  return BRANCH_TRANSITIONS[state] ?? []
}

export function canTransitionAcquisition(from: AcquisitionState, to: AcquisitionState): boolean {
  return allowedAcquisitionTransitions(from).includes(to)
}

export class AcquisitionTransitionError extends Error {
  constructor(
    readonly from: AcquisitionState,
    readonly to: AcquisitionState
  ) {
    super(`接入事务不能从 ${from} 走到 ${to}`)
    this.name = 'AcquisitionTransitionError'
  }
}

/* ---------------------------------------------------------------- 事务形状 */

/** §10.2：每个接入事务**一次**正常重试 —— 也就是最多执行两次。 */
export const MAX_ACQUIRE_ATTEMPTS = 2

export type AcquisitionFailureCode =
  | 'network'
  | 'integrity'
  | 'permission'
  | 'unsupported-runtime'
  | 'verification'
  | 'cancelled'
  | 'unknown'

export type AcquisitionStep = {
  at: string
  from: AcquisitionState
  to: AcquisitionState
  detail?: string
}

/**
 * receipt 是「这次接入登记了什么」的凭据。
 *
 * `verification` 是**验证方式**而不是结论：`files-present` 只说明文件在，
 * 不代表能用；`smoke-passed` 才是真的跑过一次无副作用冒烟（§10.1 第 5 条）。
 */
export type CapabilityReceipt = {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  /** 候选内容的稳定指纹：源变了（版本 / commit / integrity）旧 receipt 就作废。 */
  digest: string
  scope: 'project-managed'
  projectId: string
  installedPaths: string[]
  verification: 'files-present' | 'protocol-reachable' | 'smoke-passed'
  activatedAt: string
}

/**
 * 持久的 pi 包激活目标。进程重启后调度器只能按这份宿主记录定位 runner；
 * 不从模型回传的 plan 或包内 metadata 推断目录 / 会话。
 */
export type PiPackageActivationTarget = {
  runnerId: string
  runnerGeneration: number
  cwd: string
  sessionFile: string
  projectId: string
  /** Goal snapshot that requested this package; activation must not resume a newer goal. */
  goalId: string
  goalRevision: number
  sourceHead: string | null
  continueId: string
  packageName: string
  packageVersion: string
}

/** 持久的项目 Skill 文件激活目标；字段只用于恢复原 runner，不从模型回传的路径推断。 */
export type SkillFilesActivationTarget = {
  runnerId: string
  runnerGeneration: number
  cwd: string
  sessionFile: string
  projectId: string
  goalId: string
  goalRevision: number
  sourceHead: string | null
  continueId: string
}

export type AcquisitionTransaction = {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  digest: string
  projectId: string
  state: AcquisitionState
  attempts: number
  createdAt: string
  updatedAt: string
  stagingDir?: string
  piPackageTarget?: PiPackageActivationTarget
  skillFilesTarget?: SkillFilesActivationTarget
  receipt?: CapabilityReceipt
  failure?: { code: AcquisitionFailureCode; detail: string }
  history: AcquisitionStep[]
}

export function newAcquisitionTransaction(input: {
  operationId: string
  planId: string
  planRevision: number
  candidateId: string
  digest: string
  projectId: string
  at: string
}): AcquisitionTransaction {
  return {
    operationId: input.operationId,
    planId: input.planId,
    planRevision: input.planRevision,
    candidateId: input.candidateId,
    digest: input.digest,
    projectId: input.projectId,
    state: 'prepared',
    /*
     * 从 prepared 起步：`discovered` / `inspected` 属于**发现链**（S5 已完成），
     * 接入事务只从「计划已经生成」开始记。把它当成 1 表示「计划本身不算一次安装尝试」。
     */
    attempts: 0,
    createdAt: input.at,
    updatedAt: input.at,
    history: []
  }
}

/** 记录一次状态迁移；非法迁移**抛错**，不静默改状态（否则日志会自相矛盾）。 */
export function advanceAcquisition(
  tx: AcquisitionTransaction,
  to: AcquisitionState,
  patch: { at: string; detail?: string; stagingDir?: string; receipt?: CapabilityReceipt; failure?: { code: AcquisitionFailureCode; detail: string } } = {
    at: new Date().toISOString()
  }
): AcquisitionTransaction {
  if (!canTransitionAcquisition(tx.state, to)) throw new AcquisitionTransitionError(tx.state, to)
  const from = tx.state
  const next: AcquisitionTransaction = {
    ...tx,
    state: to,
    updatedAt: patch.at,
    history: [...tx.history, { at: patch.at, from, to, ...(patch.detail ? { detail: patch.detail } : {}) }]
  }
  if (patch.stagingDir !== undefined) next.stagingDir = patch.stagingDir
  if (patch.receipt !== undefined) next.receipt = patch.receipt
  if (patch.failure !== undefined) next.failure = patch.failure
  /*
   * `pending-boundary → acquiring` 是同一次尝试从下载阶段续到安装阶段，不能额外耗掉
   * 一次重试额度；只有从 prepared 开始一轮（首次或显式 retry）才计数。
   */
  if (to === 'acquiring' && tx.state === 'prepared') next.attempts = tx.attempts + 1
  return next
}

/** 还能不能再试一次：只在 failed 且尝试次数未用满时允许，并且**复用同一 operationId**。 */
export function canRetryAcquisition(tx: AcquisitionTransaction): boolean {
  return tx.state === 'failed' && tx.attempts < MAX_ACQUIRE_ATTEMPTS
}

/**
 * 重试入口：failed → prepared。
 * 之所以回到 `prepared` 而不是直接 `acquiring`，是为了让「重试」也走一遍
 * 与首次相同的迁移序列（日志里能看出这是第二次尝试）。
 */
export function retryAcquisition(tx: AcquisitionTransaction, at: string): AcquisitionTransaction {
  if (!canRetryAcquisition(tx)) {
    throw new Error(`这个事务不能重试（state=${tx.state}, attempts=${tx.attempts}/${MAX_ACQUIRE_ATTEMPTS}）`)
  }
  const next = advanceAcquisition(tx, 'prepared', { at, detail: `第 ${tx.attempts + 1} 次尝试` })
  /* 上次失败的证据不能冒充新一轮的 staging 或 receipt。 */
  delete next.stagingDir
  delete next.receipt
  delete next.failure
  return next
}

export function receiptMatches(
  receipt: CapabilityReceipt,
  expected: { planId: string; digest: string; planRevision?: number }
): boolean {
  if (receipt.planId !== expected.planId) return false
  if (receipt.digest !== expected.digest) return false
  if (expected.planRevision !== undefined && receipt.planRevision !== expected.planRevision) return false
  return true
}

/* ------------------------------------------------------------ 文件集校验 */

/**
 * staging 的上限（§10 第 2 条：拒绝路径穿越与**解压膨胀**）。
 *
 * 数字取的是「比任何真实 Skill / MCP 包都宽，但小到炸不动磁盘」：
 * Skill 正文是几十 KB，MCP 包（含 node_modules）通常几 MB；
 * 32 MB / 2000 个文件足够覆盖，又让 zip 炸弹在第一层就被拦掉。
 */
export const ARTIFACT_LIMITS = {
  maxFiles: 2000,
  maxBytes: 32 * 1024 * 1024,
  maxPathLength: 200
} as const

export type ArtifactLimits = {
  maxFiles: number
  maxBytes: number
  maxPathLength: number
}

export type ArtifactEntry = {
  /** 归档里的相对路径（`/` 分隔）。 */
  path: string
  bytes: number
  symlink?: boolean
  kind?: 'file' | 'dir'
}

export type ArtifactRejection = {
  code:
    | 'empty'
    | 'path-traversal'
    | 'absolute-path'
    | 'path-too-long'
    | 'duplicate-path'
    | 'symlink-not-allowed'
    | 'too-many-files'
    | 'too-large'
    | 'negative-size'
  detail: string
  path?: string
}

/**
 * 归一化归档条目路径；不合法返回 `null`。
 *
 * 为什么把 `\` 也当分隔符：Windows 上 zip 条目两种写法都有，
 * 只判 `/` 会漏掉 `..\..\evil`。归一化之后再判 `..` 才是完整的。
 */
export function normalizeArtifactPath(raw: string): string | null {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  if (text.includes('\u0000')) return null
  const unified = text.replace(/\\/g, '/')
  if (unified.startsWith('/')) return null
  /* 盘符（`C:/…`）与 UNC 都是绝对路径。 */
  if (/^[A-Za-z]:/.test(unified)) return null
  const parts: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (parts.length === 0) return null
  return parts.join('/')
}

/**
 * 校验整个文件集。返回 `null` 表示通过。
 *
 * 注意校验的**不是**「内容可信」—— 那是来源核对与冒烟的事；
 * 这里只回答「这个归档有没有资格落到 staging」。
 */
export function validateArtifactEntries(
  entries: readonly ArtifactEntry[],
  limits: ArtifactLimits = ARTIFACT_LIMITS
): ArtifactRejection | null {
  if (entries.length === 0) {
    return { code: 'empty', detail: '归档里一个文件都没有（拒绝空接入）' }
  }
  if (entries.length > limits.maxFiles) {
    return {
      code: 'too-many-files',
      detail: `文件数 ${entries.length} 超过上限 ${limits.maxFiles}（可能是解压膨胀）`
    }
  }
  const seen = new Set<string>()
  let totalBytes = 0
  for (const entry of entries) {
    const normalized = normalizeArtifactPath(entry.path)
    if (normalized === null) {
      const looksAbsolute = /^([A-Za-z]:|[\\/])/.test(String(entry.path ?? '').trim())
      return {
        code: looksAbsolute ? 'absolute-path' : 'path-traversal',
        detail: `不接受的归档路径：${JSON.stringify(entry.path)}`,
        path: String(entry.path ?? '')
      }
    }
    if (normalized.length > limits.maxPathLength) {
      return {
        code: 'path-too-long',
        detail: `路径过长（${normalized.length} > ${limits.maxPathLength}）：${normalized}`,
        path: normalized
      }
    }
    if (seen.has(normalized)) {
      return { code: 'duplicate-path', detail: `同一个路径出现两次：${normalized}`, path: normalized }
    }
    seen.add(normalized)
    if (entry.symlink) {
      return {
        code: 'symlink-not-allowed',
        detail: `不接受符号链接（可能指向受管目录之外）：${normalized}`,
        path: normalized
      }
    }
    if (typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes) || entry.bytes < 0) {
      return { code: 'negative-size', detail: `文件大小不合法：${normalized} = ${String(entry.bytes)}`, path: normalized }
    }
    totalBytes += entry.bytes
    if (totalBytes > limits.maxBytes) {
      return {
        code: 'too-large',
        detail: `累计 ${totalBytes} 字节超过上限 ${limits.maxBytes}（可能是解压膨胀）`,
        path: normalized
      }
    }
  }
  return null
}

/* ------------------------------------------------------------ 失败分类 */

/**
 * 把底层错误归到「用户能据此做决定」的几类里（§10.2 / §13）。
 *
 * 刻意**不猜**：认不出来就是 `unknown`，宁可让模型说「原因不明」，
 * 也不要让它说「网络问题」误导用户去重连。
 */
export function classifyAcquisitionFailure(error: unknown): AcquisitionFailureCode {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  const code = (error as { code?: unknown } | null)?.code
  const codeText = typeof code === 'string' ? code : ''
  const both = `${codeText} ${message}`.toLowerCase()
  if (/cancell?ed|aborted|abort/.test(both)) return 'cancelled'
  if (/eacces|eperm|permission|denied|blocked/.test(both)) return 'permission'
  if (/enotfound|econnrefused|econnreset|etimedout|socket|network|fetch failed|dns|tls/.test(both)) return 'network'
  if (/integrity|hash|checksum|sha\d*|digest|mismatch/.test(both)) return 'integrity'
  if (/enoent|unsupported|not supported|no such runtime|python|uv\b|docker/.test(both)) return 'unsupported-runtime'
  if (/verif|smoke|handshake|not reachable|协议|验证|握手|不可达/.test(both)) return 'verification'
  return 'unknown'
}
