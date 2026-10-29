import { openPanelTool } from '../workbench/panel-actions'
import { activateTerminal } from './terminal-activate'
import { isTerminalCommandRunning } from './terminal-running'

const SHELL_LANGS = /^(?:sh|bash|zsh|fish|shell|console|powershell|pwsh|ps1|cmd|bat)$/i
const POLL_MS = 150
const POLL_LIMIT = 40

export type TerminalFillResult = 'filled' | 'busy' | 'failed'

export function terminalCommandOf(lang: string | undefined, source: string): string | null {
  if (!lang || !SHELL_LANGS.test(lang)) return null
  const body = source.replace(/\r?\n$/, '')
  const command = body.trim()
  if (!command || command.endsWith('\\') || command.endsWith('`') || command.endsWith('^')) return null
  if (/[\p{Cc}\p{Cf}]/u.test(body)) return null
  return command
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export async function fillTerminalCommand(ownerKey: string, command: string): Promise<TerminalFillResult> {
  const terminal = window.yan?.terminal
  if (!terminal || !ownerKey) return 'failed'
  openPanelTool('terminal')
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const list = await terminal.list().catch(() => [])
    const owned = list.filter((item) => item.owner === ownerKey && item.alive)
    if (owned.length) {
      const target = [...owned].reverse().find((item) => !isTerminalCommandRunning(item))
      if (!target) return 'busy'
      activateTerminal(ownerKey, target.id)
      return (await terminal.write(target.id, command).catch(() => false)) ? 'filled' : 'failed'
    }
    await wait(POLL_MS)
  }
  return 'failed'
}
