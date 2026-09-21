/**
 * 远程 MCP 登记的契约（实施-04 §9 / §10）—— 纯逻辑：不碰文件系统、不联网、不读凭证。
 *
 * ── 为什么「远程」要单独一层 ──
 *   §10 写得很直白：**远程 MCP 无需本地安装时直接走「验证端点 → 登记配置 → 连接 → 枚举工具」**，
 *   **不能为了统一界面伪造下载步骤**。也就是说，远程分支和「下载 → 安装」共用同一个事务
 *   状态机，但 `acquiring` 那一步的动作是**写一条宿主配置**而不是解压一个包。
 *   把它写成纯函数，单测才能直接构造候选去验边界（URL 是不是安全、ID 会不会撞、
 *   授权是不是覆盖了这个 host），而不必先跑一次真实连接。
 *
 * ── 三条不能碰的红线 ──
 *   1. **不接受非加密端点**：只有 loopback 上的 `http://` 才放行；其余必须是 `https://`。
 *      远程 MCP 会看到请求内容，明文等于把它交给路径上任何人。
 *   2. **`effect` 不由服务自报**：目录 / 服务说自己是只读的一律不采信，登记时写 `unknown`（最保守）。
 *   3. **`metadata-only` 不等于已授权**：候选来自公开目录时，先落到授权环节，
 *      只有用户/策略明确覆盖了这个来源才继续（§9）。
 */
import { createHash } from 'node:crypto'
import type { CapabilityCandidate } from './discovery'
import type { McpServerConfig } from './mcp'

/** 服务 ID 长度上限：太长会让 `mcp:<server>/<tool>` 这种 ID 难以阅读与比对。 */
export const MCP_SERVER_ID_MAX = 48

/** 已知目录自身的地址 —— 它们不是「端点」，不能当远程服务登记。 */
const REGISTRY_URL_PATTERNS = [
  /registry\.modelcontextprotocol\.io/i,
  /registry\.npmjs\.org/i,
  /npmjs\.com\/package\//i
]

export function looksLikeRegistryUrl(url: string): boolean {
  return REGISTRY_URL_PATTERNS.some((pattern) => pattern.test(String(url ?? '')))
}

/**
 * 从候选里挑出**要连接的远程端点**。
 *
 * 发现链（S5）把 `sourceUrls` 写成 `[检索地址, ...(远程端点)]`（见 `discover.ts` 的
 * `mcpCandidateOf`）。这里只看「第一个不是目录检索地址的 http(s) URL」——
 * 不猜、不拼，拿不到就是拿不到（调用方如实报 `missing-url`）。
 */
export function remoteEndpointOf(candidate: CapabilityCandidate): string | null {
  /* 目录适配器直接给了端点就用它 —— 不去猜 URL 列表里哪个是端点。 */
  const explicit = String(candidate.remoteUrl ?? '').trim()
  if (explicit && /^https?:\/\//i.test(explicit) && !looksLikeRegistryUrl(explicit)) return explicit
  for (const raw of candidate.sourceUrls ?? []) {
    const url = String(raw ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (looksLikeRegistryUrl(url)) continue
    return url
  }
  return null
}

function safeHostOf(url: URL): string {
  /* `URL.host` 带端口；授权按「host:port」比对才能挡住「同域不同端口」的替换。 */
  return url.host.toLowerCase()
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost')
}

/**
 * 服务 ID：可读 + 稳定 + 不撞车。
 *
 * 为什么末尾缀一段短哈希：两个不同发布者的服务可以同名（`weather`），
 * 用名字当 ID 会让后登记的**顶掉**先登记的配置 —— 那等于静默换掉了用户正在用的服务。
 * 哈希取候选 ID + 端点，同一个候选重装仍得到同一个 ID（幂等），不同来源则分开。
 */
export function mcpServerIdOf(candidateId: string, endpoint: string): string {
  const base = String(candidateId ?? '')
    .replace(/^[a-z-]+:/i, '')
    .replace(/@.*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const trimmed = base.slice(0, MCP_SERVER_ID_MAX).replace(/[-._]+$/g, '')
  const suffix = createHash('sha256')
    .update(`${candidateId}\u0000${endpoint}`)
    .digest('hex')
    .slice(0, 6)
  return `${trimmed || 'mcp'}-${suffix}`
}

export type McpRegistrationDraft = {
  serverId: string
  config: McpServerConfig
  /** `host:port` —— 授权按它比对。 */
  host: string
  endpoint: string
  warnings: string[]
}

export type McpRegistrationProblem = {
  ok: false
  code: 'not-remote' | 'missing-url' | 'bad-url' | 'insecure-transport' | 'credentials-in-url'
  detail: string
}

export type McpRegistrationResult = { ok: true; draft: McpRegistrationDraft } | McpRegistrationProblem

/**
 * 候选 → 待登记的服务配置。
 *
 * 只回答「这条配置本身合不合法」；**不回答**「该不该授权」—— 那是策略层的事（§9）。
 * 这样拆开，单测能分别验「URL 安全」与「授权覆盖」，出了错也知道该看哪一层。
 */
export function draftRemoteMcpRegistration(candidate: CapabilityCandidate): McpRegistrationResult {
  if (candidate.kind !== 'mcp-server' || candidate.installKind !== 'remote') {
    return {
      ok: false,
      code: 'not-remote',
      detail: `这个候选不是远程 MCP（kind=${candidate.kind}, installKind=${candidate.installKind}）`
    }
  }
  const endpoint = remoteEndpointOf(candidate)
  if (!endpoint) {
    return { ok: false, code: 'missing-url', detail: '候选里没有可连接的远程端点（只有目录元数据）' }
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, code: 'bad-url', detail: `端点不是合法 URL：${endpoint}` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'bad-url', detail: `端点协议不受支持：${url.protocol}` }
  }
  /* 带 userinfo 的 URL 会把凭证写进配置文件 —— 那正是 §9 禁止的「凭证进 prompt / 文件」。 */
  if (url.username || url.password) {
    return { ok: false, code: 'credentials-in-url', detail: '端点 URL 里带用户名 / 密码，拒绝登记（凭证不进配置文件）' }
  }
  const host = safeHostOf(url)
  if (url.protocol === 'http:' && !isLoopbackHost(host)) {
    return {
      ok: false,
      code: 'insecure-transport',
      detail: `非 loopback 的远程端点必须是 https（收到 ${url.protocol}//${host}）`
    }
  }
  const warnings = [
    '目录元数据只证明发布来源存在（metadata-only），不代表代码已审计 —— 本地不会为此下载任何东西。',
    '远程服务会看到你发给它的请求内容；不需要时用 yan 的能力页移除登记。'
  ]
  if (url.protocol === 'http:') warnings.push('这是 loopback 上的明文端点（仅本机可达），不要指向外部主机。')
  return {
    ok: true,
    draft: {
      serverId: mcpServerIdOf(candidate.candidateId, endpoint),
      host,
      endpoint: url.toString(),
      warnings,
      config: {
        id: mcpServerIdOf(candidate.candidateId, endpoint),
        title: candidate.title,
        transport: 'http',
        url: url.toString(),
        /* 服务 / 目录自报的只读提示不是安全边界（§4），登记时一律最保守。 */
        effect: 'unknown',
        enabled: true
      }
    }
  }
}

/* ---------------------------------------------------------------- 授权 */

/**
 * 一条授权记录：用户明确同意「这个 host 上的远程能力可以自动接入」（§9 的持久策略）。
 *
 * 只记 host，不记候选 ID —— 授权是「来源范围」而不是「这一次点击」，
 * 否则每换一个候选都要重新问一次，用户会被问烦，最后闭眼点同意。
 */
export type AcquireAuthorization = {
  host: string
  at: string
  /** 触发这条授权时用的命令形状，便于能力页展示「谁 / 哪次任务引入」。 */
  via: string
  projectId?: string
}

export function authorizationHostOf(url: string): string | null {
  try {
    return safeHostOf(new URL(url))
  } catch {
    return null
  }
}

export function authorizationCovers(
  authorizations: readonly AcquireAuthorization[],
  url: string,
  projectId?: string
): boolean {
  const host = authorizationHostOf(url)
  if (!host) return false
  return authorizations.some((auth) => {
    if (auth.host !== host) return false
    /* 项目隔离：带了 projectId 的授权只在同一个项目里生效。 */
    if (auth.projectId && projectId && auth.projectId !== projectId) return false
    return true
  })
}

export function addAuthorization(
  authorizations: readonly AcquireAuthorization[],
  record: AcquireAuthorization
): AcquireAuthorization[] {
  const next = authorizations.filter((auth) => !(auth.host === record.host && auth.projectId === record.projectId))
  next.push(record)
  return next
}

/** 受管登记记录：卸载时**只删自己登记的这些**，不碰用户手写的服务（§10.2 / §11）。 */
export type ManagedMcpRecord = {
  serverId: string
  operationId: string
  endpoint: string
  host: string
  transport?: 'stdio' | 'http'
  projectId: string
  registeredAt: string
  /** 登记时真的列到的工具名 —— 恢复复核时用它比对「服务还是不是那个服务」。 */
  tools: string[]
}
