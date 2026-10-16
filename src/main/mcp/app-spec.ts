import type { McpServerConfig } from '../../shared/mcp'
import { MCP_APP_METHODS } from '../../shared/mcp-app-methods'

export { MCP_APP_METHODS }

export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui'

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024

export const MCP_APP_META_UI = 'ui'
export const MCP_APP_META_RESOURCE_URI = 'resourceUri'
export const MCP_APP_META_CSP = 'csp'
export const MCP_APP_META_VISIBILITY = 'visibility'
export const MCP_APP_META_PREFERS_BORDER = 'prefersBorder'

export type McpAppVisibility = 'model' | 'app'
export const MCP_APP_VISIBILITIES: readonly McpAppVisibility[] = ['model', 'app']

export const MCP_APP_DEFAULT_VISIBILITY: readonly McpAppVisibility[] = ['model']

export interface McpAppCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  frameDomains?: string[]
  baseUriDomains?: string[]
}

export function mcpAppClientCapabilities(): { extensions: Record<string, { mimeTypes: string[] }> } {
  return { extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } }
}

function uiMetaOf(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const ui = (meta as Record<string, unknown>)[MCP_APP_META_UI]
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null
  return ui as Record<string, unknown>
}

export function mcpAppResourceUriOf(meta: unknown): string | null {
  const uri = uiMetaOf(meta)?.[MCP_APP_META_RESOURCE_URI]
  return typeof uri === 'string' && uri.trim() ? uri : null
}

export function mcpAppVisibilityOf(meta: unknown): McpAppVisibility[] {
  const raw = uiMetaOf(meta)?.[MCP_APP_META_VISIBILITY]
  if (!Array.isArray(raw)) return [...MCP_APP_DEFAULT_VISIBILITY]
  const values = raw.filter((value): value is McpAppVisibility => value === 'model' || value === 'app')
  return values.length ? [...new Set(values)] : [...MCP_APP_DEFAULT_VISIBILITY]
}

export function mcpAppIsAppVisible(meta: unknown): boolean {
  return mcpAppVisibilityOf(meta).includes('app')
}

export function mcpAppIsModelVisible(meta: unknown): boolean {
  return mcpAppVisibilityOf(meta).includes('model')
}

export function mcpAppCspOf(meta: unknown): McpAppCsp | null {
  const raw = uiMetaOf(meta)?.[MCP_APP_META_CSP]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const list = (key: string): string[] | undefined => {
    const value = source[key]
    if (!Array.isArray(value)) return undefined
    const domains = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return domains.length ? domains : undefined
  }
  const csp: McpAppCsp = {}
  const connect = list('connectDomains')
  if (connect) csp.connectDomains = connect
  const resource = list('resourceDomains')
  if (resource) csp.resourceDomains = resource
  const frame = list('frameDomains')
  if (frame) csp.frameDomains = frame
  const baseUri = list('baseUriDomains')
  if (baseUri) csp.baseUriDomains = baseUri
  return Object.keys(csp).length ? csp : null
}

export function isMcpAppMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== 'string') return false
  const parts = mimeType.split(';')
  const base = parts.shift()?.trim().toLowerCase()
  if (base !== 'text/html') return false
  return parts.some((part) => part.trim().toLowerCase() === 'profile=mcp-app')
}

export type McpAppOwnership = 'pi' | 'inkstone'

export interface McpAppNativeEntry {
  path: string
  name: string
  entry: unknown
  fingerprint: string
}

export interface McpAppHostConfig {
  at: string
  natives: McpAppNativeEntry[]
}

export interface McpAppServerConfig extends McpServerConfig {
  ownedBy?: McpAppOwnership
  appHost?: McpAppHostConfig
}

export function isInkstoneManaged(config: {
  ownedBy?: McpAppOwnership
  appHost?: McpAppHostConfig
  enabled?: boolean
}): boolean {
  return config.ownedBy === 'inkstone' && config.appHost !== undefined && config.enabled !== false
}
