import type { MiniItem, QuickAskErrorCode, AuxTarget } from './aux-types'

export interface QuickAskWindowState {
  visible: boolean
  submitting: boolean
  errorCode: QuickAskErrorCode | null
  errorMessage: string | null
}

export const INITIAL_QUICK_ASK_STATE: QuickAskWindowState = {
  visible: false,
  submitting: false,
  errorCode: null,
  errorMessage: null
}

export type QuickAskAction =
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'submit-start' }
  | { type: 'submit-ok' }
  | { type: 'submit-error'; code: QuickAskErrorCode; message?: string }

export function quickAskReducer(state: QuickAskWindowState, action: QuickAskAction): QuickAskWindowState {
  switch (action.type) {
    case 'show':
      return { ...state, visible: true, errorCode: null, errorMessage: null }
    case 'hide':
      return { ...state, visible: false, submitting: false }
    case 'submit-start':
      return { ...state, submitting: true, errorCode: null, errorMessage: null }
    case 'submit-ok':
      return { visible: false, submitting: false, errorCode: null, errorMessage: null }
    case 'submit-error':
      return { ...state, submitting: false, errorCode: action.code, errorMessage: action.message ?? null }
    default:
      return state
  }
}

export function validateQuickAsk(prompt: string, target: AuxTarget, hasCurrent: boolean): QuickAskErrorCode | null {
  if (!prompt.trim()) return 'empty'
  if (target === 'current' && !hasCurrent) return 'no-current'
  return null
}

export interface MiniWindowState {
  enabled: boolean
  visible: boolean
  items: MiniItem[]
}

export const INITIAL_MINI_STATE: MiniWindowState = { enabled: false, visible: false, items: [] }

export type MiniAction =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'set-items'; items: MiniItem[] }

export function miniReducer(state: MiniWindowState, action: MiniAction): MiniWindowState {
  switch (action.type) {
    case 'set-enabled':
      return { ...state, enabled: action.enabled, visible: action.enabled ? state.visible : false }
    case 'show':
      return state.enabled ? { ...state, visible: true } : state
    case 'hide':
      return { ...state, visible: false }
    case 'set-items':
      return { ...state, items: action.items }
    default:
      return state
  }
}

export const MINI_ROW_HEIGHT = 44
export const MINI_HEADER_HEIGHT = 36
export const MINI_MAX_HEIGHT = 420

export function miniWindowHeight(itemCount: number, size: { header?: number; row?: number; max?: number } = {}): number {
  const header = size.header ?? MINI_HEADER_HEIGHT
  const row = size.row ?? MINI_ROW_HEIGHT
  const max = size.max ?? MINI_MAX_HEIGHT
  const wanted = header + Math.max(itemCount, 1) * row
  return Math.min(wanted, max)
}
