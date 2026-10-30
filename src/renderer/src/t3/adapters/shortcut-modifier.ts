import { useEffect, useRef, useState } from 'react'

export interface ShortcutModifierState {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false
}

function sameModifiers(left: ShortcutModifierState, right: ShortcutModifierState): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  )
}

export function useShortcutModifierState(): ShortcutModifierState {
  const [state, setState] = useState(EMPTY_SHORTCUT_MODIFIER_STATE)
  const stateRef = useRef(EMPTY_SHORTCUT_MODIFIER_STATE)

  useEffect(() => {
    const updateState = (next: ShortcutModifierState): void => {
      if (sameModifiers(stateRef.current, next)) return
      stateRef.current = next
      setState(next)
    }
    const onKeyboardEvent = (event: KeyboardEvent): void => {
      updateState(shortcutModifierStateAfterKeyboardEvent(stateRef.current, event))
    }
    const onResetEvent = (): void => {
      updateState(EMPTY_SHORTCUT_MODIFIER_STATE)
    }

    window.addEventListener('keydown', onKeyboardEvent, true)
    window.addEventListener('keyup', onKeyboardEvent, true)
    window.addEventListener('paste', onResetEvent, true)
    window.addEventListener('blur', onResetEvent)
    return () => {
      window.removeEventListener('keydown', onKeyboardEvent, true)
      window.removeEventListener('keyup', onKeyboardEvent, true)
      window.removeEventListener('paste', onResetEvent, true)
      window.removeEventListener('blur', onResetEvent)
    }
  }, [])

  return state
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case 'Meta':
    case 'OS':
    case 'Command':
      return 'metaKey'
    case 'Control':
      return 'ctrlKey'
    case 'Alt':
    case 'Option':
      return 'altKey'
    case 'Shift':
      return 'shiftKey'
    default:
      return null
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key)
  const nextState: ShortcutModifierState = normalizedModifierKey
    ? { ...currentState, [normalizedModifierKey]: event.type === 'keydown' }
    : {
        metaKey: currentState.metaKey && event.metaKey,
        ctrlKey: currentState.ctrlKey && event.ctrlKey,
        altKey: currentState.altKey && event.altKey,
        shiftKey: currentState.shiftKey && event.shiftKey
      }

  return sameModifiers(currentState, nextState) ? currentState : nextState
}
