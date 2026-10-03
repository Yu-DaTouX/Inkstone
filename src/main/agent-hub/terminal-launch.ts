import type { HubTask } from '../../shared/agent-hub'

/** 终端内 CLI 接入砚共享工具（派活、回报、浏览器）所需的桥接信息。令牌只走环境变量，不进命令行。 */
export interface HubTerminalBridge {
  /** 运行 hub-mcp.mjs 的可执行文件；Electron 需要 ELECTRON_RUN_AS_NODE，由配置里的 env 提供 */
  execPath: string
  script: string
  /** Claude 的 --mcp-config 文件，调用方已写好 */
  claudeConfigPath?: string
}

/** 终端运行时由父进程环境转交给桥接进程的变量名。 */
export const HUB_BRIDGE_ENV = ['INKSTONE_HUB_URL', 'INKSTONE_HUB_TOKEN', 'INKSTONE_HUB_RUN', 'INKSTONE_HUB_PROJECT'] as const

/**
 * 会话的接续方式。各 CLI 能力不同：
 *   claude / gemini / grok  启动时可指定会话 ID（--session-id），首次用它新建；
 *                           再次启动 claude、grok 按 ID 恢复，gemini 只能恢复本目录最近一次。
 *   codex                   会话 ID 由它自己生成；每个任务有独立工作目录，恢复用 resume --last（按目录过滤）。
 */
export interface HubTerminalSession {
  /** 新建会话时预先指定的 ID；恢复时是当初记下的 ID */
  id?: string
  /** 接着上次的对话，而不是新开一个 */
  resume: boolean
  /** 工作目录是这个任务独有的（独立 worktree）；共用项目目录时，按目录恢复可能接到别的会话 */
  uniqueCwd: boolean
}

/** 能在启动时指定会话 ID 的 CLI，砚据此记下 ID 以便之后恢复。 */
export function hubPresetsSessionId(agent: HubTask['agent']): boolean {
  return agent === 'claude' || agent === 'gemini' || agent === 'grok'
}

/** TOML 字面量字符串不处理转义，Windows 路径可原样写入；路径里不会出现单引号。 */
function tomlLiteral(value: string): string { return `'${value.replace(/'/g, '')}'` }

function codexMcpOverride(bridge: HubTerminalBridge): string[] {
  const table = `{command=${tomlLiteral(bridge.execPath)},args=[${tomlLiteral(bridge.script)}],env={ELECTRON_RUN_AS_NODE='1'},env_vars=[${HUB_BRIDGE_ENV.map((name) => `'${name}'`).join(',')}]}`
  return ['-c', `mcp_servers.inkstone=${table}`]
}

function sessionArgs(agent: HubTask['agent'], session: HubTerminalSession): string[] {
  /* 没有记下 ID 的旧任务：按目录接续最近一次（每个任务有独立工作目录）。 */
  if (agent === 'claude' || agent === 'grok') return session.id ? [session.resume ? '--resume' : '--session-id', session.id] : session.resume ? ['--continue'] : []
  if (agent === 'gemini') return session.resume ? ['--resume', 'latest'] : session.id ? ['--session-id', session.id] : []
  if (agent === 'codex' && session.resume) return session.uniqueCwd ? ['resume', '--last'] : ['resume']
  /* Antigravity（agy）：对话按工作目录归属，-c 接续该目录最近一次；新建时不能预设 ID。 */
  if (agent === 'antigravity' && session.resume) return ['--continue']
  return []
}

/**
 * Interactive CLIs accept the user's prompt verbatim, or open without a turn.
 * 传入 bridge 时同时附上砚的 MCP 入口，叠加在用户自己的 MCP 之上，不替换。
 * 传入 session 时按各 CLI 的方式新建或接续会话；接续时不再重发初始指令。
 */
export function hubTerminalArgs(base: string[], task: Pick<HubTask, 'agent' | 'prompt' | 'model' | 'externalSessionId'>, bridge?: HubTerminalBridge, session?: HubTerminalSession): string[] {
  const prompt = session?.resume ? '' : task.prompt.trim()
  return [
    ...base,
    ...(bridge && task.agent === 'codex' ? codexMcpOverride(bridge) : []),
    ...(session ? sessionArgs(task.agent, session) : task.externalSessionId && task.agent === 'codex' ? ['resume', task.externalSessionId] : []),
    ...(task.model ? ['--model', task.model] : []),
    ...(prompt ? task.agent === 'gemini' ? ['--prompt-interactive', prompt] : task.agent === 'antigravity' ? ['-i', prompt] : [prompt] : []),
    /* --mcp-config 接受多个值，必须排在位置参数（初始指令）之后，否则会把指令当成配置文件。 */
    ...(bridge?.claudeConfigPath && task.agent === 'claude' ? ['--mcp-config', bridge.claudeConfigPath] : [])
  ]
}
