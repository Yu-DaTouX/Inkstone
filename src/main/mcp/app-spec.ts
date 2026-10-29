import { getToolUiResourceUri, McpUiToolMetaSchema, McpUiResourceCspSchema, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { McpServerConfig } from '../../shared/mcp'
import { MCP_APP_METHODS } from '../../shared/mcp-app-methods'

export { MCP_APP_METHODS }

export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui'

export const MCP_APP_MIME_TYPE = RESOURCE_MIME_TYPE

export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024

export const MCP_APP_META_UI = 'ui'

export type McpAppVisibility = 'model' | 'app'

const MCP_APP_DEFAULT_VISIBILITY: readonly McpAppVisibility[] = ['model', 'app']

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
  try {
    return getToolUiResourceUri({ _meta: meta as Record<string, unknown> }) ?? null
  } catch {
    return null
  }
}

export function mcpAppVisibilityOf(meta: unknown): McpAppVisibility[] {
  const ui = uiMetaOf(meta)
  if (!ui && meta && typeof meta === 'object' && 'ui' in meta) return ['model']
  if (!ui || ui.visibility === undefined) return [...MCP_APP_DEFAULT_VISIBILITY]
  const parsed = McpUiToolMetaSchema.safeParse({ visibility: ui.visibility })
  return parsed.success ? [...new Set(parsed.data.visibility ?? MCP_APP_DEFAULT_VISIBILITY)] : ['model']
}

export function mcpAppCspOf(meta: unknown): McpAppCsp | null {
  const parsed = McpUiResourceCspSchema.safeParse(uiMetaOf(meta)?.csp)
  return parsed.success ? parsed.data : null
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
