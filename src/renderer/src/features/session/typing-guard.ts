import { useEffect, useRef, useState, type RefObject } from 'react'

export const TYPING_IDLE_MS = 1500

export interface TypingSnapshot {
  now: number
  lastTypedAt: number
  editableFocused: boolean
  editableHasText: boolean
  focusInsideCard: boolean
}

export function shouldDeferCardFocus(snapshot: TypingSnapshot): boolean {
  if (!snapshot.editableFocused || snapshot.focusInsideCard) return false
  return snapshot.now - snapshot.lastTypedAt < TYPING_IDLE_MS || snapshot.editableHasText
}

export interface CardFocusKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
}

export function isCardFocusKey(event: CardFocusKeyEvent): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false
  return event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey) && !event.altKey
}

export function cardFocusKeysText(mac: boolean): string {
  return mac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter'
}

let lastTypedAt = Number.NEGATIVE_INFINITY
let tracking = false

function isEditable(element: Element | null): element is HTMLElement {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes((element as HTMLInputElement).type)
  return (element as HTMLElement).isContentEditable === true
}

function editableText(element: HTMLElement): string {
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return (element as HTMLInputElement).value
  return element.textContent ?? ''
}

function noteTyping(event: Event): void {
  if (isEditable(event.target as Element | null)) lastTypedAt = Date.now()
}

export function startTypingTracker(): void {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener('keydown', noteTyping, true)
  document.addEventListener('input', noteTyping, true)
  document.addEventListener('compositionupdate', noteTyping, true)
}

export function typingSnapshot(card: HTMLElement | null): TypingSnapshot {
  const active = document.activeElement
  const editable = isEditable(active)
  return {
    now: Date.now(),
    lastTypedAt,
    editableFocused: editable,
    editableHasText: editable ? editableText(active).trim().length > 0 : false,
    focusInsideCard: !!card && !!active && card.contains(active)
  }
}

startTypingTracker()

const owners: Array<{ token: symbol; focus: () => void }> = []

function onCardFocusKey(event: KeyboardEvent): void {
  if (!owners.length || !isCardFocusKey(event)) return
  event.preventDefault()
  event.stopPropagation()
  owners[owners.length - 1].focus()
}

function claimCardFocusKey(focus: () => void): () => void {
  const token = Symbol('card-focus')
  if (!owners.length) window.addEventListener('keydown', onCardFocusKey, true)
  owners.push({ token, focus })
  return () => {
    const at = owners.findIndex((owner) => owner.token === token)
    if (at >= 0) owners.splice(at, 1)
    if (!owners.length) window.removeEventListener('keydown', onCardFocusKey, true)
  }
}

export function useTypingDeferredFocus(
  cardRef: RefObject<HTMLElement | null>,
  key: string | null | undefined,
  focusTarget: (card: HTMLElement) => HTMLElement,
  autoFocus: boolean
): boolean {
  const [deferred, setDeferred] = useState(false)
  const targetRef = useRef(focusTarget)
  targetRef.current = focusTarget

  useEffect(() => {
    const card = cardRef.current
    if (!key || !card) {
      setDeferred(false)
      return
    }
    if (shouldDeferCardFocus(typingSnapshot(card))) {
      setDeferred(true)
      return
    }
    setDeferred(false)
    if (autoFocus) targetRef.current(card).focus({ preventScroll: true })
  }, [cardRef, key, autoFocus])

  useEffect(() => {
    const card = cardRef.current
    if (!deferred || !card) return undefined
    const release = claimCardFocusKey(() => {
      const target = targetRef.current(card)
      target.scrollIntoView({ block: 'nearest' })
      target.focus({ preventScroll: true })
    })
    const onFocusIn = (): void => setDeferred(false)
    card.addEventListener('focusin', onFocusIn)
    return () => {
      release()
      card.removeEventListener('focusin', onFocusIn)
    }
  }, [cardRef, deferred])

  return deferred
}
