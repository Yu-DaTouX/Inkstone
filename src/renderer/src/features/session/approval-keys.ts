export type ApprovalKeyChoice = 'once' | 'deny'

export const APPROVAL_ARM_MS = 400

export interface ApprovalArming {
  arm(id: string | null | undefined): void
  isArmed(id: string | null | undefined): boolean
}

export function createApprovalArming(clock: () => number = () => Date.now()): ApprovalArming {
  let current: { id: string; at: number } | null = null
  return {
    arm(id) {
      if (!id) {
        current = null
        return
      }
      if (current?.id === id) return
      current = { id, at: clock() }
    },
    isArmed(id) {
      if (!id || current?.id !== id) return false
      return clock() - current.at >= APPROVAL_ARM_MS
    }
  }
}

export function isApprovingChoice(choice: string): boolean {
  return choice !== 'deny'
}

export interface ReadGateRequest {
  kind: string
  tool?: string
  danger?: string
}

const DANGEROUS_KINDS: ReadonlySet<string> = new Set(['danger', 'delete', 'outside'])
const DANGEROUS_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])

export function requiresApprovalReadGate(request: ReadGateRequest): boolean {
  if (request.danger) return true
  if (DANGEROUS_KINDS.has(request.kind)) return true
  return request.kind === 'permission' && !!request.tool && DANGEROUS_TOOLS.has(request.tool)
}

export function isApprovalDetailRead(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  if (!(metrics.scrollHeight > 0)) return true
  if (metrics.scrollHeight <= metrics.clientHeight) return true
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 2
}

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
