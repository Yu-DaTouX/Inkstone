import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../shared/plugin-market'

export const MINECRAFT_PLUGIN_ID = 'inkstone-minecraft'
export const MINECRAFT_SKILL = 'inkstone-fabric-dev'
const PLUGIN_PARTS = ['package.json', 'mcp', 'src', 'skills', 'templates', 'companion-mod']
const SKIPPED_DIRS = new Set(['.gradle', 'run', '.inkstone', 'node_modules', 'out'])
const SOURCE_STAMP = '.inkstone-source.json'

export interface MinecraftPluginPaths {
  source: string | null
  pluginDir: string
  skillsDir: string
  agentDir: string
  runtime: string
}

type McpDocument = { mcpServers?: Record<string, unknown> } & Record<string, unknown>

function serverScript(pluginDir: string): string {
  return join(pluginDir, 'mcp', 'server.ts')
}

export function minecraftMcpServer(paths: Pick<MinecraftPluginPaths, 'pluginDir' | 'runtime'>): Record<string, unknown> {
  return { command: paths.runtime, args: ['--no-warnings', serverScript(paths.pluginDir)], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function copiesIntoPlugin(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep).filter(Boolean)
  if (parts.some((part) => SKIPPED_DIRS.has(part))) return false
  const build = parts.indexOf('build')
  if (build < 0) return true
  const inside = parts.slice(build + 1)
  if (inside.length === 0) return true
  if (inside[0] !== 'libs') return false
  return inside.length === 1 || (inside.length === 2 && inside[1].endsWith('.jar'))
}

export async function minecraftSourceFingerprint(source: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (path: string): Promise<void> => {
    if (!copiesIntoPlugin(source, path)) return
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
    if (!entries) {
      hash.update(relative(source, path).split(sep).join('/')).update('\0').update(await readFile(path)).update('\0')
      return
    }
    for (const entry of entries.map((item) => item.name).sort()) await walk(join(path, entry))
  }
  for (const part of PLUGIN_PARTS) if (existsSync(join(source, part))) await walk(join(source, part))
  return hash.digest('hex')
}

async function installedFingerprint(pluginDir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(pluginDir, SOURCE_STAMP), 'utf8')) as { fingerprint?: unknown }
    return typeof value.fingerprint === 'string' ? value.fingerprint : undefined
  } catch {
    return undefined
  }
}

export async function refreshMinecraftPlugin(paths: MinecraftPluginPaths): Promise<'updated' | 'current' | 'skipped' | MinecraftPluginResult> {
  if (!paths.source || !existsSync(serverScript(paths.source)) || !existsSync(serverScript(paths.pluginDir))) return 'skipped'
  const { document } = await readMcp(paths.agentDir).catch(() => ({ document: undefined }))
  const entry = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
  if (!isOurs(entry, paths.pluginDir)) return 'skipped'
  const runtimeCurrent = (entry as { command?: unknown }).command === paths.runtime
  const skillPresent = existsSync(join(paths.skillsDir, MINECRAFT_SKILL, 'SKILL.md'))
  if (runtimeCurrent && skillPresent && (await installedFingerprint(paths.pluginDir)) === (await minecraftSourceFingerprint(paths.source))) return 'current'
  const result = await installMinecraftPlugin(paths)
  return result.ok ? 'updated' : result
}

function isOurs(entry: unknown, pluginDir: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  const args = (entry as { args?: unknown }).args
  const script = serverScript(pluginDir).toLowerCase()
  return Array.isArray(args) && args.some((arg) => typeof arg === 'string' && arg.toLowerCase() === script)
}

async function readMcp(agentDir: string): Promise<{ path: string; document: McpDocument | undefined }> {
  const path = join(agentDir, 'mcp.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, document: undefined }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} 不是合法 JSON，未改动`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} 顶层必须是 JSON 对象，未改动`)
  const servers = (parsed as McpDocument).mcpServers
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error(`${path} 里的 mcpServers 必须是对象，未改动`)
  return { path, document: parsed as McpDocument }
}

async function writeMcp(path: string, document: McpDocument): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function minecraftPluginStatus(paths: MinecraftPluginPaths): Promise<MinecraftPluginStatus> {
  let configured = false
  let conflict = false
  try {
    const { document } = await readMcp(paths.agentDir)
    const entry = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
    if (entry !== undefined) {
      conflict = !isOurs(entry, paths.pluginDir)
      configured = !conflict && (entry as { enabled?: unknown }).enabled !== false
    }
  } catch {
  }
  return {
    bundled: paths.source !== null && existsSync(serverScript(paths.source)),
    installed: existsSync(serverScript(paths.pluginDir)),
    configured,
    conflict,
    skill: existsSync(join(paths.skillsDir, MINECRAFT_SKILL, 'SKILL.md')),
    pluginDir: paths.pluginDir
  }
}

export async function installMinecraftPlugin(paths: MinecraftPluginPaths): Promise<MinecraftPluginResult> {
  try {
    const source = paths.source
    if (!source || !existsSync(serverScript(source))) return { ok: false, error: '随包插件文件缺失，请更新砚', status: await minecraftPluginStatus(paths) }
    const { path, document } = await readMcp(paths.agentDir)
    const current = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
    if (current !== undefined && !isOurs(current, paths.pluginDir)) {
      return { ok: false, error: `${path} 里已有同名服务「${MINECRAFT_PLUGIN_ID}」，不是砚装的，未改动`, status: await minecraftPluginStatus(paths) }
    }
    const staging = `${paths.pluginDir}.${randomBytes(4).toString('hex')}.new`
    try {
      for (const part of PLUGIN_PARTS) {
        const from = join(source, part)
        if (existsSync(from)) await cp(from, join(staging, part), { recursive: true, filter: (item) => copiesIntoPlugin(source, item) })
      }
      await writeFile(join(staging, SOURCE_STAMP), `${JSON.stringify({ fingerprint: await minecraftSourceFingerprint(source) })}\n`, 'utf8')
      await rm(paths.pluginDir, { recursive: true, force: true })
      await mkdir(join(paths.pluginDir, '..'), { recursive: true })
      await rename(staging, paths.pluginDir)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    const skillTarget = join(paths.skillsDir, MINECRAFT_SKILL)
    await rm(skillTarget, { recursive: true, force: true })
    await cp(join(paths.pluginDir, 'skills', MINECRAFT_SKILL), skillTarget, { recursive: true })
    const enabled = current && typeof current === 'object' && (current as { enabled?: unknown }).enabled === false ? { enabled: false } : {}
    await writeMcp(path, { ...(document ?? {}), mcpServers: { ...(document?.mcpServers ?? {}), [MINECRAFT_PLUGIN_ID]: { ...minecraftMcpServer(paths), ...enabled } } })
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  }
}

export async function removeMinecraftPlugin(paths: MinecraftPluginPaths): Promise<MinecraftPluginResult> {
  try {
    const { path, document } = await readMcp(paths.agentDir)
    const servers = document?.mcpServers
    if (document && servers && isOurs(servers[MINECRAFT_PLUGIN_ID], paths.pluginDir)) {
      const { [MINECRAFT_PLUGIN_ID]: _removed, ...rest } = servers
      await writeMcp(path, { ...document, mcpServers: rest })
    }
    await rm(join(paths.skillsDir, MINECRAFT_SKILL), { recursive: true, force: true })
    await rm(paths.pluginDir, { recursive: true, force: true })
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  }
}
