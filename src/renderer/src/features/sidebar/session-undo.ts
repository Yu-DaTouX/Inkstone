export const SESSION_UNDO_WINDOW_MS = 10_000

export interface SessionUndoTicket {
  readonly token: string
  readonly path: string
  readonly title: string
  state: 'open' | 'claimed' | 'expired'
}

export function createUndoTicket(token: string | undefined, path: string, title: string): SessionUndoTicket | null {
  const trimmed = token?.trim()
  return trimmed ? { token: trimmed, path, title, state: 'open' } : null
}

export function canUndo(ticket: SessionUndoTicket | null | undefined): boolean {
  return ticket?.state === 'open'
}

export function claimUndo(ticket: SessionUndoTicket | null | undefined): string | null {
  if (!ticket || ticket.state !== 'open') return null
  ticket.state = 'claimed'
  return ticket.token
}

export function releaseUndo(ticket: SessionUndoTicket, restored: boolean): void {
  ticket.state = restored ? 'expired' : 'open'
}

export function expireUndo(ticket: SessionUndoTicket | null | undefined): void {
  if (ticket && ticket.state === 'open') ticket.state = 'expired'
}
