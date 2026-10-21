import type { QuickAskErrorCode, AuxTarget } from './aux-types'

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
