import { createHash } from 'node:crypto'
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { dirname, basename, resolve } from 'node:path'
import type { McpServerConfig } from '../shared/mcp'
import { McpConnectionManager } from './mcp/connection-manager'
import { resolveNativeMcpServers } from './mcp/native-list'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const literal = (value: unknown): value is string => typeof value === 'string' && !value.startsWith('!') && !value.includes('$')
const visible = (value: unknown): boolean => value === undefined || value === 'direct' || value === 'codemode' || value === 'deferred'
const allowedName = (name: string): boolean => name !== 'inkstone-pi' && /^[a-zA-Z0-9_-]{1,64}$/.test(name)

export interface AntigravityMcpService {
  name: string
  manager: McpConnectionManager
  exposes?(tool: string): boolean
}

function normalizedEntries(recordValue: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(recordValue).sort(([a], [b]) => a.localeCompare(b))
}

function hostFingerprintItem(server: McpServerConfig) {
  return {
    id: server.id,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? null,
    env: server.env ? normalizedEntries(server.env) : null,
    url: server.url ?? null,
    headers: server.headers ? normalizedEntries(server.headers) : null,
    cwd: server.cwd ?? null
  }
}

async function resolveAntigravityMcpConfig(input: {
  agentDir: string
  cwd: string
  trusted: boolean
  hostConfigs: readonly McpServerConfig[]
}) {
  const { entries } = await resolveNativeMcpServers({ agentDir: input.agentDir, projectCwd: input.cwd, projectTrusted: input.trusted })
  const hostConfigs = input.hostConfigs.filter((server) => server.enabled !== false && allowedName(server.id) && !entries.has(server.id))
  const nativeConfigs: McpServerConfig[] = []
  const exposesByName = new Map<string, (tool: string) => boolean>()
  const nativeFingerprintItems: unknown[] = []
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
    let config: McpServerConfig
    if (literal(entry.url) && /^https?:\/\//i.test(entry.url) && Object.values(headers).every(literal)) {
      config = { id: name, transport: 'http', url: entry.url, headers: headers as Record<string, string> }
    } else if (entry.url === undefined && (entry.type === undefined || entry.type === 'stdio') && literal(entry.command) && entry.command.trim() &&
      Array.isArray(args) && args.every(literal) && Object.values(env).every(literal) && (entry.cwd === undefined || literal(entry.cwd))) {
      config = {
        id: name,
        transport: 'stdio',
        command: entry.command,
        args,
        env: env as Record<string, string>,
        cwd: typeof entry.cwd === 'string' ? resolve(input.cwd, entry.cwd) : input.cwd
      }
    } else continue
    nativeConfigs.push(config)
    exposesByName.set(name, exposes)
    nativeFingerprintItems.push({
      ...hostFingerprintItem(config),
      exposure: entry.exposure ?? null,
      toolExposure: normalizedEntries(overrides)
    })
  }
  const hostFingerprintItems = hostConfigs.map(hostFingerprintItem).sort((a, b) => a.id.localeCompare(b.id))
  nativeFingerprintItems.sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id))
  const fingerprint = createHash('sha1').update(JSON.stringify({ host: hostFingerprintItems, native: nativeFingerprintItems })).digest('hex')
  return {
    hostNames: hostConfigs.map((server) => server.id),
    nativeConfigs,
    exposesByName,
    fingerprint
  }
}

export async function antigravityMcpFingerprint(input: {
  agentDir: string
  cwd: string
  trusted: boolean
  hostConfigs: readonly McpServerConfig[]
}): Promise<string> {
  return (await resolveAntigravityMcpConfig(input)).fingerprint
}

export async function antigravityMcpServices(input: {
  agentDir: string
  cwd: string
  trusted: boolean
  host: McpConnectionManager
  native?: McpConnectionManager
  onToolsListChanged?: (serverId: string) => void
}) {
  const { hostNames, nativeConfigs, exposesByName, fingerprint } = await resolveAntigravityMcpConfig({
    agentDir: input.agentDir,
    cwd: input.cwd,
    trusted: input.trusted,
    hostConfigs: input.host.list()
  })
  const ownsNative = !input.native
  const native = input.native ?? new McpConnectionManager([])
  const releases = native.syncServers(nativeConfigs)
  void Promise.allSettled(releases.map((item) => item.release))
  const services: AntigravityMcpService[] = [
    ...hostNames.map((name) => ({ name, manager: input.host })),
    ...nativeConfigs.map((config) => ({ name: config.id, manager: native, exposes: exposesByName.get(config.id) }))
  ]
  const hostSet = new Set(hostNames)
  const nativeSet = new Set(nativeConfigs.map((config) => config.id))
  const offHost = input.onToolsListChanged
    ? input.host.onToolsListChanged((serverId) => {
        if (hostSet.has(serverId)) input.onToolsListChanged?.(serverId)
      })
    : undefined
  const offNative = input.onToolsListChanged
    ? native.onToolsListChanged((serverId) => {
        if (nativeSet.has(serverId)) input.onToolsListChanged?.(serverId)
      })
    : undefined
  return {
    services,
    fingerprint,
    close: async () => {
      offHost?.()
      offNative?.()
      if (ownsNative) await native.close()
    }
  }
}

export const ANTIGRAVITY_MCP_WARM_MS = 15_000

export async function warmAntigravityMcp(services: readonly AntigravityMcpService[], timeoutMs = ANTIGRAVITY_MCP_WARM_MS): Promise<string[]> {
  if (!services.length) return []
  const controller = new AbortController()
  const pending = new Set(services.map(({ name }) => name))
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolveDeadline) => {
    timer = setTimeout(() => {
      controller.abort()
      resolveDeadline()
    }, timeoutMs)
    timer.unref?.()
  })
  const work = Promise.allSettled(services.map(async ({ name, manager }) => {
    await manager.listToolsRaw(name, { signal: controller.signal })
    pending.delete(name)
  }))
  try {
    await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return [...pending]
}

export function watchAntigravityMcpFiles(files: readonly string[], onChange: () => void): { close(): void } {
  const targetsByDir = new Map<string, Set<string>>()
  const dirsByDir = new Map<string, Set<string>>()
  const sameCase = process.platform === 'win32'
  const normalizeName = (value: string) => sameCase ? value.toLowerCase() : value
  for (const file of files) {
    const dir = resolve(dirname(file))
    const key = sameCase ? dir.toLowerCase() : dir
    let names = targetsByDir.get(key)
    if (!names) {
      names = new Set<string>()
      targetsByDir.set(key, names)
    }
    names.add(normalizeName(basename(file)))
    const parent = resolve(dirname(dir))
    if (parent !== dir) {
      const parentKey = sameCase ? parent.toLowerCase() : parent
      if (!targetsByDir.has(parentKey)) targetsByDir.set(parentKey, new Set<string>())
      let parentNames = dirsByDir.get(parentKey)
      if (!parentNames) {
        parentNames = new Set<string>()
        dirsByDir.set(parentKey, parentNames)
      }
      parentNames.add(normalizeName(basename(dir)))
    }
  }
  const actualDir = new Map<string, string>()
  for (const file of files) {
    const dir = resolve(dirname(file))
    actualDir.set(sameCase ? dir.toLowerCase() : dir, dir)
    const parent = resolve(dirname(dir))
    if (parent !== dir) actualDir.set(sameCase ? parent.toLowerCase() : parent, parent)
  }
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const watchers = new Map<string, FSWatcher>()
  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (closed) return
      attachMissing()
      onChange()
    }, 120)
    timer.unref?.()
  }
  const attachMissing = () => {
    if (closed) return
    for (const [key, names] of targetsByDir) {
      if (watchers.has(key)) continue
      const dir = actualDir.get(key)
      if (!dir || !existsSync(dir)) continue
      try {
        const dirs = dirsByDir.get(key)
        const watcher = fsWatch(dir, { persistent: false }, (event, name) => {
          if (name === null) return schedule()
          const entry = normalizeName(name)
          if (names.has(entry) || (event === 'rename' && dirs?.has(entry))) schedule()
        })
        watcher.on('error', () => {
          try { watcher.close() } catch {}
          if (watchers.get(key) === watcher) watchers.delete(key)
        })
        watchers.set(key, watcher)
      } catch {
      }
    }
  }
  attachMissing()
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      for (const watcher of watchers.values()) {
        try { watcher.close() } catch {}
      }
      watchers.clear()
    }
  }
}
