export interface DigitKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  defaultPrevented?: boolean
  isComposing?: boolean
  target: EventTarget | null
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  return !!el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
}

const owners: symbol[] = []

export function claimDigitKeys(): { owns: () => boolean; release: () => void } {
  const token = Symbol('digit-owner')
  owners.push(token)
  return {
    owns: () => owners[owners.length - 1] === token,
    release: () => {
      const at = owners.indexOf(token)
      if (at >= 0) owners.splice(at, 1)
    }
  }
}

export function digitChoiceIndex(event: DigitKeyEvent, count: number): number | null {
  if (event.defaultPrevented || event.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  const index = Number(event.key) - 1
  if (index >= count) return null
  if (isTextEntry(event.target)) return null
  return index
}
