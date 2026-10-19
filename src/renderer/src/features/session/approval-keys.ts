export type ApprovalKeyChoice = 'once' | 'deny'

export interface KeyLike {
  key: string
  isComposing?: boolean
  keyCode?: number
}

export interface ShortcutKeyEvent extends KeyLike {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
}

export function isComposingEvent(event: KeyLike): boolean {
  return event.isComposing === true || event.keyCode === 229
}

export function isActivationKey(event: KeyLike): boolean {
  if (isComposingEvent(event)) return false
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

export function classifyApprovalShortcut(
  event: ShortcutKeyEvent,
  modalOpen: boolean
): ApprovalKeyChoice | null {
  if (modalOpen) return null
  if (event.repeat) return null
  if (isComposingEvent(event)) return null
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'y') return 'once'
  if (key === 'n') return 'deny'
  return null
}

export function isApprovalCommitKey(
  event: ShortcutKeyEvent & { shiftKey?: boolean },
  context: { modalOpen: boolean; insideCard: boolean; editableFocus: boolean }
): boolean {
  if (context.modalOpen) return false
  if (event.repeat || isComposingEvent(event)) return false
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false
  if (!event.ctrlKey && !event.metaKey) return false
  return context.insideCard || !context.editableFocus
}

export function isEditableElement(element: Element | null | undefined): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (element as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return (element as HTMLElement).isContentEditable === true
}

export function allowsPointerPress(pointerType: string | null | undefined): boolean {
  return pointerType !== 'keyboard'
}

export function ownsApproval(
  approvals: ReadonlyArray<{ id: string }> | undefined,
  id: string | null | undefined
): boolean {
  return !!id && approvals?.[0]?.id === id
}

export interface ApprovalGate {
  begin(id: string): boolean
  release(id: string): void
  hasPending(): boolean
}

export function createApprovalGate(): ApprovalGate {
  const inflight = new Set<string>()
  return {
    begin(id) {
      if (!id || inflight.has(id)) return false
      inflight.add(id)
      return true
    },
    release(id) {
      inflight.delete(id)
    },
    hasPending() {
      return inflight.size > 0
    }
  }
}
