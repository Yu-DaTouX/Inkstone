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

/** TOML 字面量字符串不处理转义，Windows 路径可原样写入；路径里不会出现单引号。 */
function tomlLiteral(value: string): string { return `'${value.replace(/'/g, '')}'` }

function codexMcpOverride(bridge: HubTerminalBridge): string[] {
  const table = `{command=${tomlLiteral(bridge.execPath)},args=[${tomlLiteral(bridge.script)}],env={ELECTRON_RUN_AS_NODE='1'},env_vars=[${HUB_BRIDGE_ENV.map((name) => `'${name}'`).join(',')}]}`
  return ['-c', `mcp_servers.inkstone=${table}`]
}

/**
 * Interactive CLIs accept the user's prompt verbatim, or open without a turn.
 * 传入 bridge 时同时附上砚的 MCP 入口，叠加在用户自己的 MCP 之上，不替换。
 */
export function hubTerminalArgs(base: string[], task: Pick<HubTask, 'agent' | 'prompt' | 'model' | 'externalSessionId'>, bridge?: HubTerminalBridge): string[] {
  const prompt = task.prompt.trim()
  return [
    ...base,
    ...(bridge && task.agent === 'codex' ? codexMcpOverride(bridge) : []),
    ...(task.externalSessionId && task.agent === 'codex' ? ['resume', task.externalSessionId] : []),
    ...(task.model ? ['--model', task.model] : []),
    ...(prompt ? task.agent === 'gemini' ? ['--prompt-interactive', prompt] : [prompt] : []),
    /* --mcp-config 接受多个值，必须排在位置参数（初始指令）之后，否则会把指令当成配置文件。 */
    ...(bridge?.claudeConfigPath && task.agent === 'claude' ? ['--mcp-config', bridge.claudeConfigPath] : [])
  ]
}
