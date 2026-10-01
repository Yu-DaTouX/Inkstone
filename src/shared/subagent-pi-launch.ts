import { agentOwnedPiArgs } from './agent-context'

/** 子运行使用独立原生会话；只读模式继续限制工具与扩展入口。 */
export function subagentPiArgs(options: { sessionDir: string; native: boolean; readOnly: boolean; model?: string; systemPrompt?: string; extensions?: string[] }): string[] {
  const base = ['--session-dir', options.sessionDir, '--no-extensions', ...(options.extensions?.flatMap(path => ['--extension', path]) ?? []), ...(options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []), ...(options.model ? ['--model', options.model] : [])]
  return options.readOnly ? [...base, '--no-skills', '--tools', 'read,grep,find,ls'] : agentOwnedPiArgs(base, options.native)
}
