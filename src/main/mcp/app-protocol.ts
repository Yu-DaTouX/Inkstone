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

export function registerMcpAppScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([{ scheme: MCP_APP_SCHEME, privileges: { standard: true, secure: true } }])
}

registerMcpAppScheme()

export interface McpAppResourceReader {
  readResource(
    serverId: string,
    uri: string,
    options?: { signal?: AbortSignal; projectId?: string }
  ): Promise<McpAppResource>
}

export interface McpAppLoaderOptions {
  resolvePrivateHost?: McpAppResolveHost
}

export const mcpAppNetworkBoundaryResolver: McpAppResolveHost = (host) => resolvesToPrivateAddress(host)

export interface McpAppCspDerivation {
  csp: string
  resource: McpAppDomainDecision[]
  connect: McpAppDomainDecision[]
  frame: McpAppDomainDecision[]
  baseUri: McpAppDomainDecision[]
  networkRejected: boolean
}

export async function deriveMcpAppCsp(
  uiCsp: McpAppCsp | null | undefined,
  options: McpAppLoaderOptions = {}
): Promise<McpAppCspDerivation> {
  const resource = await resolveDomainList(uiCsp?.resourceDomains, 'network', options.resolvePrivateHost)
  const connect = await resolveDomainList(uiCsp?.connectDomains, 'network', options.resolvePrivateHost)
  const frame = await resolveDomainList(uiCsp?.frameDomains, 'forbidden', undefined)
  const baseUri = await resolveDomainList(uiCsp?.baseUriDomains, 'forbidden', undefined)
  const csp = buildMcpAppCsp({
    resource: resource.filter((item) => item.allowed).map((item) => item.value),
    connect: connect.filter((item) => item.allowed).map((item) => item.value)
  })
  const networkRejected = [...resource, ...connect].some((item) => !item.allowed)
  return { csp, resource, connect, frame, baseUri, networkRejected }
}

export function createMcpAppResourceLoader(host: McpAppResourceReader, options: McpAppLoaderOptions = {}): McpAppResourceFetch {
  return async ({ serverId, resourceUri, signal, projectId }): Promise<McpAppLoadedResource> => {
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

export function registerMcpAppProtocol(store: McpAppResourceStore): void {
  protocol.handle(MCP_APP_SCHEME, (request) => {
    const result = store.read(request.url, { method: request.method })
    if (!result.ok) {
      return new Response(errorMessage(result.error), { status: statusFor(result.error), headers: mcpAppErrorHeaders() })
    }
    return new Response(result.html, { status: 200, headers: mcpAppResponseHeaders(result.csp) })
  })
}
