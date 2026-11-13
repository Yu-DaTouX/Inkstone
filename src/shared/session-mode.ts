export type SessionMode = 'ask' | 'plan'
export type SessionModeChange = SessionMode | 'off' | 'approve'
export type StoredSessionMode = SessionMode | 'approved'

export const SESSION_MODE_FILE = 'session-modes.json'

export function isSessionModeChange(value: unknown): value is SessionModeChange {
  return value === 'ask' || value === 'plan' || value === 'off' || value === 'approve'
}

export function nextStoredMode(current: StoredSessionMode | undefined, change: SessionModeChange): StoredSessionMode | undefined | null {
  if (change === 'ask' || change === 'plan') return change
  if (change === 'approve') return current === 'plan' ? 'approved' : null
  return current === 'approved' ? 'approved' : undefined
}

export function visibleMode(stored: StoredSessionMode | undefined): SessionMode | undefined {
  return stored === 'ask' || stored === 'plan' ? stored : undefined
}

export function sessionModeState(stored: StoredSessionMode | undefined): { sessionMode?: SessionMode } {
  const mode = visibleMode(stored)
  return mode ? { sessionMode: mode } : {}
}
