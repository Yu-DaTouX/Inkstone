import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../shared/plugin-market'

export const MINECRAFT_PLUGIN_ID = 'inkstone-minecraft'
export const MINECRAFT_SKILL = 'inkstone-fabric-dev'
export const MINECRAFT_PLUGIN_REPO = 'Yu-DaTouX/inkstone-minecraft-plugin'
export const MINECRAFT_PLUGIN_ARCHIVE = `https://github.com/${MINECRAFT_PLUGIN_REPO}/releases/latest/download/inkstone-minecraft-plugin.zip`
export const MINECRAFT_PLUGIN_LATEST = `https://api.github.com/repos/${MINECRAFT_PLUGIN_REPO}/releases/latest`
const PLUGIN_PARTS = ['package.json', 'mcp', 'src', 'skills', 'templates', 'companion-mod']
const SKIPPED_DIRS = new Set(['.gradle', 'run', '.inkstone', 'node_modules', 'out'])
const SKILL_STAMP = '.installed-by-inkstone'
const ARCHIVE_LIMIT = 200 * 1024 * 1024
const DOWNLOAD_TIMEOUT = 5 * 60_000
const VERSION_TIMEOUT = 8000

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

export interface MinecraftPluginPaths {
  pluginDir: string
  skillsDir: string
  agentDir: string
  runtime: string
  tempDir: string
}

export interface MinecraftInstallDeps {
  fetch: FetchLike
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

async function installedVersion(pluginDir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : undefined
  } catch {
    return undefined
  }
}

export async function latestMinecraftPluginVersion(request: FetchLike): Promise<string | undefined> {
  try {
    const response = await request(MINECRAFT_PLUGIN_LATEST, { signal: AbortSignal.timeout(VERSION_TIMEOUT), headers: { accept: 'application/vnd.github+json' } })
    if (!response.ok) return undefined
    const body = JSON.parse(await response.text()) as { tag_name?: unknown }
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : ''
    return /^v?\d[\w.+-]*$/.test(tag) ? tag.replace(/^v/, '') : undefined
  } catch {
    return undefined
  }
}

export async function refreshMinecraftPlugin(paths: MinecraftPluginPaths): Promise<'updated' | 'current' | 'skipped' | MinecraftPluginResult> {
  if (!existsSync(serverScript(paths.pluginDir))) return 'skipped'
  const { path, document } = await readMcp(paths.agentDir).catch(() => ({ path: join(paths.agentDir, 'mcp.json'), document: undefined as McpDocument | undefined }))
  const entry = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
  if (!isOurs(entry, paths.pluginDir)) return 'skipped'
  if ((entry as { command?: unknown }).command === paths.runtime) return 'current'
  try {
    const servers = { ...(document?.mcpServers ?? {}) }
    servers[MINECRAFT_PLUGIN_ID] = { ...(entry as Record<string, unknown>), command: paths.runtime }
    await writeMcp(path, { ...(document ?? {}), mcpServers: servers })
    return 'updated'
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
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
    installed: existsSync(serverScript(paths.pluginDir)),
    configured,
    conflict,
    skill: existsSync(join(paths.skillsDir, MINECRAFT_SKILL, 'SKILL.md')),
    pluginDir: paths.pluginDir,
    installedVersion: await installedVersion(paths.pluginDir)
  }
}

async function skillIsOurs(paths: MinecraftPluginPaths): Promise<boolean> {
  const target = join(paths.skillsDir, MINECRAFT_SKILL)
  if (!existsSync(target)) return true
  if (existsSync(join(target, SKILL_STAMP))) return true
  const installed = await readFile(join(target, 'SKILL.md'), 'utf8').catch(() => null)
  const shipped = await readFile(join(paths.pluginDir, 'skills', MINECRAFT_SKILL, 'SKILL.md'), 'utf8').catch(() => null)
  return installed !== null && installed === shipped
}

function systemTar(): string {
  if (process.platform !== 'win32') return 'tar'
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
}

function extractArchive(archive: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(systemTar(), ['-xf', archive, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`解压失败（${code}）：${stderr.trim()}`))))
  })
}

async function downloadArchive(request: FetchLike, url: string, target: string): Promise<void> {
  const response = await request(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
  if (!response.ok || !response.body) throw new Error(`下载插件失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > ARCHIVE_LIMIT) throw new Error(`插件包超过 ${Math.round(ARCHIVE_LIMIT / 1024 / 1024)} MB，已停止下载`)
  let received = 0
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      received += chunk.byteLength
      if (received > ARCHIVE_LIMIT) controller.error(new Error(`插件包超过 ${Math.round(ARCHIVE_LIMIT / 1024 / 1024)} MB，已停止下载`))
      else controller.enqueue(chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counting) as import('node:stream/web').ReadableStream), createWriteStream(target))
  if (!received) throw new Error('下载的插件包是空的')
}

async function contentRoot(dir: string): Promise<string> {
  const entries = await readdir(dir)
  if (entries.length === 1) {
    const single = join(dir, entries[0])
    if (existsSync(join(single, 'package.json'))) return single
  }
  return dir
}

export async function installMinecraftPlugin(paths: MinecraftPluginPaths, deps: MinecraftInstallDeps): Promise<MinecraftPluginResult> {
  let work: string | null = null
  try {
    const { path, document } = await readMcp(paths.agentDir)
    const current = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
    if (current !== undefined && !isOurs(current, paths.pluginDir)) {
      return { ok: false, error: `${path} 里已有同名服务「${MINECRAFT_PLUGIN_ID}」，不是砚装的，未改动`, status: await minecraftPluginStatus(paths) }
    }
    const skillTarget = join(paths.skillsDir, MINECRAFT_SKILL)
    if (!(await skillIsOurs(paths))) {
      return { ok: false, error: `${skillTarget} 里已有同名技能，不是砚装的，未改动`, status: await minecraftPluginStatus(paths) }
    }
    work = join(paths.tempDir, `minecraft-plugin-${randomBytes(4).toString('hex')}`)
    await mkdir(work, { recursive: true })
    const archive = join(work, 'inkstone-minecraft-plugin.zip')
    await downloadArchive(deps.fetch, MINECRAFT_PLUGIN_ARCHIVE, archive)
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked)
    await extractArchive(archive, unpacked)
    const source = await contentRoot(unpacked)
    if (!existsSync(serverScript(source)) || !existsSync(join(source, 'package.json'))) throw new Error('下载的插件包里没有插件文件，未改动')
    const staging = `${paths.pluginDir}.${randomBytes(4).toString('hex')}.new`
    try {
      for (const part of PLUGIN_PARTS) {
        const from = join(source, part)
        if (existsSync(from)) await cp(from, join(staging, part), { recursive: true, filter: (item) => copiesIntoPlugin(source, item) })
      }
      await mkdir(join(paths.pluginDir, '..'), { recursive: true })
      const previous = `${paths.pluginDir}.${randomBytes(4).toString('hex')}.old`
      const hadPrevious = existsSync(paths.pluginDir)
      if (hadPrevious) await rename(paths.pluginDir, previous)
      try {
        await rename(staging, paths.pluginDir)
      } catch (error) {
        if (hadPrevious) await rename(previous, paths.pluginDir).catch(() => undefined)
        throw error
      }
      if (hadPrevious) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
    await installSkill(paths)
    const enabled = current && typeof current === 'object' && (current as { enabled?: unknown }).enabled === false ? { enabled: false } : {}
    await writeMcp(path, { ...(document ?? {}), mcpServers: { ...(document?.mcpServers ?? {}), [MINECRAFT_PLUGIN_ID]: { ...minecraftMcpServer(paths), ...enabled } } })
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function installSkill(paths: MinecraftPluginPaths): Promise<void> {
  const from = join(paths.pluginDir, 'skills', MINECRAFT_SKILL)
  if (!existsSync(from)) return
  const target = join(paths.skillsDir, MINECRAFT_SKILL)
  const staging = `${target}.${randomBytes(4).toString('hex')}.new`
  try {
    await cp(from, staging, { recursive: true })
    await writeFile(join(staging, SKILL_STAMP), '', 'utf8')
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
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
    if (await skillIsOurs(paths)) await rm(join(paths.skillsDir, MINECRAFT_SKILL), { recursive: true, force: true })
    await rm(paths.pluginDir, { recursive: true, force: true })
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  }
}
