export type McpSettingsScope = 'global' | 'project'
export type McpSettingsBackend = 'native' | 'host'

export interface McpSettingsService {
  key: string
  name: string
  title: string
  backend: McpSettingsBackend
  owner: 'pi' | 'inkstone'
  scope: McpSettingsScope
  enabled: boolean
  inherited: boolean
  overridden: boolean
  transport: 'stdio' | 'http'
  source: string
  connection: string
  special?: boolean
  conflict?: boolean
}

export interface McpSettingsSnapshot {
  context: string
  revision: string
  project: { id: string; name: string; cwd: string } | null
  projectTrusted: boolean
  global: McpSettingsService[]
  projectServices: McpSettingsService[]
  errors: string[]
  busy: boolean
  nativeConfigChanged: boolean | null
}

export type McpSettingsMutation = {
  context: string
  revision: string
  scope: McpSettingsScope
} & (
  | { action: 'add'; name: string; config: { command?: string; args?: string[]; url?: string; env?: Record<string, string> } }
  | { action: 'enable' | 'disable' | 'inherit' | 'remove' | 'move'; key: string }
)

export interface McpSettingsResult {
  ok: boolean
  error?: string
  takesEffect?: 'new-session' | 'next-call'
}
