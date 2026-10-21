import { useUiV3 } from '../../state/ui-v3'
import { activateTerminal } from '../terminal/terminal-activate'
import { cdCommandFor } from './files-menu'

const POLL_MS = 150
const POLL_LIMIT = 40

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function canOpenTerminal(): boolean {
  return typeof window !== 'undefined' && typeof window.yan?.terminal?.list === 'function'
}

export async function openFolderInTerminal(ownerKey: string, abs: string): Promise<boolean> {
  const terminal = window.yan?.terminal
  if (!terminal) return false
  const command = cdCommandFor(abs)
  if (!command) return false
  const ui = useUiV3.getState()
  ui.setWorkspaceTab('terminal')
  ui.setWorkspaceOpen(true)
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const list = await terminal.list().catch(() => [])
    const owned = list.filter((item) => item.owner === ownerKey && item.alive)
    const target = owned[owned.length - 1]
    if (target) {
      activateTerminal(ownerKey, target.id)
      return terminal.write(target.id, command)
    }
    await wait(POLL_MS)
  }
  return false
}
