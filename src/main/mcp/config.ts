import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerConfig } from '../../shared/mcp'
import {
  type McpAppHostConfig,
  type McpAppNativeEntry,
  type McpAppOwnership,
  type McpAppServerConfig
} from './app-spec'
import { YAN_DIR } from '../paths'

export function mcpServersFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.YAN_MCP_SERVERS_FILE
  if (typeof override === 'string' && override.trim()) return override.trim()
  return join(YAN_DIR, 'mcp-servers.json')
}

export interface McpConfigLoadResult {
  servers: McpAppServerConfig[]
  error?: string
  document?: unknown
  file?: string
}

export function mcpServersForProject<T extends McpServerConfig>(
  servers: readonly T[],
  projectId: string | undefined
): T[] {
  return servers.filter((server) => !server.projectScope || Boolean(projectId) && server.projectScope === projectId)
    .map((server) => projectId && !server.projectScope && typeof server.projectEnabled?.[projectId] === 'boolean'
      ? { ...server, enabled: server.projectEnabled[projectId] }
      : server)
}

const TRANSPORTS = new Set(['stdio', 'http'])
const EFFECTS = new Set(['read', 'write', 'external-action', 'unknown'])

const KNOWN_SERVER_KEYS = new Set([
  'id', 'title', 'transport', 'command', 'args', 'env', 'url', 'authRef',
  'projectScope', 'projectEnabled', 'effect', 'enabled', 'migratedToNative', 'ownedBy', 'appHost'
])

function normalize(raw: unknown): McpAppServerConfig | { problem: string } {
  if (!raw || typeof raw !== 'object') return { problem: '条目不是对象' }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) return { problem: '缺少 id' }
  const transport = typeof r.transport === 'string' ? r.transport.trim() : ''
  if (!TRANSPORTS.has(transport)) return { problem: `${id}: transport 必须是 stdio 或 http` }

  if (transport === 'stdio') {
    if (typeof r.command !== 'string' || !r.command.trim()) return { problem: `${id}: stdio 必须有 command` }
  } else if (typeof r.url !== 'string' || !r.url.trim()) {
    return { problem: `${id}: http 必须有 url` }
  }

  const effect = typeof r.effect === 'string' && EFFECTS.has(r.effect) ? (r.effect as McpServerConfig['effect']) : undefined
  const stringifyConfigValue = (value: unknown): string | null =>
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean' ? String(value) : null
  const env: Record<string, string> = {}
  if (r.env !== undefined && (!r.env || typeof r.env !== 'object' || Array.isArray(r.env))) {
    return { problem: `${id}: env 必须是对象` }
  }
  if (r.env && typeof r.env === 'object') {
    for (const [key, value] of Object.entries(r.env as Record<string, unknown>)) {
      const normalized = stringifyConfigValue(value)
      if (normalized === null) return { problem: `${id}: env.${key} 必须是字符串、数字或布尔值` }
      env[key] = normalized
    }
  }
  if (r.args !== undefined && !Array.isArray(r.args)) return { problem: `${id}: args 必须是数组` }
  const args: string[] = []
  if (Array.isArray(r.args)) {
    for (let index = 0; index < r.args.length; index++) {
      const normalized = stringifyConfigValue(r.args[index])
      if (normalized === null) return { problem: `${id}: args[${index}] 必须是字符串、数字或布尔值` }
      args.push(normalized)
    }
  }
  const migratedToNative = parseMigratedMark(r.migratedToNative)
  if (r.projectEnabled !== undefined && (!r.projectEnabled || typeof r.projectEnabled !== 'object' || Array.isArray(r.projectEnabled) || Object.values(r.projectEnabled).some((value) => typeof value !== 'boolean'))) {
    return { problem: `${id}: projectEnabled 必须是项目 ID 到布尔值的对象` }
  }
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(r)) {
    if (!KNOWN_SERVER_KEYS.has(key)) extras[key] = value
  }
  const ownedBy: McpAppOwnership | undefined =
    r.ownedBy === 'inkstone' ? 'inkstone' : r.ownedBy === 'pi' ? 'pi' : undefined
  const appHost = parseAppHost(r.appHost)
  return {
    ...extras,
    id,
    ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
    transport: transport as McpServerConfig['transport'],
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
    ...(Array.isArray(r.args) ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(typeof r.authRef === 'string' && r.authRef.trim() ? { authRef: r.authRef.trim() } : {}),
    ...(typeof r.projectScope === 'string' && r.projectScope.trim() ? { projectScope: r.projectScope.trim() } : {}),
    ...(r.projectEnabled ? { projectEnabled: { ...r.projectEnabled as Record<string, boolean> } } : {}),
    ...(effect ? { effect } : {}),
    ...(r.enabled === false ? { enabled: false } : {}),
    ...(migratedToNative ? { migratedToNative } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    ...(appHost ? { appHost } : {})
  }
}

function nativeExtras(native: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(native)) {
    if (key !== 'path' && key !== 'name' && key !== 'entry' && key !== 'fingerprint') extras[key] = value
  }
  return extras
}

function parseAppHost(raw: unknown): McpAppHostConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.at !== 'string' || !r.at.trim()) return undefined
  if (!Array.isArray(r.natives)) return undefined
  const natives: McpAppNativeEntry[] = []
  for (const item of r.natives) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const native = item as Record<string, unknown>
    if (typeof native.path !== 'string' || !native.path.trim()) return undefined
    if (typeof native.name !== 'string' || !native.name.trim()) return undefined
    if (typeof native.fingerprint !== 'string' || !native.fingerprint.trim()) return undefined
    natives.push({
      ...nativeExtras(native),
      path: native.path,
      name: native.name,
      entry: 'entry' in native ? native.entry : undefined,
      fingerprint: native.fingerprint
    })
  }
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(r)) {
    if (key !== 'at' && key !== 'natives') extras[key] = value
  }
  return { ...extras, at: r.at, natives }
}

function parseMigratedMark(raw: unknown): McpServerConfig['migratedToNative'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.at !== 'string' || !r.at.trim() || typeof r.targetPath !== 'string' || !r.targetPath.trim()) return undefined
  return {
    at: r.at,
    targetPath: r.targetPath,
    ...(typeof r.nativeName === 'string' && r.nativeName.trim() ? { nativeName: r.nativeName.trim() } : {})
  }
}

export function loadMcpServers(env: NodeJS.ProcessEnv = process.env): McpConfigLoadResult {
  const file = mcpServersFile(env)
  if (!existsSync(file)) return { servers: [], file }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { servers: [], file, error: `无法读取 MCP 配置（${file}）：${error instanceof Error ? error.message : String(error)}` }
  }
  return parseMcpServersDocument(text, file)
}

let cachedLoad: { file: string; mtimeMs: number; size: number; result: McpConfigLoadResult } | null = null

export function loadMcpServersCached(env: NodeJS.ProcessEnv = process.env): McpConfigLoadResult {
  const file = mcpServersFile(env)
  let mtimeMs: number
  let size: number
  try {
    const info = statSync(file)
    mtimeMs = info.mtimeMs
    size = info.size
  } catch {
    return { servers: [], file }
  }
  if (cachedLoad && cachedLoad.file === file && cachedLoad.mtimeMs === mtimeMs && cachedLoad.size === size) {
    return cachedLoad.result
  }
  const result = loadMcpServers(env)
  cachedLoad = { file, mtimeMs, size, result }
  return result
}

export function parseMcpServersDocument(text: string, file: string): McpConfigLoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { servers: [], file, error: `MCP 配置不是合法 JSON（${file}）：${error instanceof Error ? error.message : String(error)}` }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { servers?: unknown }).servers)
      ? ((parsed as { servers: unknown[] }).servers as unknown[])
      : null
  if (!list) return { servers: [], file, document: parsed, error: `MCP 配置必须是数组或 { servers: [...] }（${file}）` }

  const servers: McpAppServerConfig[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const result = normalize(item)
    if ('problem' in result) {
      problems.push(result.problem)
      continue
    }
    if (seen.has(result.id)) {
      problems.push(`重复的服务 id：${result.id}（已忽略后一条）`)
      continue
    }
    seen.add(result.id)
    servers.push(result)
  }
  return { servers, file, document: parsed, ...(problems.length ? { error: problems.join('；') } : {}) }
}
