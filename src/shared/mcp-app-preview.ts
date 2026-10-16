/**
 * MCP App 预览的共享安全层（纯函数）。
 *
 * 只放能被离线单测反复验证、且主进程与渲染端都能复用的部分：
 *   · `inkstone-app:` 地址的构造与解析（每服务器固定哈希 host + 随机实例路径）；
 *   · `_meta.ui.csp` 声明域名的严格校验与 CSP 组装；
 *   · 响应安全头；
 *   · 实例归属（owner）的纯比较。
 *
 * ⚠️ 本文件被 `tsconfig.node.json` 与 `tsconfig.web.json` 同时包含，因此**不能**
 * import `src/main/**`（跨工程会触发 TS6307）。规范字段名以
 * `src/main/mcp/app-spec.ts` 为唯一来源；主进程按 app-spec 的字段取值后，把
 * 已拆好的域名数组交给 `resolveDomainList`，共享层不重写规范字段。
 *
 * 首版策略：没有任何“能判定公网”的能力时，**拒绝所有网络声明**
 * （见 `resolveDomainList` 的 `no-validator` 分支）。不因为服务在
 * `_meta.ui.csp` 里写了域名就自行放开。
 */

/** 独立于 `inkstone-html:` 的特权来源：每个 MCP 服务一个固定哈希 origin。 */
export const MCP_APP_SCHEME = 'inkstone-app'

/** 首版 sandbox 只给脚本；绝不含 `allow-same-origin`，来源始终是 opaque origin。 */
export const MCP_APP_SANDBOX = 'allow-scripts'

/** 响应里一律关掉的宿主能力（与 `html-artifact-preview.ts` 同口径）。 */
export const MCP_APP_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), fullscreen=(), display-capture=(), usb=(), serial=(), payment=()'

/* ------------------------------------------------------------------ */
/* 地址：inkstone-app://<serverHash>/<instanceId>/index.html            */
/* ------------------------------------------------------------------ */

const SERVER_HASH_RE = /^[a-f0-9]{32}$/
const MCP_APP_PATH_RE = /^\/([a-f0-9]{32})\/index\.html$/

export interface McpAppUrl {
  /** 每个服务固定的 32 位十六进制哈希（来自 serverId，而不是资源 URI）。 */
  serverHash: string
  /** 每次创建实例随机生成的 32 位十六进制实例号。 */
  instanceId: string
}

export function buildMcpAppUrl(serverHash: string, instanceId: string): string {
  return `${MCP_APP_SCHEME}://${serverHash}/${instanceId}/index.html`
}

/**
 * 解析受控地址；只认「固定哈希 host + 随机实例目录 + 唯一文档名」。
 *
 * 查询串、用户名/口令、显式端口、额外路径段、非 `index.html` 一律拒绝 ——
 * 主页面不能借协议读到任意资源。fragment 不参与服务端解析，保留不影响身份。
 */
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

/* ------------------------------------------------------------------ */
/* CSP 域名校验                                                        */
/* ------------------------------------------------------------------ */

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
  /** 原始声明值（用于如实报告被拒原因）。 */
  value: string
  /** 规范化后的主机名；字面非法时为 null。 */
  host: string | null
  allowed: boolean
  reason?: McpAppDomainRejection
}

/** 注入式“该主机是否解析到内网/回环”判定；返回 true 表示不安全。 */
export type McpAppResolveHost = (host: string) => Promise<boolean> | boolean

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/
const DNS_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.invalid', '.example']

/**
 * 只做**字面**判定：协议必须 https、无用户名口令、无端口、非通配、非 IP 字面量、
 * 非回环/私网/链路本地命名、是合法 DNS 名、只允许 origin。字面判定挡不住
 * DNS 重绑定，公网判定必须交给调用方注入的解析器（或直接拒绝）。
 */
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
  /* IPv6（含 [::1]、[::ffff:127.0.0.1] 等任意编码）与 IPv4 字面量整体拒绝。 */
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

/**
 * 逐条校验声明域名。
 *
 * `mode: 'forbidden'`（frame/base-uri）无论写什么都不放行；`network` 模式在
 * 没有注入 `resolvePrivate` 时直接 `no-validator` —— 首版就是「拒绝所有网络声明」。
 */
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

/* ------------------------------------------------------------------ */
/* CSP 组装                                                            */
/* ------------------------------------------------------------------ */

export interface McpAppCspGrant {
  /** 已校验允许的外部资源来源（script/style/img/font/media）。 */
  resource?: readonly string[]
  /** 已校验允许的网络请求来源（connect-src）。 */
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

/**
 * 严格 CSP：默认档与现有离线成果一致，不因 App 声明而放宽结构指令。
 *
 *   · 外部脚本**永不**加入 `script-src`（脚本外联遵守现有严格离线默认）；
 *   · `frame` / `object` / `base` / `form` 无论声明什么都关闭；
 *   · 只有显式通过校验的域名才会进 `img/style/font/media-src` 与 `connect-src`；
 *   · 末尾始终带 `sandbox allow-scripts`（opaque origin，绝无 `allow-same-origin`）。
 */
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

/** 出错页（纯文本回退）也带最严 CSP 与同样的安全头。 */
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

/* ------------------------------------------------------------------ */
/* 实例归属                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一个 App 实例的归属绑定。切会话、runner 重启或 toolCall 失效时，这些字段
 * 会让旧实例立即失配；`generation` 用来区分同 id 的两次运行。
 */
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
