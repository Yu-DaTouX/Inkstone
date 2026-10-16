export const MCP_APP_SCHEME = 'inkstone-app'

export const MCP_APP_SANDBOX = 'allow-scripts'

export const MCP_APP_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), display-capture=(), usb=(), serial=(), payment=()'

const SERVER_HASH_RE = /^[a-f0-9]{32}$/
const MCP_APP_PATH_RE = /^\/([a-f0-9]{32})\/index\.html$/

export interface McpAppUrl {
  serverHash: string
  instanceId: string
}

export function buildMcpAppUrl(serverHash: string, instanceId: string): string {
  return `${MCP_APP_SCHEME}://${serverHash}/${instanceId}/index.html`
}

export function parseMcpAppUrl(url: string): McpAppUrl | null {
  if (typeof url !== 'string' || !url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MCP_APP_SCHEME}:`) return null
  if (parsed.username || parsed.password || parsed.port || parsed.search) return null
  if (!SERVER_HASH_RE.test(parsed.hostname)) return null
  const match = MCP_APP_PATH_RE.exec(parsed.pathname)
  if (!match) return null
  return { serverHash: parsed.hostname, instanceId: match[1] }
}

export type McpAppDomainRejection =
  | 'empty'
  | 'wildcard'
  | 'not-https'
  | 'credentials'
  | 'port'
  | 'ip-literal'
  | 'private-host'
  | 'invalid-host'
  | 'path'
  | 'forbidden'
  | 'no-validator'
  | 'resolves-private'
  | 'unresolved'

export interface McpAppDomainDecision {
  value: string
  host: string | null
  allowed: boolean
  reason?: McpAppDomainRejection
}

export type McpAppResolveHost = (host: string) => Promise<boolean> | boolean

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.invalid', '.example']

export function classifyMcpAppDomain(raw: string): McpAppDomainDecision {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { value, host: null, allowed: false, reason: 'empty' }
  if (value.includes('*')) return { value, host: null, allowed: false, reason: 'wildcard' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { value, host: null, allowed: false, reason: 'invalid-host' }
  }
  if (parsed.protocol !== 'https:') return { value, host: null, allowed: false, reason: 'not-https' }
  if (parsed.username || parsed.password) return { value, host: null, allowed: false, reason: 'credentials' }
  if (parsed.port) return { value, host: null, allowed: false, reason: 'port' }
  const host = parsed.hostname.toLowerCase()
  if (!host) return { value, host, allowed: false, reason: 'invalid-host' }
  if (host.includes('[') || host.includes(']') || host.includes(':')) return { value, host, allowed: false, reason: 'ip-literal' }
  if (IPV4_RE.test(host)) {
    const octets = host.split('.').map((part) => Number(part))
    if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return { value, host, allowed: false, reason: 'invalid-host' }
    }
    return { value, host, allowed: false, reason: 'ip-literal' }
  }
  if (host.endsWith('.')) return { value, host, allowed: false, reason: 'invalid-host' }
  if (host === 'localhost' || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { value, host, allowed: false, reason: 'private-host' }
  }
  if (!DNS_HOST_RE.test(host)) return { value, host, allowed: false, reason: 'invalid-host' }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { value, host, allowed: false, reason: 'path' }
  }
  return { value: `https://${host}`, host, allowed: true }
}

export type McpAppDomainMode = 'network' | 'forbidden'

export async function resolveDomainList(
  values: readonly string[] | null | undefined,
  mode: McpAppDomainMode,
  resolvePrivate?: McpAppResolveHost
): Promise<McpAppDomainDecision[]> {
  if (!Array.isArray(values) || values.length === 0) return []
  const out: McpAppDomainDecision[] = []
  for (const raw of values) {
    const literal = classifyMcpAppDomain(raw)
    if (mode === 'forbidden') {
      out.push({ ...literal, allowed: false, reason: 'forbidden' })
      continue
    }
    if (!literal.allowed || !literal.host) {
      out.push(literal)
      continue
    }
    if (!resolvePrivate) {
      out.push({ ...literal, allowed: false, reason: 'no-validator' })
      continue
    }
    try {
      const isPrivate = await resolvePrivate(literal.host)
      out.push(isPrivate ? { ...literal, allowed: false, reason: 'resolves-private' } : literal)
    } catch {
      out.push({ ...literal, allowed: false, reason: 'unresolved' })
    }
  }
  return out
}

export interface McpAppCspGrant {
  resource?: readonly string[]
  connect?: readonly string[]
}

function uniqueOrigins(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const value of values) {
    const decision = classifyMcpAppDomain(value)
    if (decision.allowed && decision.host) {
      const origin = `https://${decision.host}`
      if (!out.includes(origin)) out.push(origin)
    }
  }
  return out
}

export function buildMcpAppCsp(grant: McpAppCspGrant = {}): string {
  const resource = uniqueOrigins(grant.resource)
  const connect = uniqueOrigins(grant.connect)
  const script = ["'unsafe-inline'"]
  const style = ["'unsafe-inline'", ...resource]
  const img = ['data:', 'blob:', ...resource]
  const font = ['data:', ...resource]
  const media = ['data:', 'blob:', ...resource]
  const connectSrc = connect.length ? connect : ["'none'"]
  return [
    "default-src 'none'",
    `script-src ${script.join(' ')}`,
    `style-src ${style.join(' ')}`,
    `img-src ${img.join(' ')}`,
    `font-src ${font.join(' ')}`,
    `media-src ${media.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `sandbox ${MCP_APP_SANDBOX}`
  ].join('; ')
}

export const MCP_APP_ERROR_CSP = "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts"

export function mcpAppResponseHeaders(csp: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': csp,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': MCP_APP_PERMISSIONS_POLICY
  }
}

export function mcpAppErrorHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Security-Policy': MCP_APP_ERROR_CSP,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': MCP_APP_PERMISSIONS_POLICY
  }
}

export interface McpAppOwner {
  serverId: string
  sessionId: string
  sessionFile: string
  projectId: string
  runnerId: string
  generation: number
  toolCallId: string
}

const OWNER_STRING_FIELDS = ['serverId', 'sessionId', 'sessionFile', 'projectId', 'runnerId', 'toolCallId'] as const

export function isCompleteMcpAppOwner(value: unknown): value is McpAppOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  if (!OWNER_STRING_FIELDS.every((key) => typeof owner[key] === 'string' && (owner[key] as string).trim().length > 0)) return false
  return typeof owner.generation === 'number' && Number.isFinite(owner.generation) && owner.generation >= 0
}

export function sameMcpAppOwner(a: McpAppOwner, b: McpAppOwner): boolean {
  return (
    a.serverId === b.serverId &&
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.projectId === b.projectId &&
    a.runnerId === b.runnerId &&
    a.generation === b.generation &&
    a.toolCallId === b.toolCallId
  )
}
