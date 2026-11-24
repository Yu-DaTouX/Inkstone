import { basename } from 'node:path'
import type { AgentController } from './agent'
import type { RunnerRegistry } from './runners'
import type { AppSettings } from '../shared/ipc'
import type { InstallPlugin, InstallServices } from './agent-commands/install-command'
import { createMcpSettingsHost } from './mcp/settings-host'
import { changeMcpServiceSettings, listMcpServiceSettings } from './mcp/service-settings'
import { listPackages } from './packages'
import { minecraftPluginAction, minecraftPluginInstalled, runPiPackageAction } from './ipc/packages-ipc'
import { pluginText, type PluginCatalogView } from '../shared/plugin-catalog'
import { pick, uiLang } from '../shared/ui-lang'

export interface InstallServicesDeps {
  registry(): RunnerRegistry | null
  settings(): Promise<AppSettings>
  isProjectTrusted(cwd: string): Promise<boolean>
  isKnownProject(cwd: string): boolean
  catalog(): Promise<PluginCatalogView>
  bundledAction(id: string, action: 'status' | 'install' | 'remove'): Promise<{ ok: boolean; installed?: boolean; error?: string }>
  refresh(): void
}

const MINECRAFT = 'inkstone-minecraft'

export function installServicesFor(deps: InstallServicesDeps, agent: AgentController): InstallServices {
  const runner = (): { id: string; cwd: string } | null => deps.registry()?.runnerOf(agent) ?? null
  const target = () => ({ agent, runner: runner() })
  const host = () => createMcpSettingsHost({ registry: deps.registry, settings: deps.settings, isProjectTrusted: deps.isProjectTrusted }, target, agent)
  const othersBusy = (): boolean => deps.registry()?.hasPendingWorkExcept(runner()?.id) === true
  const catalogPlugins = async () => (await deps.catalog()).plugins.filter((entry) => entry.kind === 'bundled' || entry.id === MINECRAFT)
  return {
    project: async () => {
      const current = runner()
      const project = (await deps.settings()).projects.find((entry) => entry.id === agent.capabilityProjectId)
      if (!current || !project) return null
      return { name: project.name || basename(current.cwd), trusted: await deps.isProjectTrusted(current.cwd).catch(() => false) }
    },
    mcpServices: async () => listMcpServiceSettings(await host()),
    mcpChange: async (mutation) => changeMcpServiceSettings(await host(), mutation),
    plugins: async () => Promise.all((await catalogPlugins()).map(async (entry): Promise<InstallPlugin> => {
      const text = pluginText(entry, uiLang())
      const installed = entry.id === MINECRAFT
        ? await minecraftPluginInstalled().catch(() => false)
        : (await deps.bundledAction(entry.id, 'status').catch(() => ({ ok: false, installed: false }))).installed === true
      return { id: entry.id, name: text.name ?? entry.name, desc: text.desc, installed }
    })),
    pluginAction: async (id, action) => {
      if (!(await catalogPlugins()).some((entry) => entry.id === id)) return { ok: false, error: pick('未知插件', 'Unknown plugin') }
      if (id === MINECRAFT) {
        const done = await minecraftPluginAction(action, othersBusy)
        return { ok: done.ok, installed: done.status?.installed === true, ...(done.error ? { error: done.error } : {}) }
      }
      return deps.bundledAction(id, action)
    },
    packages: () => listPackages(runner()?.cwd ?? ''),
    packageAction: async (request) => {
      const current = runner()
      return runPiPackageAction({ ...request, cwd: current?.cwd ?? '' }, {
        hasBusyCwd: (cwd) => deps.registry()?.hasBusyCwd(cwd, current?.id) === true,
        hasAnyBusy: othersBusy,
        isKnownProject: deps.isKnownProject
      })
    },
    refresh: deps.refresh
  }
}
