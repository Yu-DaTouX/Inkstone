import { createHash } from 'node:crypto'
import type { CapabilityCandidate } from './discovery'
import type { McpServerConfig } from './mcp'

export const MCP_SERVER_ID_MAX = 48

const REGISTRY_URL_PATTERNS = [
  /registry\.modelcontextprotocol\.io/i,
  /registry\.npmjs\.org/i,
  /npmjs\.com\/package\//i
]

export function looksLikeRegistryUrl(url: string): boolean {
  return REGISTRY_URL_PATTERNS.some((pattern) => pattern.test(String(url ?? '')))
}

export function remoteEndpointOf(candidate: CapabilityCandidate): string | null {
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
  return url.host.toLowerCase()
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost')
}

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
        effect: 'unknown',
        enabled: true
      }
    }
  }
}

export type AcquireAuthorization = {
  host: string
  at: string
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

export type ManagedMcpRecord = {
  serverId: string
  operationId: string
  endpoint: string
  host: string
  transport?: 'stdio' | 'http'
  projectId: string
  registeredAt: string
  tools: string[]
}
