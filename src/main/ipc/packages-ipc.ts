/**
 * pi 插件包管理的 IPC 适配（`yan:packages:*`）。
 */
import type { IpcRegistrar } from './registrar'
import { getSettings } from '../settings'
import { configurePackageContext, listPackages, runPackageAction } from '../packages'
import { trustStatus } from '../project-trust'
import { resolvePi } from '../protocol'
import { PI_AGENT_DIR } from '../paths'
import { searchPiPackages, exportHermesPlugin, HERMES_PLUGIN_FILES } from '../plugin-market'
import { app, dialog } from 'electron'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'

export interface PackagesIpcDeps {
  /** 这个项目目录有没有正在跑的任务（有任务时拒绝改包集合） */
  hasBusyCwd(cwd: string): boolean
}

export function registerPackagesIpc(ipc: IpcRegistrar, deps: PackagesIpcDeps): void {
  const { handle } = ipc
  const { hasBusyCwd } = deps
  handle('yan:packages:search', async (query: unknown, offset: unknown) => {
    if (typeof query !== 'string' || (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset)))) {
      return { ok: false, entries: [], total: 0, error: '无效的搜索参数' }
    }
    return searchPiPackages(query, typeof offset === 'number' ? offset : 0)
  })
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
  /*
   * pi 插件包管理（§9 的 P2）。
   *
   * 注入两样东西（都只有这里才拿得到）：
   *   · **bin** —— 必须走 resolvePi()，用户可能用设置项 piBin 覆盖或用系统安装。
   *     自己拼内置路径会出现「装到 A、跑的是 B」这种最难查的问题。
   *   · **hasRunningTask** —— 扩展是 pi 启动时加载的，正在跑的回合与磁盘上的
   *     包集合必须一致，所以有任务时直接拒绝。
   */

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
      /*
       * 这里注入 bin：它是**异步**才知道的（settings 的 piBin 覆盖项），
       * 而 resolvePi() 必须与真正启动 pi 时是同一个解析 —— 否则会出现
       * 「装到 A、跑的是 B」这种最难查的问题。
       */
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
