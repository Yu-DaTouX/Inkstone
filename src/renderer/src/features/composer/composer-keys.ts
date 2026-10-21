export interface ComposerKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  nativeEvent: { isComposing?: boolean; keyCode?: number; repeat?: boolean }
  preventDefault: () => void
}

export interface ComposerPasteEvent {
  clipboardData: DataTransfer
  preventDefault: () => void
}

export type ComposerKeyAction = 'none' | 'newline' | 'steer' | 'followUp' | 'abort' | 'armAbort'

export interface ComposerKeyState {
  running: boolean
  compacting: boolean
  sendKey: string
  hasText: boolean
  hasAttachments: boolean
  lastEsc: number
}

export interface ComposerKeyInput extends ComposerKeyState {
  event: ComposerKeyEvent
  completionHandled: boolean
  now: number
}

export interface ComposerKeyPlan {
  action: ComposerKeyAction
  preventDefault: boolean
  lastEsc: number
}

const DOUBLE_ESC_WINDOW = 500

export function isComposingKey(event: ComposerKeyEvent): boolean {
  return !!event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

export const STRAY_ENTER_MS = 500

export function swallowsPendingCompletionKey(key: string): boolean {
  return key === 'Enter' || key === 'Tab'
}

export interface StrayEnterInput {
  event: ComposerKeyEvent
  until: number
  now: number
  plainEnterSends: boolean
}

export function swallowStrayEnter({ event, until, now, plainEnterSends }: StrayEnterInput): boolean {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey) return false
  if (isComposingKey(event)) return false
  if (!(event.nativeEvent.repeat || now < until)) return false
  return event.metaKey || event.ctrlKey || plainEnterSends
}

export function planComposerKey(input: ComposerKeyInput): ComposerKeyPlan {
  const { event, lastEsc } = input
  const idle: ComposerKeyPlan = { action: 'none', preventDefault: false, lastEsc }
  if (event.defaultPrevented || input.completionHandled || isComposingKey(event)) return idle

  if (
    input.running &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'q'
  ) {
    return { action: 'followUp', preventDefault: true, lastEsc }
  }

  if (event.key === 'Enter') {
    if (event.shiftKey) return { action: 'newline', preventDefault: false, lastEsc }
    if (input.running) {
      const queued = input.compacting || event.altKey
      return { action: queued ? 'followUp' : 'steer', preventDefault: true, lastEsc }
    }
    const wantsSend = event.ctrlKey || event.metaKey ? true : input.sendKey !== 'ctrlEnter'
    return wantsSend
      ? { action: 'steer', preventDefault: true, lastEsc }
      : { action: 'newline', preventDefault: false, lastEsc }
  }

  if (event.key === 'Escape' && input.running) {
    if (input.hasText || input.hasAttachments) return idle
    if (input.now - lastEsc < DOUBLE_ESC_WINDOW) return { action: 'abort', preventDefault: true, lastEsc: 0 }
    return { action: 'armAbort', preventDefault: true, lastEsc: input.now }
  }

  return idle
}
