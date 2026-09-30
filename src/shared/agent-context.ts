/** The agent owns its transcript and compaction; Inkstone only projects its events. */
export const AGENT_CONTEXT_OWNER = 'agent' as const

export const AGENT_CONTEXT_ERROR = '上下文由当前 Agent 管理；砚不再提供预算、整理或自动交接。'

const RETIRED_EXTENSIONS = new Set([
  'context.js',
  'context-budget-observer.js',
  'context-budget-maintenance.js',
  'project-knowledge.js',
  'goal-resume.js',
  'handoffs.js'
])

export function isAgentContextExtension(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const ownedDirectory = normalized.includes('/pi-extensions/') || normalized.includes('/yan-thin/')
  return !ownedDirectory || !RETIRED_EXTENSIONS.has(normalized.split('/').at(-1) ?? '')
}

/** Keep UI and authorization adapters while retiring host transcript modifiers. */
export function nativePiToolsSupported(version: string | undefined): boolean {
  const parts = version?.split('.').map(Number)
  return !!parts && parts.length >= 3 && parts.every(Number.isFinite) && (parts[0] > 0 || parts[1] >= 99)
}

export function agentOwnedPiArgs(args: readonly string[], nativeTools = false): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--no-skills') continue
    // New pi discovers built-ins through its own settings, including disabled entries.
    if (nativeTools && args[i] === '--no-extensions') continue
    if ((args[i] === '--extension' || args[i] === '-e') && args[i + 1]) {
      const path = args[++i]
      if (isAgentContextExtension(path)) result.push('--extension', path)
    } else result.push(args[i])
  }
  return result
}
