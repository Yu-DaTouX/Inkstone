/**
 * `inkstone-app:` 特权协议 + CSP 安全层。
 *
 * ── 协议 ──
 *   `inkstone-app://<serverHash>/<instanceId>/index.html`。host 是每个 MCP 服务
 *   固定的哈希（独立 origin），路径段是随机的实例号 —— 与现有 `inkstone-html:`
 *   一样，协议 URL 不解析任何本机磁盘路径，正文只来自 `McpAppResourceStore`
 *   里由宿主 `readResource` 建好的快照。
 *
 * ── 时序 ──
 *   scheme 必须在 `app.whenReady()` 前注册（本模块 import 时执行，与
 *   `html-artifact-preview.ts` 同款；Electron 44 允许在 ready 前多次调用）。
 *   协议处理器在 ready 之后再 `registerMcpAppProtocol(store)`。
 *
 * ── 安全头 ──
 *   每个响应都带:no-store / no-referrer / nosniff / Permissions-Policy 全关，
 *   CSP 由 `shared/mcp-app-preview` 组装并存放进实例。未知路径/方法、伪造
 *   serverHash、owner 失效一律拒绝，不返回正文。
 *
 * ── 首版网络策略 ──
 *   不注入公网判定器时，`_meta.ui.csp` 里的一切网络声明都被拒绝（CSP 保持
 *   `connect-src 'none'`）。这与「没有安全域名验证能力就拒所有网络声明」一致；
 *   将来要用声明域名，必须在构造 loader 时显式传入 `resolvePrivateHost`
 *   （例如现有网络边界 `resolvesToPrivateAddress`），并单独做安全评审。
 */
import { protocol } from 'electron'
import type { McpAppResource } from './app-host'
import type { McpAppResourceStore, McpAppLoadedResource, McpAppResourceFetch } from './app-resource-store'
import type { McpAppCsp } from './app-spec'
import { resolvesToPrivateAddress } from '../browser/network-policy'
import {
  buildMcpAppCsp,
  mcpAppErrorHeaders,
  mcpAppResponseHeaders,
  MCP_APP_SCHEME,
  resolveDomainList,
  type McpAppDomainDecision,
  type McpAppResolveHost
} from '../../shared/mcp-app-preview'

let schemeRegistered = false

/**
 * 注册独占 scheme（standard + secure）。必须在 app ready 前调用。
 * 幂等：顶层已自动调用一次，接线方再调不会重复注册。
 */
export function registerMcpAppScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([{ scheme: MCP_APP_SCHEME, privileges: { standard: true, secure: true } }])
}

/* 与 `html-artifact-preview.ts` 一样，import 即注册，保证早于 app.whenReady()。 */
registerMcpAppScheme()

/** 只依赖 `readResource`，避免把整个宿主类拖进协议层。 */
export interface McpAppResourceReader {
  readResource(
    serverId: string,
    uri: string,
    options?: { signal?: AbortSignal; projectId?: string }
  ): Promise<McpAppResource>
}

export interface McpAppLoaderOptions {
  /**
   * 注入后才会把声明的 https 域名映射进 CSP。**首版接线不要传** ——
   * 缺省就是不注入、拒绝所有网络声明。
   */
  resolvePrivateHost?: McpAppResolveHost
}

/**
 * 现有网络边界的公网判定器（返回 true = 私有/不安全）。
 *
 * ⚠️ 它把「解析失败」当作非私有（见 `network-policy.ts` 注释），因此不应在
 * 本层直接当作唯一防线；只是给将来显式启用时复用，启用前需复核 DNS 竞态。
 */
export const mcpAppNetworkBoundaryResolver: McpAppResolveHost = (host) => resolvesToPrivateAddress(host)

export interface McpAppCspDerivation {
  csp: string
  resource: McpAppDomainDecision[]
  connect: McpAppDomainDecision[]
  frame: McpAppDomainDecision[]
  baseUri: McpAppDomainDecision[]
  /** 是否存在被拒绝的网络声明（首版没有注入判定器时恒为 true）。 */
  networkRejected: boolean
}

/** 按 app-spec 的 `_meta.ui.csp` 字段取值，交给共享层校验并组装 CSP。 */
export async function deriveMcpAppCsp(
  uiCsp: McpAppCsp | null | undefined,
  options: McpAppLoaderOptions = {}
): Promise<McpAppCspDerivation> {
  const resource = await resolveDomainList(uiCsp?.resourceDomains, 'network', options.resolvePrivateHost)
  const connect = await resolveDomainList(uiCsp?.connectDomains, 'network', options.resolvePrivateHost)
  /* frame/base-uri 无论声明什么都不进 CSP，只如实记下被拒条目。 */
  const frame = await resolveDomainList(uiCsp?.frameDomains, 'forbidden', undefined)
  const baseUri = await resolveDomainList(uiCsp?.baseUriDomains, 'forbidden', undefined)
  const csp = buildMcpAppCsp({
    resource: resource.filter((item) => item.allowed).map((item) => item.value),
    connect: connect.filter((item) => item.allowed).map((item) => item.value)
  })
  const networkRejected = [...resource, ...connect].some((item) => !item.allowed)
  return { csp, resource, connect, frame, baseUri, networkRejected }
}

/** 生产默认 loader：宿主 `readResource` + 严格 CSP 推导（首版不注入网络判定器）。 */
export function createMcpAppResourceLoader(host: McpAppResourceReader, options: McpAppLoaderOptions = {}): McpAppResourceFetch {
  return async ({ serverId, resourceUri, signal, projectId }): Promise<McpAppLoadedResource> => {
    /* projectId 只由 A6 从实例 owner 事实透传；缺省则不传，由宿主按无项目绑定处理。 */
    const resource = await host.readResource(serverId, resourceUri, {
      ...(signal ? { signal } : {}),
      ...(projectId ? { projectId } : {})
    })
    const derivation = await deriveMcpAppCsp(resource.uiCsp, options)
    return { html: resource.text, mimeType: resource.mimeType, bytes: resource.bytes, csp: derivation.csp }
  }
}

function statusFor(error: string): number {
  if (error === 'method') return 405
  if (error === 'owner' || error === 'revoked') return 403
  return 404
}

function errorMessage(error: string): string {
  if (error === 'method') return 'Method Not Allowed'
  if (error === 'revoked') return 'App instance expired'
  if (error === 'owner') return 'App instance owner mismatch'
  return 'App instance not found'
}

/** ready 之后注册处理器；所有响应都带 `mcpAppResponseHeaders`/`mcpAppErrorHeaders`。 */
export function registerMcpAppProtocol(store: McpAppResourceStore): void {
  protocol.handle(MCP_APP_SCHEME, (request) => {
    const result = store.read(request.url, { method: request.method })
    if (!result.ok) {
      return new Response(errorMessage(result.error), { status: statusFor(result.error), headers: mcpAppErrorHeaders() })
    }
    return new Response(result.html, { status: 200, headers: mcpAppResponseHeaders(result.csp) })
  })
}
