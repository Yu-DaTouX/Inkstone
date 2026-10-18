import { readFile } from 'node:fs/promises'
import type { NativeMcpServerListView } from '../../shared/mcp-native-import'
import type { NativeMcpManageAction, NativeMcpManageResult } from '../../shared/ipc'
import { atomicWrite, nativeMcpTextFingerprint } from './native-import'

const MANAGE_ACTIONS = new Set<NativeMcpManageAction>(['enable', 'disable', 'remove'])

type ServerMap = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isOverrideEntry(entry: Record<string, unknown>): boolean {
  return entry.command === undefined && entry.url === undefined && entry.type === undefined
}

export function parseNativeMcpManageRequest(
  value: unknown
): { ok: true; action: NativeMcpManageAction; name: string } | { ok: false; error: string } {
  const input = asRecord(value)
  const action = input?.action
  const name = input?.name
  if (typeof action !== 'string' || !MANAGE_ACTIONS.has(action as NativeMcpManageAction)) {
    return { ok: false, error: '不支持的操作' }
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return { ok: false, error: '服务名无效' }
  return { ok: true, action: action as NativeMcpManageAction, name }
}

async function editNativeMcpFile(path: string, edit: (servers: ServerMap) => boolean): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path} 不存在，未写入`)
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON，未写入（${error instanceof Error ? error.message : String(error)}）`)
  }
  const root = asRecord(parsed)
  const servers = asRecord(root?.mcpServers)
  if (!root || !servers) throw new Error(`${path} 缺少 mcpServers 对象，未写入`)
  if (!edit(servers)) return
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] || '  '
  await atomicWrite(path, `${JSON.stringify(root, null, indent)}\n`, nativeMcpTextFingerprint(text))
}

function setEnabled(path: string, name: string, enabled: boolean): Promise<void> {
  return editNativeMcpFile(path, (servers) => {
    const entry = asRecord(servers[name])
    if (!entry) throw new Error(`${path} 里没有服务「${name}」`)
    if (enabled && !isOverrideEntry(entry)) delete entry.enabled
    else entry.enabled = enabled
    return true
  })
}

function removeEntry(path: string, name: string): Promise<void> {
  return editNativeMcpFile(path, (servers) => {
    if (servers[name] === undefined) return false
    delete servers[name]
    return true
  })
}

export async function manageNativeMcpServer(
  list: NativeMcpServerListView,
  request: unknown
): Promise<NativeMcpManageResult> {
  const parsed = parseNativeMcpManageRequest(request)
  if (!parsed.ok) return parsed
  const server = list.servers.find((item) => item.name === parsed.name)
  if (!server) return { ok: false, error: `没有找到 pi 原生 MCP 服务「${parsed.name}」` }
  const allowed = new Set([list.globalPath, ...(list.projectPath ? [list.projectPath] : [])])
  const definedIn = server.path
  const overrideIn = server.overriddenBy
  if (!allowed.has(definedIn) || (overrideIn !== undefined && !allowed.has(overrideIn))) {
    return { ok: false, error: '服务所在的配置文件不在允许范围内' }
  }
  try {
    if (parsed.action === 'remove') {
      if (overrideIn) await removeEntry(overrideIn, server.name)
      await removeEntry(definedIn, server.name)
    } else {
      await setEnabled(overrideIn ?? definedIn, server.name, parsed.action === 'enable')
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
