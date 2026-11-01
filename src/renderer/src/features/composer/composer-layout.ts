type ComposerMode = 'bash' | 'cmd' | null

export function composerMode(value: string): ComposerMode {
  if (value.startsWith('!')) return 'bash'
  if (value.startsWith('/')) return 'cmd'
  return null
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
