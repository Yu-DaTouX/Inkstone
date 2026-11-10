import type { SearchStep } from './model'

export const SEARCH_HOLD_MS = 800
export const SEARCH_TAIL_SLACK_PX = 32
export const SEARCH_BOTTOM_SLACK_PX = 48

export interface SearchExpansionKeys {
  stable: string
  tagged: string
}

export function searchExpansionKeys(callId: string, step: Pick<SearchStep, 'operationId' | 'command'>): SearchExpansionKeys {
  const target = step.command.action === 'fetch' ? step.command.url : step.command.queries.join('|')
  const stable = `web:${callId}:${step.command.action}:${target}`
  return { stable, tagged: step.operationId ? `web:${callId}:${step.operationId}` : stable }
}

export type SearchAutoPhase = 'idle' | 'live' | 'hold' | 'waiting'

export interface SearchAutoState {
  phase: SearchAutoPhase
  holdUntil: number | null
}

export function seedSearchAuto(running: boolean): SearchAutoState {
  return running ? { phase: 'live', holdUntil: null } : { phase: 'idle', holdUntil: null }
}

export function holdSearchAuto(now: number): SearchAutoState {
  return { phase: 'hold', holdUntil: now + SEARCH_HOLD_MS }
}

export function resolveSearchAuto(state: SearchAutoState, now: number, canCollapse: boolean): SearchAutoState {
  if (state.phase === 'hold' && (state.holdUntil === null || now >= state.holdUntil)) {
    return canCollapse ? { phase: 'idle', holdUntil: null } : { phase: 'waiting', holdUntil: null }
  }
  if (state.phase === 'waiting' && canCollapse) return { phase: 'idle', holdUntil: null }
  return state
}

export function searchExpansionOpen(manual: boolean | undefined, auto: SearchAutoState): boolean {
  return manual ?? auto.phase !== 'idle'
}

export interface SearchPlacement {
  top: number
  bottom: number
  viewTop: number
  viewBottom: number
  atBottom: boolean
}

export function canAutoCollapse(placement: SearchPlacement): boolean {
  if (placement.viewBottom <= placement.viewTop) return false
  if (placement.atBottom) return true
  if (placement.bottom <= placement.viewTop) return true
  if (placement.top >= placement.viewBottom) return true
  return placement.bottom >= placement.viewBottom - SEARCH_TAIL_SLACK_PX
}
