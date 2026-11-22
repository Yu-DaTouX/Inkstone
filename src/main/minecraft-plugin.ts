import { pick } from '../shared/ui-lang'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../shared/plugin-market'

export const MINECRAFT_PLUGIN_ID = 'inkstone-minecraft'
export const MINECRAFT_DEV_ID = 'inkstone-minecraft-dev'
export const MINECRAFT_SKILL = 'inkstone-fabric-dev'
export const MINECRAFT_PLUGIN_REPO = 'Yu-DaTouX/inkstone-minecraft-plugin'

export interface MinecraftPluginPin {
  version: string
  sha256: string
  size: number
}

export const MINECRAFT_PLUGIN_PIN: MinecraftPluginPin = {
  version: '0.1.1',
  sha256: '09b1caa5b07442884ddab2578a4c025089af6a8b863d9634d1eeb8cfd043a9f4',
  size: 1_392_640
}

const versionPattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function compareMinecraftVersions(a: string, b: string): number {
  if (!versionPattern.test(a) || !versionPattern.test(b)) return NaN
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

export function minecraftReleaseKey(pin: MinecraftPluginPin): string {
  return `${pin.version}:${pin.sha256}:${pin.size}`
}

export async function latestMinecraftPlugin(request: FetchLike): Promise<MinecraftPluginPin> {
  const url = `https://api.github.com/repos/${MINECRAFT_PLUGIN_REPO}/releases/latest`
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok || !response.body) throw new Error(pick(`检查 Minecraft 插件更新失败：HTTP ${response.status}`, `Minecraft plugin update check failed: HTTP ${response.status}`))
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 1024 * 1024) {
      await reader.cancel()
      throw new Error(pick('插件发布信息过大', 'Plugin release metadata is too large'))
    }
    chunks.push(value)
  }
  const release = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const version = typeof release?.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : ''
  const assets = Array.isArray(release?.assets) ? release.assets.filter((asset: { name?: string } | null) => asset?.name === 'inkstone-minecraft-plugin.zip') : []
  const asset = assets[0]
  const digest = typeof asset?.digest === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(asset.digest) : null
  if (!versionPattern.test(version) || release.draft !== false || release.prerelease !== false || compareMinecraftVersions(version, MINECRAFT_PLUGIN_PIN.version) < 0 || assets.length !== 1 || asset.state !== 'uploaded' || !digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > ARCHIVE_LIMIT || asset.browser_download_url !== minecraftArchiveUrl(version)) {
    throw new Error(pick('官方发布缺少有效的稳定版插件附件或校验信息', 'The official release lacks a valid stable plugin asset or checksum'))
  }
  const pin = { version, sha256: digest[1], size: asset.size }
  if (version === MINECRAFT_PLUGIN_PIN.version && minecraftReleaseKey(pin) !== minecraftReleaseKey(MINECRAFT_PLUGIN_PIN)) throw new Error(archiveDigestMismatch())
  return pin
}

export function minecraftArchiveUrl(version: string): string {
  return `https://github.com/${MINECRAFT_PLUGIN_REPO}/releases/download/v${version}/inkstone-minecraft-plugin.zip`
}

export const MINECRAFT_PLUGIN_ARCHIVE = minecraftArchiveUrl(MINECRAFT_PLUGIN_PIN.version)
const PLUGIN_PARTS = ['package.json', 'mcp', 'src', 'skills', 'templates', 'companion-mod']
const SKIPPED_DIRS = new Set(['.gradle', 'run', '.inkstone', 'node_modules', 'out'])
const SKILL_STAMP = '.installed-by-inkstone'
const ARCHIVE_LIMIT = 200 * 1024 * 1024
const DOWNLOAD_TIMEOUT = 5 * 60_000

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: 'error' }) => Promise<Response>

export interface MinecraftPluginPaths {
  pluginDir: string
  skillsDir: string
  agentDir: string
  runtime: string
  tempDir: string
  prepareRuntime?: () => void
}

export interface MinecraftInstallDeps {
  fetch: FetchLike
  pin?: MinecraftPluginPin
  expectedRelease?: string
  keepDev?: boolean
}

type McpDocument = { mcpServers?: Record<string, unknown> } & Record<string, unknown>

function serverScript(pluginDir: string): string {
  return join(pluginDir, 'mcp', 'server.ts')
}

function devScript(pluginDir: string): string {
  return join(pluginDir, 'mcp', 'dev-server.ts')
}

export function minecraftMcpServer(paths: Pick<MinecraftPluginPaths, 'pluginDir' | 'runtime'>, dev = false): Record<string, unknown> {
  return { command: paths.runtime, args: ['--no-warnings', (dev ? devScript : serverScript)(paths.pluginDir)], env: { ELECTRON_RUN_AS_NODE: '1' } }
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

async function readPluginVersion(pluginDir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : undefined
  } catch {
    return undefined
  }
}

export async function refreshMinecraftPlugin(paths: MinecraftPluginPaths): Promise<'updated' | 'current' | 'skipped' | MinecraftPluginResult> {
  if (!existsSync(serverScript(paths.pluginDir))) return 'skipped'
  const { path, document } = await readMcp(paths.agentDir).catch(() => ({ path: join(paths.agentDir, 'mcp.json'), document: undefined as McpDocument | undefined }))
  const servers = { ...(document?.mcpServers ?? {}) }
  const owned = [MINECRAFT_PLUGIN_ID, MINECRAFT_DEV_ID].filter(name => isOurs(servers[name], paths.pluginDir, name === MINECRAFT_DEV_ID))
  if (!owned.length) return 'skipped'
  try {
    paths.prepareRuntime?.()
    let changed = false
    for (const name of owned) {
      const entry = servers[name] as Record<string, unknown>
      if (sameEntry(entry.command, paths.runtime)) continue
      servers[name] = { ...entry, command: paths.runtime }
      changed = true
    }
    if (!changed) return 'current'
    await writeMcp(path, { ...(document ?? {}), mcpServers: servers })
    return 'updated'
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function sameEntry(command: unknown, runtime: string): boolean {
  if (typeof command !== 'string') return false
  if (process.platform !== 'win32') return command === runtime
  const normal = (value: string): string => value.replace(/\\/g, '/').toLowerCase()
  return normal(command) === normal(runtime)
}

function isOurs(entry: unknown, pluginDir: string, dev = false): boolean {
  if (!entry || typeof entry !== 'object') return false
  const args = (entry as { args?: unknown }).args
  return Array.isArray(args) && args.some((arg) => sameEntry(arg, (dev ? devScript : serverScript)(pluginDir)))
}

export function isInstalledMinecraftService(name: string, entry: unknown, pluginDir: string): boolean {
  const dev = name === MINECRAFT_DEV_ID
  return (dev || name === MINECRAFT_PLUGIN_ID) && isOurs(entry, pluginDir, dev) && existsSync((dev ? devScript : serverScript)(pluginDir))
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
    throw new Error(pick(`${path} 不是合法 JSON，未改动`, `${path} is not valid JSON; left unchanged`))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(pick(`${path} 顶层必须是 JSON 对象，未改动`, `${path} must be a JSON object at the top level; left unchanged`))
  const servers = (parsed as McpDocument).mcpServers
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) throw new Error(pick(`${path} 里的 mcpServers 必须是对象，未改动`, `mcpServers in ${path} must be an object; left unchanged`))
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
  let registered = false
  let conflict = false
  let devEnabled = false
  let devConflict = false
  const split = existsSync(devScript(paths.pluginDir))
  try {
    const { document } = await readMcp(paths.agentDir)
    const entry = document?.mcpServers?.[MINECRAFT_PLUGIN_ID]
    if (entry !== undefined) {
      conflict = !isOurs(entry, paths.pluginDir)
      registered = !conflict
      configured = registered && (entry as { enabled?: unknown }).enabled !== false
    }
    const dev = document?.mcpServers?.[MINECRAFT_DEV_ID]
    if (split && dev !== undefined) {
      devConflict = !isOurs(dev, paths.pluginDir, true)
      devEnabled = !devConflict && (dev as { enabled?: unknown }).enabled !== false
    }
  } catch {
  }
  return {
    installed: existsSync(serverScript(paths.pluginDir)),
    configured,
    registered,
    conflict,
    split, devEnabled, devConflict,
    skill: existsSync(join(paths.skillsDir, MINECRAFT_SKILL, 'SKILL.md')),
    pluginDir: paths.pluginDir,
    installedVersion: await readPluginVersion(paths.pluginDir)
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
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(pick(`解压失败（${code}）：${stderr.trim()}`, `Extraction failed (${code}): ${stderr.trim()}`)))))
  })
}

async function downloadArchive(request: FetchLike, url: string, target: string, pin: MinecraftPluginPin): Promise<void> {
  const response = await request(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
  if (!response.ok || !response.body) throw new Error(pick(`下载插件失败：HTTP ${response.status}`, `Plugin download failed: HTTP ${response.status}`))
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > 0 && (declared > ARCHIVE_LIMIT || declared !== pin.size)) throw new Error(archiveSizeMismatch())
  const hash = createHash('sha256')
  let received = 0
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      received += chunk.byteLength
      if (received > ARCHIVE_LIMIT) controller.error(new Error(archiveTooLarge()))
      else if (received > pin.size) controller.error(new Error(archiveSizeMismatch()))
      else {
        hash.update(chunk)
        controller.enqueue(chunk)
      }
    }
  })
  await pipeline(Readable.fromWeb(response.body.pipeThrough(counting) as import('node:stream/web').ReadableStream), createWriteStream(target))
  if (!received) throw new Error(pick('下载的插件包是空的', 'The downloaded plugin package is empty'))
  if (received !== pin.size) throw new Error(archiveSizeMismatch())
  if (hash.digest('hex') !== pin.sha256.toLowerCase()) throw new Error(archiveDigestMismatch())
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
      return { ok: false, error: pick(`${path} 里已有同名服务「${MINECRAFT_PLUGIN_ID}」，不是砚装的，未改动`, `${path} already has a server named "${MINECRAFT_PLUGIN_ID}" not installed by Inkstone; left unchanged`), status: await minecraftPluginStatus(paths) }
    }
    const skillTarget = join(paths.skillsDir, MINECRAFT_SKILL)
    if (!(await skillIsOurs(paths))) {
      return { ok: false, error: pick(`${skillTarget} 里已有同名技能，不是砚装的，未改动`, `${skillTarget} already has a skill with the same name not installed by Inkstone; left unchanged`), status: await minecraftPluginStatus(paths) }
    }
    const pin = deps.pin ?? await latestMinecraftPlugin(deps.fetch)
    if (!deps.pin && minecraftReleaseKey(pin) !== deps.expectedRelease) throw new Error(pick('插件发布已变化，请重新检查并确认', 'The plugin release changed; check and confirm again'))
    const installed = await readPluginVersion(paths.pluginDir)
    if (installed && versionPattern.test(installed) && compareMinecraftVersions(pin.version, installed) < 0) throw new Error(pick('拒绝降级 Minecraft 插件', 'Refusing to downgrade the Minecraft plugin'))
    paths.prepareRuntime?.()
    work = join(paths.tempDir, `minecraft-plugin-${randomBytes(4).toString('hex')}`)
    await mkdir(work, { recursive: true })
    const archive = join(work, 'inkstone-minecraft-plugin.zip')
    await downloadArchive(deps.fetch, minecraftArchiveUrl(pin.version), archive, pin)
    const unpacked = join(work, 'unpacked')
    await mkdir(unpacked)
    await extractArchive(archive, unpacked)
    const source = await contentRoot(unpacked)
    if (!existsSync(serverScript(source)) || await readPluginVersion(source) !== pin.version) throw new Error(pick('插件包缺少入口或版本不匹配，未改动', 'Plugin entry point is missing or the package version does not match; left unchanged'))
    const nonce = randomBytes(6).toString('hex')
    const dirSwap = (target: string) => ({ target, staging: `${target}.${nonce}.new`, previous: `${target}.${nonce}.old`, backedUp: false, installed: false })
    const plugin = dirSwap(paths.pluginDir)
    const skill = dirSwap(skillTarget)
    const staged = [plugin, skill]
    try {
      for (const part of PLUGIN_PARTS) {
        const from = join(source, part)
        if (existsSync(from)) await cp(from, join(plugin.staging, part), { recursive: true, filter: (item) => copiesIntoPlugin(source, item) })
      }
      const shippedSkill = join(plugin.staging, 'skills', MINECRAFT_SKILL)
      if (!existsSync(join(shippedSkill, 'SKILL.md'))) throw new Error(pick('插件包缺少开发技能，未改动', 'Plugin is missing its development skill; left unchanged'))
      const fresh = (await readMcp(paths.agentDir)).document
      const servers = { ...fresh?.mcpServers }
      const entry = servers[MINECRAFT_PLUGIN_ID] as { env?: Record<string, unknown>; description?: unknown } | undefined
      const existingDev = servers[MINECRAFT_DEV_ID] as { env?: Record<string, unknown>; enabled?: boolean } | undefined
      const split = existsSync(devScript(plugin.staging))
      const ownedDev = isOurs(existingDev, paths.pluginDir, true)
      const migrate = split && entry !== undefined && !existsSync(devScript(paths.pluginDir))
      const enableDev = split && (ownedDev ? existingDev?.enabled !== false : migrate && deps.keepDev === true && (entry as { enabled?: boolean } | undefined)?.enabled !== false)
      if ((entry !== undefined && !isOurs(entry, paths.pluginDir)) || !(await skillIsOurs(paths)) || (enableDev && existingDev !== undefined && !ownedDev)) {
        throw new Error(pick('安装期间插件配置发生冲突，未改动', 'Plugin configuration conflicted during installation; left unchanged'))
      }
      if (!split || enableDev) {
        await cp(shippedSkill, skill.staging, { recursive: true })
        await writeFile(join(skill.staging, SKILL_STAMP), '', 'utf8')
      }
      if (split && (ownedDev || (migrate && existingDev === undefined))) {
        const dev = minecraftMcpServer(paths, true)
        servers[MINECRAFT_DEV_ID] = { ...existingDev, ...dev, env: { ...(migrate ? entry?.env : existingDev?.env), ELECTRON_RUN_AS_NODE: '1' }, enabled: enableDev }
      }
      const next = { ...entry, ...minecraftMcpServer(paths), env: { ...entry?.env, ELECTRON_RUN_AS_NODE: '1' } }
      if (split && (migrate || !entry?.description)) Object.assign(next, { description: pick('Minecraft Java 1.21.1 离线建图：世界、方块状态、批量编辑、局部预览、存档 ZIP 和 3D 构件。不需要 Fabric 工程。', 'Minecraft Java 1.21.1 offline mapmaking: worlds, block states, batch edits, previews, save ZIPs, and 3D structures. No Fabric project required.') })
      servers[MINECRAFT_PLUGIN_ID] = next
      for (const swap of staged) {
        if (existsSync(swap.target)) {
          await rename(swap.target, swap.previous)
          swap.backedUp = true
        }
        if (existsSync(swap.staging)) {
          await rename(swap.staging, swap.target)
          swap.installed = true
        }
      }
      if (JSON.stringify(fresh?.mcpServers) !== JSON.stringify(servers)) await writeMcp(path, { ...fresh, mcpServers: servers })
    } catch (error) {
      const failed: string[] = []
      for (const swap of [...staged].reverse()) {
        try {
          if (swap.installed) await rename(swap.target, swap.staging)
          if (swap.backedUp) await rename(swap.previous, swap.target)
        } catch { failed.push(swap.previous) }
      }
      if (failed.length) throw new Error(`${String(error)}; ${pick('无法恢复，旧版备份位置', 'Rollback failed; old version backup')}: ${failed.join(', ')}`)
      throw error
    } finally {
      for (const swap of staged) await rm(swap.staging, { recursive: true, force: true }).catch(() => undefined)
    }
    for (const swap of staged) if (swap.backedUp) await rm(swap.previous, { recursive: true, force: true }).catch(() => undefined)
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function setMinecraftDevEnabled(paths: MinecraftPluginPaths, enabled: boolean): Promise<MinecraftPluginResult> {
  const target = join(paths.skillsDir, MINECRAFT_SKILL)
  const staging = `${target}.${randomBytes(6).toString('hex')}.new`
  const previous = `${staging}.old`
  let moved = false
  let copied = false
  try {
    if (!existsSync(devScript(paths.pluginDir))) throw new Error(pick('这个插件版本不支持单独开启 Fabric 开发工具', 'This plugin version has no separate Fabric development entry'))
    const { path, document } = await readMcp(paths.agentDir)
    const servers = { ...document?.mcpServers }
    const entry = servers[MINECRAFT_DEV_ID] as { env?: Record<string, unknown> } | undefined
    if ((entry !== undefined && !isOurs(entry, paths.pluginDir, true)) || !(await skillIsOurs(paths))) {
      throw new Error(pick('已有同名 Fabric 服务或技能，不是砚安装的，未修改', 'A Fabric service or skill with the same name is not owned by Inkstone; left unchanged'))
    }
    if (enabled) {
      const shipped = join(paths.pluginDir, 'skills', MINECRAFT_SKILL)
      if (!existsSync(join(shipped, 'SKILL.md'))) throw new Error(pick('插件缺少 Fabric 开发技能，请修复安装', 'Fabric development skill missing; repair the installation'))
      await mkdir(paths.skillsDir, { recursive: true })
      await cp(shipped, staging, { recursive: true })
      await writeFile(join(staging, SKILL_STAMP), '', 'utf8')
    }
    if (existsSync(target)) { await rename(target, previous); moved = true }
    if (enabled) { await rename(staging, target); copied = true }
    if (enabled || entry) {
      servers[MINECRAFT_DEV_ID] = { ...entry, ...minecraftMcpServer(paths, true), env: { ...entry?.env, ELECTRON_RUN_AS_NODE: '1' }, enabled }
      await writeMcp(path, { ...document, mcpServers: servers })
    }
  } catch (error) {
    try {
      if (copied) await rename(target, staging)
      if (moved) await rename(previous, target)
    } catch { return { ok: false, error: pick(`无法恢复 Fabric 技能，备份位置：${previous}`, `Could not restore Fabric skill. Backup: ${previous}`) } }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  if (moved) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
  return { ok: true, status: await minecraftPluginStatus(paths) }
}

export async function removeMinecraftPlugin(paths: MinecraftPluginPaths): Promise<MinecraftPluginResult> {
  try {
    const { path, document } = await readMcp(paths.agentDir)
    const servers = { ...document?.mcpServers }
    const owned = [MINECRAFT_PLUGIN_ID, MINECRAFT_DEV_ID].filter(name => isOurs(servers[name], paths.pluginDir, name === MINECRAFT_DEV_ID))
    for (const name of owned) delete servers[name]
    if (owned.length) await writeMcp(path, { ...document, mcpServers: servers })
    if (await skillIsOurs(paths)) await rm(join(paths.skillsDir, MINECRAFT_SKILL), { recursive: true, force: true })
    await rm(paths.pluginDir, { recursive: true, force: true })
    return { ok: true, path, status: await minecraftPluginStatus(paths) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: await minecraftPluginStatus(paths) }
  }
}

function archiveTooLarge(): string {
  const mb = Math.round(ARCHIVE_LIMIT / 1024 / 1024)
  return pick(`插件包超过 ${mb} MB，已停止下载`, `Plugin package exceeds ${mb} MB; download stopped`)
}

function archiveSizeMismatch(): string {
  return pick('下载的插件包大小与固定版本不一致，未解压', 'The downloaded plugin package does not match the pinned size; nothing was extracted')
}

function archiveDigestMismatch(): string {
  return pick('下载的插件包摘要与固定版本不一致，未解压', 'The downloaded plugin package does not match the pinned digest; nothing was extracted')
}
