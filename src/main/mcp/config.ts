/**
 * MCP 服务配置的读取（实施-04 §3 / §5）。
 *
 * 配置是**宿主文件**（`YAN_DIR/mcp-servers.json`），不是模型能写的东西 ——
 * 这一点很关键：MCP 服务的 `command` / `url` 决定「会执行什么代码、连到哪里」，
 * 让模型能改配置就等于给了一个任意命令执行入口。
 *
 * 测试用 `YAN_MCP_SERVERS_FILE` 指向隔离文件（与 `YAN_DIR` 那一套隔离变量同风格）。
 */
import { existsSync, readFileSync } from 'node:fs'
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
  /** 配置有问题时的可读说明 —— **不静默**吞掉（否则「服务没连上」会变成谜）。 */
  error?: string
  /** 解析出的原始文档（导入 pi 原生时保留未知字段用；数组或 `{ servers }` 形状都可能是它）。 */
  document?: unknown
  /** 实际读取的文件路径。 */
  file?: string
}

/**
 * Runner 可见的 MCP 服务：全局服务可共用，项目服务只进绑定项目的 runner。
 * 无项目身份时只保留全局项，避免把缺失身份当成授权。
 */
export function mcpServersForProject(
  servers: readonly McpServerConfig[],
  projectId: string | undefined
): McpServerConfig[] {
  return servers.filter((server) => !server.projectScope || Boolean(projectId) && server.projectScope === projectId)
}

const TRANSPORTS = new Set(['stdio', 'http'])
const EFFECTS = new Set(['read', 'write', 'external-action', 'unknown'])

/** 已归一化的字段：其余顶层键**原样保留**，避免回写时抹掉别的 agent 或用户手写的字段。 */
const KNOWN_SERVER_KEYS = new Set([
  'id', 'title', 'transport', 'command', 'args', 'env', 'url', 'authRef',
  'projectScope', 'effect', 'enabled', 'migratedToNative', 'ownedBy', 'appHost'
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
  /* 未知字段保留：先铺原始条目，再用归一化结果覆盖已知键（顺序即优先级）。 */
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
    ...(effect ? { effect } : {}),
    ...(r.enabled === false ? { enabled: false } : {}),
    ...(migratedToNative ? { migratedToNative } : {}),
    ...(ownedBy ? { ownedBy } : {}),
    ...(appHost ? { appHost } : {})
  }
}

/** `natives[]` 里已知字段之外的键保留，回写时不抹掉。 */
function nativeExtras(native: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(native)) {
    if (key !== 'path' && key !== 'name' && key !== 'entry' && key !== 'fingerprint') extras[key] = value
  }
  return extras
}

/**
 * 解析砚托管声明 `appHost{at,natives[]}`。
 *
 * 形状不对就**丢弃整条标记**（等价于未托管，宁可连不上也不误接管）；
 * `natives[].entry` 是回退时要逐字写回的原条目，任何 JSON 值都保留。
 */
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

/** `migratedToNative` 只认形状正确的标记；坏值静默丢弃（不因此拒绝整条服务）。 */
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

/** 从已读到的文本解析配置；导入 pi 原生也走这里，保证与调用侧同一套清洗规则。 */
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
