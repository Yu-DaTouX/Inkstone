import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { configurePackageContext, listPackages, runPackageAction } from '../packages'
import { trustStatus } from '../project-trust'
import { resolvePi } from '../protocol'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import { searchPiPackages, exportHermesPlugin, HERMES_PLUGIN_FILES, addCodegraphMcp, codegraphStatus, indexCodegraphProject } from '../plugin-market'
import { loadPluginCatalog } from '../plugin-catalog'
import { installMinecraftPlugin, minecraftPluginStatus, removeMinecraftPlugin, type MinecraftPluginPaths } from '../minecraft-plugin'
import { app, dialog } from 'electron'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'

const ANTHROPIC_OVERRIDE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

export interface PackagesIpcDeps {
  hasBusyCwd(cwd: string): boolean
}

async function bundledIntegration(name: string, marker: string): Promise<string | null> {
  const candidates = [join(process.resourcesPath, 'integrations', name), join(app.getAppPath(), 'integrations', name), resolve(import.meta.dirname, '../../integrations', name)]
  for (const candidate of candidates) {
    if (await access(join(candidate, marker)).then(() => true, () => false)) return candidate
  }
  return null
}

async function minecraftPaths(): Promise<MinecraftPluginPaths> {
  return {
    source: await bundledIntegration('inkstone-minecraft', join('mcp', 'server.ts')),
    pluginDir: join(YAN_DIR, 'plugins', 'inkstone-minecraft'),
    skillsDir: join(YAN_DIR, 'skills'),
    agentDir: PI_AGENT_DIR,
    runtime: process.execPath
  }
}

export function registerPackagesIpc(ipc: IpcRegistrar, deps: PackagesIpcDeps): void {
  const { handle } = ipc
  const { hasBusyCwd } = deps
  handle('yan:packages:search', async (query: unknown, offset: unknown) => {
    if (typeof query !== 'string' || (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset)))) {
      return { ok: false, entries: [], total: 0, error: '无效的搜索参数' }
    }
    return searchPiPackages(query.slice(0, 500), typeof offset === 'number' ? Math.max(0, Math.floor(offset)) : 0)
  })
  handle('yan:packages:catalog', async (refresh: unknown) => loadPluginCatalog(refresh === true))
  handle('yan:packages:exportPlugin', async (id: unknown) => {
    if (id !== 'hermes-inkstone') return { ok: false, error: '未知插件' }
    try {
      const files = HERMES_PLUGIN_FILES
      const candidates = [join(process.resourcesPath, 'integrations', 'hermes-inkstone'),
        join(app.getAppPath(), 'integrations', 'hermes-inkstone'), resolve(import.meta.dirname, '../../integrations/hermes-inkstone')]
      let source: string | undefined
      for (const candidate of candidates) {
        if (await Promise.all(files.map(file => access(join(candidate, file)))).then(() => true, () => false)) { source = candidate; break }
      }
      if (!source) return { ok: false, error: '随包插件文件缺失，请更新砚' }
      const selected = await dialog.showOpenDialog({ title: '导出 Hermes 插件：选择父目录', properties: ['openDirectory', 'createDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true }
      const target = await exportHermesPlugin(source, selected.filePaths[0])
      return { ok: true, path: target }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  handle('yan:packages:addMcp', async (id: unknown) => {
    if (id !== 'codegraph') return { ok: false, error: '未知插件' }
    try { return await addCodegraphMcp(PI_AGENT_DIR) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })

  handle('yan:packages:minecraft', async (action: unknown) => {
    const paths = await minecraftPaths()
    if (action === 'install') return installMinecraftPlugin(paths)
    if (action === 'remove') return removeMinecraftPlugin(paths)
    return { ok: true, status: await minecraftPluginStatus(paths) }
  })

  handle('yan:packages:codegraphStatus', async (cwd: unknown) =>
    codegraphStatus(PI_AGENT_DIR, typeof cwd === 'string' ? cwd : ''))

  handle('yan:packages:codegraphIndex', async (cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, error: '没有打开的项目' }
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
      if (!kind) return { ok: false, error: '未知的操作' }
      const st = await getSettings()
      configurePackageContext({
        bin: () => resolvePi(st.piBin ? { override: st.piBin } : {}).args.at(-1) ?? null,
        agentDir: () => PI_AGENT_DIR,
        hasRunningTask: hasBusyCwd,
        isProjectTrusted: async (projectCwd) => (await trustStatus(projectCwd)).trusted
      })
      return await runPackageAction({
        kind,
        source: String(raw.source ?? ''),
        local: raw.local === true,
        cwd: String(raw.cwd ?? '')
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
