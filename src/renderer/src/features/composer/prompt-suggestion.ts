import { isComposingKey, type ComposerKeyEvent } from './composer-keys'

export const PROMPT_SUGGESTION_STATUS_KEY = 'inkstone_prompt_suggestion'

export interface SuggestionView {
  suggestion: string | undefined
  dismissed: string | null
  enabled: boolean
  running: boolean
  answering: boolean
  value: string
  attachmentCount: number
  composing?: boolean
}

export function visibleSuggestion(view: SuggestionView): string | null {
  const text = view.suggestion?.trim()
  if (!text || /^[!/]/.test(text) || !view.enabled || view.running || view.answering || view.composing) return null
  if (view.value !== '' || view.attachmentCount > 0 || text === view.dismissed) return null
  return text
}

export type SuggestionKeyAction = 'fill' | 'send' | 'dismiss' | null

export function suggestionKeyAction(event: ComposerKeyEvent, sendKey: string): SuggestionKeyAction {
  if (event.defaultPrevented || isComposingKey(event)) return null
  const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  if (plain && (event.key === 'Tab' || event.key === 'ArrowRight')) return 'fill'
  if (plain && event.key === 'Escape') return 'dismiss'
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
    const wantsSend = event.ctrlKey || event.metaKey ? true : sendKey !== 'ctrlEnter'
    return wantsSend ? 'send' : null
  }
  return null
}
