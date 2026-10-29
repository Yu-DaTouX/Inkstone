import { pickReadingAnchor, type ReadingAnchor, type ScrollMetrics } from './scroll-follow'

export interface ScrollSnapshot {
  top: number
  bottom: boolean
  anchor: ReadingAnchor | null
}

const snapshots = new Map<string, ScrollSnapshot>()
const SNAPSHOT_LIMIT = 32

function scrollKey(identity: string): string {
  const key = identity.replace(/\\/g, '/')
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key
}

export function readScrollSnapshot(identity: string): ScrollSnapshot | undefined {
  return snapshots.get(scrollKey(identity))
}

export function saveScrollSnapshot(identity: string, snapshot: ScrollSnapshot): void {
  if (!identity) return
  const key = scrollKey(identity)
  snapshots.delete(key)
  snapshots.set(key, snapshot.bottom ? { ...snapshot, anchor: null } : snapshot)
  while (snapshots.size > SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) break
    snapshots.delete(oldest)
  }
}

export function domMetrics(el: HTMLElement): ScrollMetrics {
  return { offset: el.scrollTop, size: el.scrollHeight, viewport: el.clientHeight }
}

export function domAnchor(box: HTMLElement): ReadingAnchor | null {
  const base = box.getBoundingClientRect().top
  const rows = [...box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].map((node) => {
    const rect = node.getBoundingClientRect()
    return { id: node.dataset.turnId ?? '', top: rect.top - base, bottom: rect.bottom - base }
  })
  return pickReadingAnchor(rows.filter((row) => row.id), 0)
}

export function restoreDomScroll(box: HTMLElement, snapshot: ScrollSnapshot | undefined): void {
  const anchor = snapshot?.anchor
  const node = anchor ? [...box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].find((el) => el.dataset.turnId === anchor.turnId) : undefined
  if (!snapshot || snapshot.bottom) box.scrollTop = box.scrollHeight
  else if (anchor && node) box.scrollTop = Math.max(0, node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + anchor.offset)
  else box.scrollTop = snapshot.top
}

export interface SettleAnchor {
  node: HTMLElement
  top: number
}

export function settleAnchor(box: HTMLElement): SettleAnchor | null {
  const turns = box.querySelectorAll<HTMLElement>('.v3-msg.assistant[data-turn-id]')
  const process = turns[turns.length - 1]?.querySelector<HTMLElement>('[data-testid="v3-process"]')
  const node = process?.nextElementSibling
  if (!(node instanceof HTMLElement)) return null
  const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top
  return top < box.clientHeight ? { node, top } : null
}

export function settleShift(box: HTMLElement, anchor: SettleAnchor): number {
  if (!anchor.node.isConnected) return 0
  return anchor.node.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.top
}

export function keepSettleAnchor(box: HTMLElement, anchor: SettleAnchor): boolean {
  const shift = settleShift(box, anchor)
  if (Math.abs(shift) < 0.5) return false
  box.scrollTop += shift
  return true
}

function motionReduced(): boolean {
  if (document.documentElement.dataset.reduceMotion === 'true') return true
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function glideSettle(anchor: SettleAnchor, shift: number): void {
  if (Math.abs(shift) < 1 || motionReduced() || typeof anchor.node.animate !== 'function') return
  const nodes: HTMLElement[] = [anchor.node]
  for (let node: Element | null = anchor.node; node && !node.classList.contains('v3-msg'); node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next instanceof HTMLElement) nodes.push(next)
    }
  }
  const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-sheet')) || 300
  for (const target of nodes) target.animate([{ transform: `translateY(${-shift}px)` }, { transform: 'none' }], { duration, easing: 'ease-in-out' })
}
