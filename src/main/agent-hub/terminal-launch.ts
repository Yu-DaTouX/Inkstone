import type { HubTask } from '../../shared/agent-hub'

/** Interactive CLIs accept the user's prompt verbatim, or open without a turn. */
export function hubTerminalArgs(base: string[], task: Pick<HubTask, 'agent' | 'prompt' | 'model' | 'externalSessionId'>): string[] {
  const prompt = task.prompt.trim()
  return [
    ...base,
    ...(task.externalSessionId && task.agent === 'codex' ? ['resume', task.externalSessionId] : []),
    ...(task.model ? ['--model', task.model] : []),
    ...(prompt ? task.agent === 'gemini' ? ['--prompt-interactive', prompt] : [prompt] : [])
  ]
}
