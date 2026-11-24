import { basename, join } from 'node:path'
import { pick } from '../../shared/ui-lang'
import type { AppSettings } from '../../shared/ipc'
import type { AgentController } from '../agent'
import type { RunnerRegistry } from '../runners'
import { PI_AGENT_DIR, YAN_DIR } from '../paths'
import { verifyNativeStartupWitness } from './app-native-witness'
import { mcpAppProxyService } from './app-proxy-service'
import type { McpSettingsHost } from './service-settings'

export interface McpSettingsTarget {
  agent: AgentController | undefined
  runner: { id: string; cwd: string } | null
}

export interface McpSettingsHostDeps {
  registry(): RunnerRegistry | null
  settings(): Promise<AppSettings>
  isProjectTrusted(cwd: string): Promise<boolean>
}

export function mcpContextOf(registry: RunnerRegistry | null, target: McpSettingsTarget): string {
  const { agent, runner } = target
  return JSON.stringify([runner?.id, agent?.getState()?.sessionId, runner?.cwd, agent?.capabilityProjectId, runner ? registry?.runtimeOf(runner.id)?.generation : undefined])
}

export async function createMcpSettingsHost(deps: McpSettingsHostDeps, target: () => McpSettingsTarget, caller?: AgentController): Promise<McpSettingsHost> {
  const { registry, settings, isProjectTrusted } = deps
  const contextNow = (): string => mcpContextOf(registry(), target())
  const context = contextNow()
  const { agent, runner } = target()
  const st = await settings()
  const project = st.projects.find((entry) => entry.id === agent?.capabilityProjectId)
  const projectTrusted = project && runner ? await isProjectTrusted(runner.cwd).catch(() => false) : false
  const witness = agent?.nativeBootWitness()
  const nativeConfigChanged = witness ? !(await verifyNativeStartupWitness(witness)).ok : null
  const busy = (): boolean => registry()?.agents().some((item) => {
    if (item === caller) return false
    const state = item.getState()
    return !!(state?.isAgentRunning || state?.isStreaming || state?.isCompacting || state?.pendingMessageCount || item.hasRunningBash() || item.getPendingUiCount())
  }) ?? false
  const changed = (): never => { throw new Error(pick('当前会话或项目已切换，请重新读取', 'Session or project changed; reload')) }
  if (context !== contextNow()) changed()
  return {
    agentDir: PI_AGENT_DIR, context, minecraftPluginDir: join(YAN_DIR, 'plugins', 'inkstone-minecraft'),
    project: project && runner ? { id: project.id, name: project.name || basename(runner.cwd), cwd: runner.cwd } : null,
    projectTrusted, projects: st.projects, nativeConfigChanged,
    busy: busy(), isBusy: busy,
    managedToolsChanged: () => mcpAppProxyService().toolsChangedServers(agent?.capabilityProjectId ?? undefined),
    refreshManagedTools: async () => {
      const result = await mcpAppProxyService().refresh({ callerProjectId: agent?.capabilityProjectId ?? undefined, allowEmpty: true })
      const problems = [
        ...result.errors.map((entry) => `${entry.serverId}: ${entry.error}`),
        ...result.collisions.map((entry) => pick(`工具名 ${entry.name} 重名，已跳过相关工具`, `Tool name ${entry.name} is duplicated; the affected tools were skipped`))
      ]
      return problems.length ? { ok: false, warning: problems.join('；') } : { ok: true }
    },
    assertContext: () => { if (context !== contextNow()) changed() }
  }
}
