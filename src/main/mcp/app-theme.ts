import { McpUiHostStylesSchema } from '@modelcontextprotocol/ext-apps/app-bridge'
import {
  APP_THEME_SHADOW_VARIABLES,
  APP_THEME_VARIABLES
} from '../../shared/mcp-app-theme.generated'

export type McpAppTheme = 'light' | 'dark'

export const MCP_APP_DEFAULT_THEME: McpAppTheme = 'dark'

export function resolveMcpAppThemePreference(
  preference: unknown,
  systemPrefersDark: boolean
): McpAppTheme {
  if (preference === 'light' || preference === 'dark') return preference
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return MCP_APP_DEFAULT_THEME
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

export function resolveMcpAppThemeValue(value: string, theme: McpAppTheme): string {
  const marker = 'light-dark('
  let out = value
  let index = out.indexOf(marker)
  while (index !== -1) {
    let depth = 1
    let end = -1
    for (let i = index + marker.length; i < out.length; i += 1) {
      const ch = out[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return out
    const parts = splitTopLevel(out.slice(index + marker.length, end))
    if (parts.length !== 2) return out
    const picked = theme === 'light' ? parts[0] : parts[1]
    out = out.slice(0, index) + picked + out.slice(end + 1)
    index = out.indexOf(marker)
  }
  return out
}

export function resolveMcpAppThemeVariables(theme: McpAppTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(APP_THEME_VARIABLES)) {
    out[name] = resolveMcpAppThemeValue(value, theme)
  }
  for (const [name, value] of Object.entries(APP_THEME_SHADOW_VARIABLES[theme])) {
    out[name] = value
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const VARIABLE_NAME = /^--[A-Za-z0-9_-]+$/
const VARIABLE_VALUE_MAX = 512

function sanitizeVariables(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) return {}
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(record)) {
    if (!VARIABLE_NAME.test(name)) continue
    if (typeof raw !== 'string' || raw.length > VARIABLE_VALUE_MAX) continue
    if (raw.includes(';') || raw.includes('\n') || raw.includes('\r')) continue
    if (!McpUiHostStylesSchema.safeParse({ variables: { [name]: raw } }).success) continue
    out[name] = raw
  }
  return out
}

const HOST_CONTEXT_DEFAULTS: Readonly<Record<string, unknown>> = {
  platform: 'desktop',
  displayMode: 'inline',
  availableDisplayModes: ['inline', 'fullscreen', 'pip']
}

export interface McpAppHostContextInput {
  theme: McpAppTheme
  provider?: Record<string, unknown> | null
}

export function buildMcpAppHostContext(input: McpAppHostContextInput): Record<string, unknown> {
  const provider = input.provider ?? {}
  const context: Record<string, unknown> = { ...provider }
  for (const [key, value] of Object.entries(HOST_CONTEXT_DEFAULTS)) {
    if (!(key in context)) context[key] = Array.isArray(value) ? [...value] : value
  }
  const providerStyles = asRecord(provider.styles)
  const variables = {
    ...sanitizeVariables(providerStyles?.variables),
    ...resolveMcpAppThemeVariables(input.theme)
  }
  context.theme = input.theme
  context.styles = { variables }
  return context
}
