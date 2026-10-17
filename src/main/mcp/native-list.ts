import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeMcpServerListView, NativeMcpServerView } from '../../shared/mcp-native-import'

const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

async function readNativeDocument(path: string): Promise<{ servers: Record<string, unknown> } | { error: string } | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { error: `${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const root = asRecord(JSON.parse(text))
    if (!root) return { error: `${path}: 顶层不是 JSON 对象` }
    if (root.mcpServers === undefined) return { servers: {} }
    const servers = asRecord(root.mcpServers)
    return servers ? { servers } : { error: `${path}: mcpServers 不是对象` }
  } catch (error) {
    return { error: `${path}: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）` }
  }
}

function endpointOrigin(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function describeEntry(name: string, raw: unknown, scope: 'global' | 'project', path: string): NativeMcpServerView {
  const entry = asRecord(raw) ?? {}
  const origin = endpointOrigin(entry.url)
  return {
    name,
    scope,
    path,
    transport: typeof entry.url === 'string' ? 'http' : 'stdio',
    ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
    argCount: Array.isArray(entry.args) ? entry.args.length : 0,
    ...(origin ? { endpointOrigin: origin } : {}),
    ...(typeof entry.exposure === 'string' ? { exposure: entry.exposure } : {}),
    enabled: entry.enabled !== false
  }
}

function isOverride(raw: unknown): boolean {
  const entry = asRecord(raw)
  return Boolean(entry) && Object.keys(entry!).every((key) => OVERRIDE_KEYS.has(key))
}

export async function listNativeMcpServers(input: {
  agentDir: string
  projectCwd?: string
  projectTrusted?: boolean
}): Promise<NativeMcpServerListView> {
  const errors: string[] = []
  const servers = new Map<string, NativeMcpServerView>()
  const globalPath = join(input.agentDir, 'mcp.json')
  const globalDoc = await readNativeDocument(globalPath)
  if (globalDoc && 'error' in globalDoc) errors.push(globalDoc.error)
  else if (globalDoc) {
    for (const [name, raw] of Object.entries(globalDoc.servers)) servers.set(name, describeEntry(name, raw, 'global', globalPath))
  }
  let projectPath: string | undefined
  let projectSkipped = false
  if (input.projectCwd) {
    projectPath = join(input.projectCwd, '.pi', 'mcp.json')
    const projectDoc = await readNativeDocument(projectPath)
    if (projectDoc && 'error' in projectDoc) errors.push(projectDoc.error)
    else if (projectDoc && Object.keys(projectDoc.servers).length > 0) {
      if (!input.projectTrusted) projectSkipped = true
      else {
        for (const [name, raw] of Object.entries(projectDoc.servers)) {
          const base = servers.get(name)
          if (base && isOverride(raw)) {
            const patch = asRecord(raw)!
            servers.set(name, {
              ...base,
              ...(patch.enabled !== undefined ? { enabled: patch.enabled !== false } : {}),
              ...(typeof patch.exposure === 'string' ? { exposure: patch.exposure } : {}),
              overriddenBy: projectPath
            })
          } else {
            servers.set(name, describeEntry(name, raw, 'project', projectPath))
          }
        }
      }
    }
  }
  return {
    servers: [...servers.values()],
    globalPath,
    ...(projectPath ? { projectPath } : {}),
    ...(projectSkipped ? { projectUntrusted: true } : {}),
    ...(errors.length ? { errors } : {})
  }
}
