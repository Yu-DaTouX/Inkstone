import { agentOwnedPiArgs } from './agent-context'

/** 只读执行禁用自动扩展；订阅 Provider 当前依赖扩展加载，提前给出明确结果。 */
export function subagentModelError(model: string | undefined, readOnly: boolean): string | undefined {
  if (readOnly && model?.startsWith('claude-bridge/')) {
    return 'Claude 订阅模型暂不支持只读子任务：只读执行禁用 Provider 扩展。请选择当前文件夹执行，或选择原生 pi 模型。'
  }
  return undefined
}

/** 子运行使用独立原生会话；只读模式继续限制工具与扩展入口。 */
export function subagentPiArgs(options: { sessionDir: string; native: boolean; readOnly: boolean; model?: string; systemPrompt?: string; extensions?: string[] }): string[] {
  const error = subagentModelError(options.model, options.readOnly)
  if (error) throw new Error(error)
  const base = ['--session-dir', options.sessionDir, '--no-extensions', ...(options.extensions?.flatMap(path => ['--extension', path]) ?? []), ...(options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []), ...(options.model ? ['--model', options.model] : [])]
  return options.readOnly ? [...base, '--no-skills', '--tools', 'read,grep,find,ls'] : agentOwnedPiArgs(base, options.native)
}
