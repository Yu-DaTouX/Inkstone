export type FocusModality = 'pointer' | 'keyboard'

const NAVIGATION_KEYS = new Set(['Tab', 'F6'])
const CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)
}

export function modalityForKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>): FocusModality | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (NAVIGATION_KEYS.has(event.key)) return 'keyboard'
  if (CARET_KEYS.has(event.key) && !isTextEntry(event.target)) return 'keyboard'
  return null
}

export function installFocusModality(root: HTMLElement = document.documentElement): () => void {
  const set = (modality: FocusModality): void => {
    if (root.dataset.focusModality !== modality) root.dataset.focusModality = modality
  }
  const onPointer = (): void => set('pointer')
  const onKey = (event: KeyboardEvent): void => {
    const next = modalityForKey(event)
    if (next) set(next)
  }
  set('pointer')
  window.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('keydown', onKey, true)
  return () => {
    window.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('keydown', onKey, true)
  }
}
