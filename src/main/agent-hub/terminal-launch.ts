import type { HubTask } from '../../shared/agent-hub'

export interface HubTerminalBridge {
  execPath: string
  script: string
  claudeConfigPath?: string
}

export const HUB_BRIDGE_ENV = ['INKSTONE_HUB_URL', 'INKSTONE_HUB_TOKEN', 'INKSTONE_HUB_RUN', 'INKSTONE_HUB_PROJECT'] as const

export interface HubTerminalSession {
  id?: string
  resume: boolean
  uniqueCwd: boolean
}

export function hubPresetsSessionId(agent: HubTask['agent']): boolean {
  return agent === 'claude' || agent === 'gemini' || agent === 'grok'
}

function tomlLiteral(value: string): string { return `'${value.replace(/'/g, '')}'` }

function codexMcpOverride(bridge: HubTerminalBridge): string[] {
  const table = `{command=${tomlLiteral(bridge.execPath)},args=[${tomlLiteral(bridge.script)}],env={ELECTRON_RUN_AS_NODE='1'},env_vars=[${HUB_BRIDGE_ENV.map((name) => `'${name}'`).join(',')}]}`
  return ['-c', `mcp_servers.inkstone=${table}`]
}

function sessionArgs(agent: HubTask['agent'], session: HubTerminalSession): string[] {
  if (agent === 'claude' || agent === 'grok') return session.id ? [session.resume ? '--resume' : '--session-id', session.id] : session.resume ? ['--continue'] : []
  if (agent === 'gemini') return session.resume ? ['--resume', 'latest'] : session.id ? ['--session-id', session.id] : []
  if (agent === 'codex' && session.resume) return session.uniqueCwd ? ['resume', '--last'] : ['resume']
  if (agent === 'antigravity' && session.resume) return ['--continue']
  return []
}

export function hubTerminalArgs(base: string[], task: Pick<HubTask, 'agent' | 'prompt' | 'model' | 'externalSessionId'>, bridge?: HubTerminalBridge, session?: HubTerminalSession): string[] {
  const prompt = session?.resume ? '' : task.prompt.trim()
  return [
    ...base,
    ...(bridge && task.agent === 'codex' ? codexMcpOverride(bridge) : []),
    ...(session ? sessionArgs(task.agent, session) : task.externalSessionId && task.agent === 'codex' ? ['resume', task.externalSessionId] : []),
    ...(task.model ? ['--model', task.model] : []),
    ...(prompt ? task.agent === 'gemini' ? ['--prompt-interactive', prompt] : task.agent === 'antigravity' ? ['-i', prompt] : [prompt] : []),
    ...(bridge?.claudeConfigPath && task.agent === 'claude' ? ['--mcp-config', bridge.claudeConfigPath] : [])
  ]
}
