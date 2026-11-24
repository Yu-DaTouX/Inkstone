import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { configurePackageContext, listPackages, runPackageAction, type PackageActionRequest, type PackageActionResult } from '../packages'
import { trustStatus } from '../project-trust'
import { resolvePi } from '../protocol'
import { smokeInstalledPiPackage } from '../capabilities/pi-package-smoke'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import { searchPiPackages, exportHermesPlugin, HERMES_PLUGIN_FILES, addCodegraphMcp, codegraphStatus, indexCodegraphProject } from '../plugin-market'
import { loadPluginCatalog } from '../plugin-catalog'
import { compareMinecraftVersions, installMinecraftPlugin, latestMinecraftPlugin, minecraftReleaseKey, minecraftPluginStatus, refreshMinecraftPlugin, removeMinecraftPlugin, setMinecraftDevEnabled, type FetchLike, type MinecraftPluginPaths } from '../minecraft-plugin'
import { ensureNodeLauncher, nodeLauncherPath } from '../yan-cli'
import type { MinecraftPluginResult, MinecraftPluginStatus } from '../../shared/plugin-market'
import { app, dialog, net } from 'electron'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { pick } from '../../shared/ui-lang'
import { serializedWrite } from '../mcp/write-queue'

const ANTHROPIC_OVERRIDE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

export interface PackagesIpcDeps {
  hasBusyCwd(cwd: string): boolean
  hasAnyBusy?(): boolean
  isKnownProject?(cwd: string): boolean
}

async function minecraftPaths(): Promise<MinecraftPluginPaths> {
  const binDir = join(YAN_DIR, 'bin')
  return {
    pluginDir: join(YAN_DIR, 'plugins', 'inkstone-minecraft'),
    skillsDir: join(YAN_DIR, 'skills'),
    agentDir: PI_AGENT_DIR,
    runtime: nodeLauncherPath(binDir),
    tempDir: join(YAN_DIR, 'tmp'),
    prepareRuntime: () => void ensureNodeLauncher({ execPath: process.execPath, binDir })
  }
}

const pluginFetch: FetchLike = (url, init) => net.fetch(url, init)

async function checkMinecraftUpdate(status: MinecraftPluginStatus): Promise<MinecraftPluginResult> {
  try {
    const pin = await latestMinecraftPlugin(pluginFetch)
    return { ok: true, status: { ...status, latestVersion: pin.version, releaseKey: minecraftReleaseKey(pin), updateAvailable: status.installed && !!status.installedVersion && compareMinecraftVersions(pin.version, status.installedVersion) > 0 } }
  } catch (error) {
    return { ok: false, status, error: error instanceof Error ? error.message : String(error) }
  }
}

let minecraftQueue: Promise<unknown> = Promise.resolve()

function queueMinecraft<T>(task: () => Promise<T>): Promise<T> {
  const next = minecraftQueue.then(() => serializedWrite(task))
  minecraftQueue = next.catch(() => undefined)
  return next
}

export function refreshMinecraftPluginOnStartup(): void {
  void queueMinecraft(async () => {
    const result = await refreshMinecraftPlugin(await minecraftPaths())
    if (result === 'updated') console.log('[minecraft-plugin] mcp.json \u5df2\u6539\u4e3a\u6307\u5411\u7a33\u5b9a\u542f\u52a8\u5165\u53e3')
    else if (typeof result === 'object') console.warn('[minecraft-plugin] \u6539\u5199\u5931\u8d25', result.error)
  }).catch((error) => console.warn('[minecraft-plugin] \u542f\u52a8\u68c0\u67e5\u5931\u8d25', error))
}

export async function runPiPackageAction(request: PackageActionRequest, deps: PackagesIpcDeps): Promise<PackageActionResult> {
  const { hasBusyCwd, hasAnyBusy, isKnownProject } = deps
  const st = await getSettings()
  const piBin = resolvePi(st.piBin ? { override: st.piBin } : {}).args.at(-1) ?? null
  configurePackageContext({
    bin: () => piBin,
    agentDir: () => PI_AGENT_DIR,
    hasRunningTask: hasBusyCwd,
    ...(hasAnyBusy ? { hasAnyRunningTask: hasAnyBusy } : {}),
    smoke: (packageDir) => smokeInstalledPiPackage({ packageRoot: packageDir, ...(piBin ? { piBin } : {}) }),
    isKnownProject,
    isProjectTrusted: async (projectCwd) => (await trustStatus(projectCwd)).trusted
  })
  return runPackageAction(request)
}

export async function minecraftPluginInstalled(): Promise<boolean> {
  return (await minecraftPluginStatus(await minecraftPaths())).installed === true
}

export async function minecraftPluginAction(action: 'install' | 'remove', isBusy: () => boolean): Promise<MinecraftPluginResult> {
  const paths = await minecraftPaths()
  if (action === 'remove') return queueMinecraft(() => isBusy()
    ? Promise.resolve({ ok: false, error: pick('请等待当前任务结束再修改 Minecraft 插件', 'Wait for running tasks before changing the Minecraft plugin') })
    : removeMinecraftPlugin(paths))
  const checked = await checkMinecraftUpdate(await minecraftPluginStatus(paths))
  const expectedRelease = checked.status?.releaseKey
  if (!checked.ok || !expectedRelease) return checked
  return queueMinecraft(async () => {
    if (isBusy()) return { ok: false, error: pick('请等待当前任务结束再更新 Minecraft 插件', 'Wait for running tasks before updating the Minecraft plugin') }
    return installMinecraftPlugin(paths, { fetch: pluginFetch, expectedRelease, keepDev: checked.status?.devEnabled === true })
  })
}

export function registerPackagesIpc(ipc: IpcRegistrar, deps: PackagesIpcDeps): void {
  const { handle } = ipc
  const { hasAnyBusy } = deps
  handle('yan:packages:search', async (query: unknown, offset: unknown) => {
    if (typeof query !== 'string' || (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset)))) {
      return { ok: false, entries: [], total: 0, error: pick('无效的搜索参数', 'Invalid search parameters') }
    }
    return searchPiPackages(query.slice(0, 500), typeof offset === 'number' ? Math.max(0, Math.floor(offset)) : 0)
  })
  handle('yan:packages:catalog', async (refresh: unknown) => loadPluginCatalog(refresh === true))
  handle('yan:packages:exportPlugin', async (id: unknown) => {
    if (id !== 'hermes-inkstone') return { ok: false, error: pick('未知插件', 'Unknown plugin') }
    try {
      const files = HERMES_PLUGIN_FILES
      const candidates = [join(process.resourcesPath, 'integrations', 'hermes-inkstone'),
        join(app.getAppPath(), 'integrations', 'hermes-inkstone'), resolve(import.meta.dirname, '../../integrations/hermes-inkstone')]
      let source: string | undefined
      for (const candidate of candidates) {
        if (await Promise.all(files.map(file => access(join(candidate, file)))).then(() => true, () => false)) { source = candidate; break }
      }
      if (!source) return { ok: false, error: pick('随包插件文件缺失，请更新砚', 'Bundled plugin files are missing; update Inkstone') }
      const selected = await dialog.showOpenDialog({ title: pick('导出 Hermes 插件：选择父目录', 'Export Hermes plugin: choose a parent folder'), properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true }
      const target = await exportHermesPlugin(source, selected.filePaths[0])
      return { ok: true, path: target }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  handle('yan:packages:addMcp', async (id: unknown) => {
    if (id !== 'codegraph') return { ok: false, error: pick('未知插件', 'Unknown plugin') }
    try { return await addCodegraphMcp(PI_AGENT_DIR) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  handle('yan:packages:minecraft', async (action: unknown, expectedRelease: unknown, keepDev: unknown) => {
    const paths = await minecraftPaths()
    if (action === 'status') return checkMinecraftUpdate(await minecraftPluginStatus(paths))
    if (action === 'remove' || action === 'enable-dev' || action === 'disable-dev') return queueMinecraft(() => {
      if (hasAnyBusy?.()) return Promise.resolve({ ok: false, error: pick('请等待当前任务结束再修改 Minecraft 插件', 'Wait for running tasks before changing the Minecraft plugin') })
      return action === 'remove' ? removeMinecraftPlugin(paths) : setMinecraftDevEnabled(paths, action === 'enable-dev')
    })
    if (action !== 'install' || typeof expectedRelease !== 'string' || expectedRelease.length > 120) {
      return { ok: false, error: pick('请先检查并确认 Minecraft 插件版本', 'Check and confirm the Minecraft plugin version first') }
    }
    return queueMinecraft(async () => {
      if (hasAnyBusy?.()) return { ok: false, error: pick('请等待当前任务结束再更新 Minecraft 插件', 'Wait for running tasks before updating the Minecraft plugin') }
      const result = await installMinecraftPlugin(paths, { fetch: pluginFetch, expectedRelease, keepDev: keepDev === true })
      if (!result.ok || !result.status) return result
      return { ...result, status: { ...result.status, latestVersion: result.status.installedVersion } }
    })
  })

  handle('yan:packages:codegraphStatus', async (cwd: unknown) =>
    codegraphStatus(PI_AGENT_DIR, typeof cwd === 'string' ? cwd : ''))

  handle('yan:packages:codegraphIndex', async (cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: pick('没有打开的项目', 'No project open') }
    try { return await indexCodegraphProject(cwd) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  handle('yan:packages:anthropicEnv', async () =>
    ANTHROPIC_OVERRIDE_ENV.filter((name) => (process.env[name] ?? '').trim().length > 0))

  handle('yan:packages:list', async (cwd: string) => {
    try {
      return listPackages(String(cwd ?? ''))
    } catch (error) {
      return { ok: false, agentDir: '', userSettings: '', projectSettings: '', entries: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('yan:packages:action', async (req: unknown) => {
    const raw = (req ?? {}) as Record<string, unknown>
    try {
      const kind = raw.kind === 'install' || raw.kind === 'remove' || raw.kind === 'update' ? raw.kind : null
      if (!kind) return { ok: false, error: pick('未知的操作', 'Unknown action') }
      return await runPiPackageAction({
        kind,
        source: String(raw.source ?? ''),
        local: raw.local === true,
        cwd: String(raw.cwd ?? ''),
        allowLifecycleScripts: raw.allowLifecycleScripts === true
      }, deps)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
