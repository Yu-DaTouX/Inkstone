export const COMPOSER_LEFT_ORDER = ['mode', 'permission', 'plus'] as const

export const COMPOSER_RIGHT_ORDER = ['voice', 'context', 'model-thinking', 'run', 'send'] as const

export type ComposerLeftControl = (typeof COMPOSER_LEFT_ORDER)[number]
export type ComposerRightControl = (typeof COMPOSER_RIGHT_ORDER)[number]

type ComposerMode = 'bash' | 'cmd' | null

export function composerMode(value: string): ComposerMode {
  if (value.startsWith('!')) return 'bash'
  if (value.startsWith('/')) return 'cmd'
  return null
}

export function composerPrompt(value: string): '$' | '›' {
  return value.startsWith('!') ? '$' : '›'
}

export function composerLocalCommand(value: string, commands: readonly { source: string; name: string }[]): boolean {
  if (value.startsWith('!')) return true
  if (value === '/login' || value.startsWith('/login ')) return true
  const name = /^\/([^\s]+)/.exec(value)?.[1]?.toLowerCase()
  if (!name) return false
  if (name === 'ultracode') return value.trim().toLowerCase() === '/ultracode'
  return commands.some(
    (command) => (command.source === 'yan' || command.source === 'compatibility') && command.name.toLowerCase() === name
  )
}

interface ComposerPlaceholderState {
  bash: boolean
  session: boolean
  firstRun: boolean
}

type ComposerPlaceholderKey =
  | 'composer.phBash'
  | 'composer.phSession'
  | 'composer.phFirst'
  | 'composer.phDraft'

export function composerPlaceholderKey(state: ComposerPlaceholderState): ComposerPlaceholderKey {
  if (state.bash) return 'composer.phBash'
  if (state.session) return 'composer.phSession'
  return state.firstRun ? 'composer.phFirst' : 'composer.phDraft'
}

interface ComposerSubmitState {
  running: boolean
  hasText: boolean
  hasAttachments: boolean
}

export function composerSubmitAction(state: ComposerSubmitState): 'stop' | 'send' {
  return state.running && !state.hasText && !state.hasAttachments ? 'stop' : 'send'
}

export function thinkingLevelIndex(levels: readonly string[], level: string): number {
  const index = levels.indexOf(level)
  return index < 0 ? 0 : index
}

export function thinkingLevelAt(levels: readonly string[], index: number): string | null {
  if (!Number.isFinite(index)) return null
  const clamped = Math.max(0, Math.min(levels.length - 1, Math.round(index)))
  return levels[clamped] ?? null
}

export function thinkingDragAction(
  levels: readonly string[],
  index: number
): { kind: 'preview'; level: string } | { kind: 'none' } {
  const level = thinkingLevelAt(levels, index)
  return level ? { kind: 'preview', level } : { kind: 'none' }
}

export function thinkingCommitAction(
  levels: readonly string[],
  index: number,
  current: string
): { kind: 'commit'; level: string } | { kind: 'none' } {
  const level = thinkingLevelAt(levels, index)
  if (!level || level === current) return { kind: 'none' }
  return { kind: 'commit', level }
}
