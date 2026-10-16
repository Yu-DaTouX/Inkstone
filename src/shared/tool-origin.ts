const SHELL_TOOLS = new Set(['bash', 'shell', 'run', 'exec'])

const YAN_TASKS_APPLY = /(^|[\s"'`;&|(])(?:[^\s"'`]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?["'`]?\s+tasks\s+apply(?:[\s"'`;&|)]|$)/i

const YAN_GOAL = /(^|[\s"'`;&|(])(?:[^\s"'`]*[\\/])?yan(?:\.(?:cmd|exe|mjs))?["'`]?\s+goal\s+(?:ready|report|status)(?:[\s"'`;&|)]|$)/i

function commandTextOf(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    const v = a[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

export function taskPlanCommand(name: unknown, args: unknown): string | null {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name)) return null
  const text = commandTextOf(args)
  if (!text) return null
  return YAN_TASKS_APPLY.test(text) ? text : null
}

export function goalCommand(name: unknown, args: unknown): string | null {
  if (typeof name !== 'string' || !SHELL_TOOLS.has(name)) return null
  const text = commandTextOf(args)
  if (!text) return null
  return YAN_GOAL.test(text) ? text : null
}

export function summarizeTaskPlanCommand(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 120 ? `${one.slice(0, 119)}…` : one
}

export const summarizeYanCommand = summarizeTaskPlanCommand
