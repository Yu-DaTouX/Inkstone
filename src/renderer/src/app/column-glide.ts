import { useEffect, type RefObject } from 'react'

const TARGETS = '.v3-stream > :first-child, .v3-composer > :first-child, .v3-sessionbar'
const MIN_SHIFT = 8

function shiftOf(el: HTMLElement): number {
  const value = getComputedStyle(el).translate
  return value && value !== 'none' ? Number.parseFloat(value) || 0 : 0
}

function layoutLeft(el: HTMLElement): number {
  const probe = el.parentElement?.classList.contains('v3-composer') || el.classList.contains('v3-sessionbar') ? el : el.querySelector<HTMLElement>('.v3-stream-row') ?? el
  const padding = Number.parseFloat(getComputedStyle(probe).paddingLeft) || 0
  return probe.getBoundingClientRect().left - shiftOf(el) + padding
}

function motion(): { duration: number; easing: string } | null {
  const root = document.documentElement
  if (root.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  if (root.matches('[data-window-resizing], [data-rp-dragging], [data-splitter-dragging]')) return null
  const style = getComputedStyle(root)
  const raw = style.getPropertyValue('--panel-dur').trim() || style.getPropertyValue('--dur-sheet').trim()
  const duration = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : Number.NaN
  if (!(duration > 0)) return null
  return { duration, easing: style.getPropertyValue('--ease-inout').trim() || 'ease-in-out' }
}

export function useColumnGlide(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const chat = ref.current
    if (!active || !chat) return undefined
    const last = new WeakMap<HTMLElement, number>()
    const running = new WeakMap<HTMLElement, Animation>()
    const sync = (animate: boolean): void => {
      const glide = animate ? motion() : null
      for (const el of chat.querySelectorAll<HTMLElement>(TARGETS)) {
        const before = last.get(el)
        const shift = shiftOf(el)
        const now = layoutLeft(el)
        last.set(el, now)
        if (!glide || before === undefined) continue
        const dx = before + shift - now
        if (Math.abs(dx) < MIN_SHIFT) continue
        if (el.classList.contains('v3-sessionbar') && dx <= 0) {
          running.get(el)?.cancel()
          continue
        }
        running.get(el)?.cancel()
        running.set(el, el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: glide.duration, easing: glide.easing }))
      }
    }
    let idle = 0
    const record = (): void => {
      if (idle) return
      idle = requestIdleCallback(() => {
        idle = 0
        sync(false)
      }, { timeout: 500 })
    }
    sync(false)
    const resize = new ResizeObserver(() => sync(true))
    resize.observe(chat)
    const attributes = new MutationObserver(() => sync(true))
    attributes.observe(chat, { attributes: true, attributeFilter: ['style', 'data-bar-reserve', 'data-sessionbar', 'data-outline', 'data-single'] })
    const children = new MutationObserver(record)
    children.observe(chat, { childList: true, subtree: true })
    return () => {
      resize.disconnect()
      attributes.disconnect()
      children.disconnect()
      if (idle) cancelIdleCallback(idle)
    }
  }, [ref, active])
}
