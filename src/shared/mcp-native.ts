import { pick } from './ui-lang'

export const WINDOWS_MCP_SERVER_ID = 'windows-mcp'

export interface NativeMcpServerView {
  name: string
  scope: 'global' | 'project'
  path: string
  transport: 'stdio' | 'http'
  command?: string
  argCount: number
  endpointOrigin?: string
  exposure?: string
  enabled: boolean
  overriddenBy?: string
}

export interface NativeMcpServerListView {
  servers: NativeMcpServerView[]
  globalPath: string
  projectPath?: string
  projectUntrusted?: boolean
  errors?: string[]
}

const NATIVE_SERVER_NAME = /^[A-Za-z0-9_-]+$/

export function nativeMcpServerName(id: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = id.trim()
  if (!name) return { ok: false, reason: pick('服务 id 为空，不能作为 pi 原生服务名', 'Service id is empty and cannot be a pi native service name') }
  if (!NATIVE_SERVER_NAME.test(name)) {
    return {
      ok: false,
      reason: pick(`服务 id「${id}」含 pi 不接受的字符（只允许字母、数字、_ 和 -）；不会自动改名，请先在砚里改名`, `Service id "${id}" has characters pi does not accept (letters, digits, _ and - only); it is not renamed automatically, so rename it in Inkstone first`)
    }
  }
  return { ok: true, name }
}

export function buildNativeMcpDocument(options: {
  existing: unknown
  name: string
  server: Record<string, unknown>
}): { ok: true; document: Record<string, unknown> } | { ok: false; code: 'target_shape' | 'name_conflict'; reason: string } {
  const { existing, name, server } = options
  if (existing === undefined) {
    return { ok: true, document: { mcpServers: { [name]: server } } }
  }
  if (existing === null) {
    return { ok: false, code: 'target_shape', reason: pick('pi 原生 mcp.json 解析结果是 JSON null（坏配置），拒绝覆盖', 'pi\'s native mcp.json parses to JSON null (bad config); not overwritten') }
  }
  if (typeof existing !== 'object' || Array.isArray(existing)) {
    return { ok: false, code: 'target_shape', reason: pick('pi 原生 mcp.json 顶层必须是 JSON 对象', 'pi\'s native mcp.json must be a JSON object at the top level') }
  }
  const record = existing as Record<string, unknown>
  const current = record.mcpServers
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    return { ok: false, code: 'target_shape', reason: pick('pi 原生 mcp.json 里的 mcpServers 必须是对象，拒绝改写成其它形状', 'mcpServers in pi\'s native mcp.json must be an object; not rewritten') }
  }
  const servers = (current ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    return { ok: false, code: 'name_conflict', reason: pick(`pi 原生 mcp.json 已经有同名服务「${name}」，拒绝覆盖`, `pi's native mcp.json already has a service named "${name}"; not overwritten`) }
  }
  return { ok: true, document: { ...record, mcpServers: { ...servers, [name]: server } } }
}
