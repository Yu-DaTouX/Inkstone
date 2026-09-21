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
import { YAN_DIR } from '../paths'

export function mcpServersFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.YAN_MCP_SERVERS_FILE
  if (typeof override === 'string' && override.trim()) return override.trim()
  return join(YAN_DIR, 'mcp-servers.json')
}

export interface McpConfigLoadResult {
  servers: McpServerConfig[]
  /** 配置有问题时的可读说明 —— **不静默**吞掉（否则「服务没连上」会变成谜）。 */
  error?: string
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

function normalize(raw: unknown): McpServerConfig | { problem: string } {
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
  const env: Record<string, string> = {}
  if (r.env && typeof r.env === 'object') {
    for (const [key, value] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
  }
  return {
    id,
    ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
    transport: transport as McpServerConfig['transport'],
    ...(typeof r.command === 'string' ? { command: r.command } : {}),
    ...(Array.isArray(r.args) ? { args: r.args.filter((a): a is string => typeof a === 'string') } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(typeof r.url === 'string' ? { url: r.url } : {}),
    ...(typeof r.authRef === 'string' && r.authRef.trim() ? { authRef: r.authRef.trim() } : {}),
    ...(typeof r.projectScope === 'string' && r.projectScope.trim() ? { projectScope: r.projectScope.trim() } : {}),
    ...(effect ? { effect } : {}),
    ...(r.enabled === false ? { enabled: false } : {})
  }
}

export function loadMcpServers(env: NodeJS.ProcessEnv = process.env): McpConfigLoadResult {
  const file = mcpServersFile(env)
  if (!existsSync(file)) return { servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { servers: [], error: `MCP 配置不是合法 JSON（${file}）：${error instanceof Error ? error.message : String(error)}` }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { servers?: unknown }).servers)
      ? ((parsed as { servers: unknown[] }).servers as unknown[])
      : null
  if (!list) return { servers: [], error: `MCP 配置必须是数组或 { servers: [...] }（${file}）` }

  const servers: McpServerConfig[] = []
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
  return { servers, ...(problems.length ? { error: problems.join('；') } : {}) }
}
