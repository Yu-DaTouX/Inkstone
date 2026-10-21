export type McpAppSwitchDirection = 'to-inkstone' | 'to-pi'

export interface McpAppSwitchEntrySummary {
  transport: 'stdio' | 'http' | 'other'
  command: string | null
  argCount: number
  envKeys: string[]
  urlOrigin: string | null
  description: string | null
}

export interface McpAppSwitchHolder {
  runnerId: string
  generation: number
  busy: boolean
}

export interface McpAppSwitchPreview {
  token: string
  expiresAt: string
  direction: McpAppSwitchDirection
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  projectId?: string
  targetPath: string
  hostConfigFile: string
  entry: McpAppSwitchEntrySummary
  warnings: string[]
  blocked: boolean
  blockedReason?: string
  holders: McpAppSwitchHolder[]
}

export interface McpAppSwitchCommitResult {
  ok: boolean
  direction: McpAppSwitchDirection
  serverId: string
  nativeName: string
  targetPath: string
  hostConfigFile: string
  steps: {
    native: 'removed' | 'written' | 'failed' | 'skipped'
    host: 'enrolled' | 'released' | 'failed' | 'skipped'
    verify: 'passed' | 'failed' | 'unavailable' | 'skipped'
    hostDisconnect: 'disconnected' | 'failed' | 'skipped' | 'not-needed'
  }
  remediation: 'not-needed' | 'restored' | 'remediation-failed' | 'unknown'
  notice: string
  warnings: string[]
}

export interface McpAppSwitchPrepareResponse {
  ok: boolean
  preview?: McpAppSwitchPreview
  code?: string
  error?: string
}

export interface McpAppSwitchCommitResponse {
  ok: boolean
  result?: McpAppSwitchCommitResult
  code?: string
  error?: string
}

export interface McpAppOwnershipView {
  serverId: string
  title: string
  ownedBy: 'pi' | 'inkstone'
  managed: boolean
  inkstoneConnection?: boolean
  inkstoneOnly?: boolean
  nativeName: string
  scope: 'global' | 'project'
  projectScoped: boolean
  hasNativeRecord: boolean
  enabled: boolean
  holders: McpAppSwitchHolder[]
  canSwitch: boolean
  blockedReason?: string
  unsupportedReason?: string
}

export interface McpAppOwnershipResponse {
  servers: McpAppOwnershipView[]
  error?: string
}

export interface McpAppSwitchVerifyInput {
  serverId: string
  nativeName: string
  scope: 'global' | 'project'
  targetPath: string
  expectedFingerprint: string
  expect: 'present' | 'absent'
  projectId?: string
  projectCwd?: string
}

export interface McpAppSwitchVerifyResult {
  ok: boolean
  detail?: string
  connected?: boolean
  toolCount?: number
}

export interface McpAppBridge {
  ownership(): Promise<McpAppOwnershipResponse>
  prepareSwitch(serverId: string): Promise<McpAppSwitchPrepareResponse>
  commitSwitch(token: string): Promise<McpAppSwitchCommitResponse>
}

function mcpAppHttpOriginOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.origin
}

export function summarizeMcpAppNativeEntry(entry: unknown): McpAppSwitchEntrySummary {
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
  if (!record) {
    return { transport: 'other', command: null, argCount: 0, envKeys: [], urlOrigin: null, description: null }
  }
  const args = Array.isArray(record.args) ? record.args : []
  const env =
    record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? (record.env as Record<string, unknown>)
      : null
  const command = typeof record.command === 'string' && record.command.trim() !== '' ? record.command : null
  const transport: McpAppSwitchEntrySummary['transport'] =
    typeof record.url === 'string' && record.url.trim() !== '' ? 'http' : command ? 'stdio' : 'other'
  return {
    transport,
    command,
    argCount: args.length,
    envKeys: env ? Object.keys(env).sort() : [],
    urlOrigin: mcpAppHttpOriginOf(record.url),
    description:
      typeof record.description === 'string' && record.description.trim() !== '' ? record.description : null
  }
}
