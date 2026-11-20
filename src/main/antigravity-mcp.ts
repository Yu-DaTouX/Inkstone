import { resolve } from 'node:path'
import type { McpServerConfig } from '../shared/mcp'
import { McpConnectionManager } from './mcp/connection-manager'
import { resolveNativeMcpServers } from './mcp/native-list'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const literal = (value: unknown): value is string => typeof value === 'string' && !value.startsWith('!') && !value.includes('$')
const visible = (value: unknown): boolean => value === undefined || value === 'direct' || value === 'codemode' || value === 'deferred'

export interface AntigravityMcpService {
  name: string
  manager: McpConnectionManager
  exposes?(tool: string): boolean
}

export async function antigravityMcpServices(input: {
  agentDir: string
  cwd: string
  trusted: boolean
  host: McpConnectionManager
}) {
  const { entries } = await resolveNativeMcpServers({ agentDir: input.agentDir, projectCwd: input.cwd, projectTrusted: input.trusted })
  const allowedName = (name: string) => name !== 'inkstone-pi' && /^[a-zA-Z0-9_-]{1,64}$/.test(name)
  const services: AntigravityMcpService[] = input.host.list().filter((server) => server.enabled !== false && allowedName(server.id) && !entries.has(server.id))
    .map((server) => ({ name: server.id, manager: input.host }))
  const configs: McpServerConfig[] = []
  const native = new McpConnectionManager([])
  for (const [name, raw] of entries) {
    const entry = record(raw)
    if (!allowedName(name) || entry.enabled === false) continue
    const overrides = record(entry.toolExposure)
    if (!visible(entry.exposure) && !Object.values(overrides).some(visible)) continue
    const exposes = (tool: string) => visible(Object.hasOwn(overrides, tool) ? overrides[tool] : overrides['*'] ?? entry.exposure)
    const args = entry.args ?? []
    const env = record(entry.env)
    const headers = record(entry.headers)
    if (entry.oauth !== undefined || entry.auth !== undefined || entry.authRef !== undefined || entry.bearerTokenEnvVar !== undefined) continue
    if (literal(entry.url) && /^https?:\/\//i.test(entry.url) && Object.values(headers).every(literal)) {
      configs.push({ id: name, transport: 'http', url: entry.url, headers: headers as Record<string, string> })
    } else if (entry.url === undefined && (entry.type === undefined || entry.type === 'stdio') && literal(entry.command) && entry.command.trim() &&
      Array.isArray(args) && args.every(literal) && Object.values(env).every(literal) && (entry.cwd === undefined || literal(entry.cwd))) {
      configs.push({ id: name, transport: 'stdio', command: entry.command, args, env: env as Record<string, string>,
        cwd: typeof entry.cwd === 'string' ? resolve(input.cwd, entry.cwd) : input.cwd })
    } else continue
    services.push({ name, manager: native, exposes })
  }
  native.syncServers(configs)
  return { services, close: () => native.close() }
}
