import { createHash } from 'node:crypto'
import type { CapabilityMcpCheckView, CapabilityMcpServerSettingView } from '../../shared/ipc'
import type { McpServerConfig } from '../../shared/mcp'

export interface McpCheckOutcome {
  ok: boolean
  toolCount?: number
  error?: string
}

export interface McpHolderServices {
  legacyMcpServices: ReadonlyArray<{ serverId: string; status: string }> | null
}

export interface McpCheckScope {
  projectId: string | null
  fingerprint: string
}

const MAX_ENTRIES = 64

export function mcpConfigFingerprint(config: McpServerConfig | undefined): string {
  if (!config) return 'missing'
  const env = Object.entries(config.env ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const projectEnabled = Object.entries(config.projectEnabled ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const parts = [config.transport, config.command, config.args, config.url, env, config.enabled !== false, config.projectScope ?? null, projectEnabled]
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

function keyOf(serverId: string, scope: McpCheckScope): string {
  return JSON.stringify([scope.projectId ?? '', serverId])
}

export class McpCheckHistory {
  private readonly entries = new Map<string, CapabilityMcpCheckView & { fingerprint: string }>()

  record(serverId: string, outcome: McpCheckOutcome, scope: McpCheckScope, at = Date.now()): void {
    const key = keyOf(serverId, scope)
    this.entries.delete(key)
    this.entries.set(key, {
      at,
      ok: outcome.ok,
      fingerprint: scope.fingerprint,
      ...(outcome.toolCount !== undefined ? { toolCount: outcome.toolCount } : {}),
      ...(!outcome.ok && outcome.error ? { error: outcome.error.slice(0, 400) } : {})
    })
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string)
  }

  get(serverId: string, scope: McpCheckScope): CapabilityMcpCheckView | undefined {
    const entry = this.entries.get(keyOf(serverId, scope))
    if (!entry || entry.fingerprint !== scope.fingerprint) return undefined
    const { fingerprint: _fingerprint, ...view } = entry
    return view
  }

  clear(): void {
    this.entries.clear()
  }
}

export function withConnectionFacts(
  servers: readonly CapabilityMcpServerSettingView[],
  holders: readonly McpHolderServices[],
  history: McpCheckHistory,
  scopeOf: (serverId: string) => McpCheckScope
): CapabilityMcpServerSettingView[] {
  return servers.map((server) => {
    const lastCheck = history.get(server.id, scopeOf(server.id))
    const view: CapabilityMcpServerSettingView = { ...server }
    if (server.ownedBy !== 'inkstone') {
      view.connectedSessions = holders.filter((holder) =>
        holder.legacyMcpServices?.some((service) => service.serverId === server.id && service.status === 'ready')
      ).length
    }
    if (lastCheck) view.lastCheck = lastCheck
    return view
  })
}
