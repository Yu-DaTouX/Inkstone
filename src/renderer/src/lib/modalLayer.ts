import { useEffect, useRef, useState, type RefObject } from 'react'

const stack: symbol[] = []
const subs = new Set<() => void>()

let reported = false

function report(): void {
  const paused = stack.length > 0
  if (paused === reported) return
  reported = paused
  try {
    const bridge = window.yan as unknown as { setHotkeyGuard?: (p: boolean) => void } | undefined
    bridge?.setHotkeyGuard?.(paused)
  } catch {
  }
}

function sync(): void {
  report()
  for (const f of subs) f()
}

export function pushModal(token: symbol): void {
  if (stack.includes(token)) return
  stack.push(token)
  sync()
}

export function popModal(token: symbol): void {
  const i = stack.indexOf(token)
  if (i < 0) return
  stack.splice(i, 1)
  sync()
}

export function isModalOpen(): boolean {
  return stack.length > 0
}

export function useModalCount(): number {
  const [count, setCount] = useState(() => stack.length)
  useEffect(() => {
    const f = (): void => setCount(stack.length)
    subs.add(f)
    f()
    return () => {
      subs.delete(f)
    }
  }, [])
  return count
}

export function isTopModal(token: symbol): boolean {
  return stack[stack.length - 1] === token
}

export function useModalLayer(open: boolean, onClose?: () => void): { isTop: boolean } {
  const tokenRef = useRef<symbol | null>(null)
  if (tokenRef.current === null) tokenRef.current = Symbol('yan-modal')
  const token = tokenRef.current

  const [, force] = useState(0)

  useEffect(() => {
    const f = (): void => force((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    pushModal(token)
    return () => popModal(token)
  }, [open, token])

  const isTop = open && isTopModal(token)

  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!isTop || !closeRef.current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current?.()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [isTop])

  return { isTop }
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex !== -1 &&
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      el.getClientRects().length > 0
  )
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  top: boolean
): void {
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const root = ref.current
    if (!root) return

    const prev = document.activeElement as HTMLElement | null
    restoreRef.current = prev && prev !== document.body && document.contains(prev) ? prev : null

    let cancelInitial: (() => void) | undefined
    if (!root.contains(document.activeElement)) {
      const raf = requestAnimationFrame(() => {
        if (root.contains(document.activeElement)) return
        focusablesIn(root)[0]?.focus()
      })
      cancelInitial = () => cancelAnimationFrame(raf)
    }

    return () => {
      cancelInitial?.()
      const to = restoreRef.current
      restoreRef.current = null
      if (to && document.contains(to) && typeof to.focus === 'function') to.focus()
    }
  }, [ref, open])

  useEffect(() => {
    if (!open || !top) return
    const root = ref.current
    if (!root) return

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const list = focusablesIn(root)
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const cur = document.activeElement as HTMLElement | null
      const inside = !!cur && root.contains(cur)

      if (e.shiftKey) {
        if (!inside || cur === first) {
          e.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || cur === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [ref, open, top])
}
