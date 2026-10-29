export function isComposingKey(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229
}

export function annotationKeyAction(event: {
  key: string
  shiftKey: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}): 'submit' | 'cancel' | null {
  if (isComposingKey(event)) return null
  if (event.key === 'Escape') return 'cancel'
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey) return 'submit'
  return null
}
