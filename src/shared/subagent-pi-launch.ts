import { agentOwnedPiArgs } from './agent-context'

export function subagentModelError(model: string | undefined, readOnly: boolean): string | undefined {
  if (readOnly && model?.startsWith('claude-bridge/')) {
    return 'Claude 订阅模型暂不支持只读子任务：只读执行禁用 Provider 扩展。请选择当前文件夹执行，或选择原生 pi 模型。'
  }
  return undefined
}

export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']
export const READ_ONLY_EXTENSION_TOOLS = ['git_inspect', 'web_search', 'web_fetch']

export function subagentPiArgs(options: { sessionDir: string; sessionFile?: string; native: boolean; readOnly: boolean; model?: string; systemPrompt?: string; extensions?: string[]; readOnlyExtension?: string }): string[] {
  const error = subagentModelError(options.model, options.readOnly)
  if (error) throw new Error(error)
  const base = ['--session-dir', options.sessionDir, ...(options.sessionFile ? ['--session', options.sessionFile] : []), '--no-extensions', ...(options.extensions?.flatMap(path => ['--extension', path]) ?? []), ...(options.systemPrompt ? ['--append-system-prompt', options.systemPrompt] : []), ...(options.model ? ['--model', options.model] : [])]
  if (!options.readOnly) return agentOwnedPiArgs(base, options.native)
  const tools = options.readOnlyExtension ? [...READ_ONLY_TOOLS, ...READ_ONLY_EXTENSION_TOOLS] : READ_ONLY_TOOLS
  return [...base, ...(options.readOnlyExtension ? ['--extension', options.readOnlyExtension] : []), '--no-skills', '--tools', tools.join(',')]
}
