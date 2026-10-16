import type { TerminalSessionInfo } from '../../../shared/ipc'
import type { MessageKey } from '../i18n'
import type { BadgeTone } from '../components/ui'

export function terminalTabStatus(terminal: TerminalSessionInfo): { key: MessageKey; tone: BadgeTone; progress?: number } | null {
  const status = terminal.status
  if (!status || status.state === 'clear') return null
  if (!terminal.alive && status.state !== 'done' && status.state !== 'error') return null
  switch (status.state) {
    case 'working': return {
      key: 'term.running', tone: 'accent',
      ...(typeof status.progress === 'number' && Number.isFinite(status.progress) && status.progress >= 0 && status.progress <= 100
        ? { progress: Math.round(status.progress) } : {})
    }
    case 'blocked': return {
      key: status.kind === 'permission' ? 'term.waitPermission' : status.kind === 'question' ? 'term.waitAnswer' : status.kind === 'auth' ? 'term.waitAuth' : 'term.wait',
      tone: 'warn'
    }
    case 'done': return { key: 'term.ok', tone: 'ok' }
    case 'error': return { key: 'term.error', tone: 'err' }
    case 'idle': return { key: 'term.idle', tone: 'neutral' }
  }
}
