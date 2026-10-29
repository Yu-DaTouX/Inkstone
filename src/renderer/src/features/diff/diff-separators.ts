import type { DiffViewText } from './text'

type SeparatorText = Pick<DiffViewText, 'unmodified' | 'moreContext' | 'expandUp' | 'expandDown' | 'expandBoth' | 'expandAll'>

interface PendingFocus {
  index: string
  direction: string
  at: number
}

const FOCUS_RESTORE_MS = 8000

const wired = new WeakSet<ShadowRoot>()
const utilityLabels = new WeakMap<ShadowRoot, string>()
const pending = new WeakMap<ShadowRoot, PendingFocus>()

function buttonDirection(button: Element): string {
  if (button.hasAttribute('data-expand-all-button')) return 'all'
  if (button.hasAttribute('data-expand-up')) return 'up'
  if (button.hasAttribute('data-expand-down')) return 'down'
  return 'both'
}

function separatorCount(separator: Element): number | null {
  const match = /\d+/.exec(separator.querySelector('[data-unmodified-lines]')?.textContent ?? '')
  return match ? Number(match[0]) : null
}

function setText(node: Element | null, value: string): void {
  if (node && node.textContent !== value) node.textContent = value
}

function buttonLabel(direction: string, count: number | null, single: boolean, text: SeparatorText): string {
  if (direction === 'all') return text.expandAll
  if (!single && direction === 'up') return text.expandUp
  if (!single && direction === 'down') return text.expandDown
  return count === null ? text.moreContext : text.expandBoth(count)
}

function wire(root: ShadowRoot, host: HTMLElement): void {
  if (wired.has(root)) return
  wired.add(root)
  root.addEventListener('focusin', (event) => {
    const utility = (event.target as Element | null)?.closest?.('[data-utility-button]')
    const label = utilityLabels.get(root)
    if (utility && label) utility.setAttribute('aria-label', label)
  })
  root.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key !== 'Enter' && key !== ' ') return
    const button = (event.target as Element | null)?.closest?.('[data-expand-button]')
    const separator = button?.closest('[data-separator]')
    if (!button || !separator) return
    event.preventDefault()
    event.stopPropagation()
    pending.set(root, { index: separator.getAttribute('data-expand-index') ?? '', direction: buttonDirection(button), at: Date.now() })
    ;(button as HTMLElement).click()
    requestAnimationFrame(() => restoreFocus(root, host))
  })
}

function restoreFocus(root: ShadowRoot, host: HTMLElement): void {
  const target = pending.get(root)
  if (!target) return
  if (Date.now() - target.at > FOCUS_RESTORE_MS) {
    pending.delete(root)
    return
  }
  if (root.activeElement?.isConnected && root.activeElement.closest('[data-expand-button]')) return
  if (root.activeElement?.isConnected || (document.activeElement && document.activeElement !== document.body && document.activeElement !== host)) {
    pending.delete(root)
    return
  }
  const buttons = [...root.querySelectorAll<HTMLElement>(`[data-separator][data-expand-index="${target.index}"] [data-expand-button]`)]
  const visible = buttons.filter((button) => button.getClientRects().length > 0)
  const next = visible.find((button) => buttonDirection(button) === target.direction) ?? visible[0]
  if (next) {
    next.focus()
    return
  }
  const fallback = host.closest<HTMLElement>('[data-diff-keys]')
  if (fallback) {
    fallback.focus()
    pending.delete(root)
  }
}

export function enhanceSeparators(host: HTMLElement, text: SeparatorText, utilityLabel?: string): void {
  const root = host.shadowRoot
  if (!root) return
  wire(root, host)
  if (utilityLabel) utilityLabels.set(root, utilityLabel)
  for (const separator of root.querySelectorAll('[data-separator="line-info"], [data-separator="line-info-basic"]')) {
    const count = separatorCount(separator)
    for (const label of separator.querySelectorAll('[data-unmodified-lines]')) {
      setText(label, count === null ? text.moreContext : text.unmodified(count))
    }
    const buttons = [...separator.querySelectorAll<HTMLElement>('[data-expand-button]')]
    const single = buttons.filter((button) => buttonDirection(button) !== 'all').length <= 1
    for (const button of buttons) {
      const direction = buttonDirection(button)
      if (direction === 'all') setText(button, text.expandAll)
      if (button.getAttribute('tabindex') !== '0') button.setAttribute('tabindex', '0')
      button.setAttribute('role', 'button')
      button.setAttribute('aria-label', buttonLabel(direction, count, single, text))
    }
  }
  for (const utility of root.querySelectorAll('[data-utility-button]')) {
    if (utilityLabel) utility.setAttribute('aria-label', utilityLabel)
  }
  if (pending.has(root)) restoreFocus(root, host)
}
