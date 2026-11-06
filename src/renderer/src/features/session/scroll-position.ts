import type { ReadingAnchor, ScrollMetrics } from './scroll-follow'

export interface ScrollSnapshot {
  top: number
  bottom: boolean
  anchor: ReadingAnchor | null
}

const STORAGE_KEY = 'yan.scroll-snapshots'
const SNAPSHOT_LIMIT = 32

function loadSnapshots(): Map<string, ScrollSnapshot> {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(STORAGE_KEY)
    const entries = raw ? (JSON.parse(raw) as [string, ScrollSnapshot][]) : []
    return new Map(entries.slice(-SNAPSHOT_LIMIT))
  } catch {
    return new Map()
  }
}

const snapshots = loadSnapshots()
let persistTimer: ReturnType<typeof setTimeout> | undefined

function writeSnapshots(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = undefined
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...snapshots]))
  } catch {
    return
  }
}

function persistSnapshots(): void {
  if (persistTimer !== undefined) return
  persistTimer = setTimeout(writeSnapshots, 300)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (persistTimer !== undefined) writeSnapshots() })

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
  persistSnapshots()
}

export function domMetrics(el: HTMLElement): ScrollMetrics {
  return { offset: el.scrollTop, size: el.scrollHeight, viewport: el.clientHeight }
}

const BLOCK_DEPTH = 6

function blockAnchor(turn: HTMLElement, base: number): { path: number[]; sub: number } {
  const path: number[] = []
  let current: HTMLElement = turn
  while (path.length < BLOCK_DEPTH) {
    let found = -1
    const kids = current.children
    for (let index = 0; index < kids.length; index += 1) {
      const rect = kids[index].getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > base) {
        found = index
        break
      }
    }
    if (found < 0) break
    const kid = kids[found]
    if (!(kid instanceof HTMLElement)) break
    path.push(found)
    current = kid
    if (kid.getBoundingClientRect().top >= base) break
  }
  return { path, sub: base - current.getBoundingClientRect().top }
}

export function resolveAnchorPoint(turn: HTMLElement, anchor: ReadingAnchor): number | null {
  if (!anchor.path || anchor.sub === undefined) return null
  let current: HTMLElement = turn
  for (const index of anchor.path) {
    const kid = current.children[index]
    if (!(kid instanceof HTMLElement)) return null
    current = kid
  }
  return current.getBoundingClientRect().top + anchor.sub
}

export function domReadingAnchors(box: HTMLElement): { snapshot: ReadingAnchor | null; resize: ReadingAnchor | null } {
  const base = box.getBoundingClientRect().top
  let snapshot: ReadingAnchor | null = null
  let resize: ReadingAnchor | null = null
  let containing: ReadingAnchor | null = null
  for (const node of box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')) {
    const turnId = node.dataset.turnId
    if (!turnId) continue
    const rect = node.getBoundingClientRect()
    if (!snapshot && rect.bottom > base) {
      const block = blockAnchor(node, base)
      snapshot = { turnId, offset: Math.max(0, base - rect.top), path: block.path, sub: block.sub }
      containing = { turnId, offset: rect.top - base, path: block.path, sub: block.sub }
    }
    if (!resize && rect.top - base >= -1) resize = { turnId, offset: rect.top - base }
    if (snapshot && resize) break
  }
  if (containing && (!resize || resize.offset > box.clientHeight)) resize = containing
  return { snapshot, resize }
}

export function domAnchor(box: HTMLElement): ReadingAnchor | null {
  return domReadingAnchors(box).snapshot
}

export function restoreDomScroll(box: HTMLElement, snapshot: ScrollSnapshot | undefined): void {
  const anchor = snapshot?.anchor
  const node = anchor ? [...box.querySelectorAll<HTMLElement>('.v3-msg[data-turn-id]')].find((el) => el.dataset.turnId === anchor.turnId) : undefined
  if (!snapshot || snapshot.bottom) box.scrollTop = box.scrollHeight
  else if (anchor && node) {
    const point = resolveAnchorPoint(node, anchor)
    box.scrollTop = Math.max(0, point === null
      ? node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + anchor.offset
      : point - box.getBoundingClientRect().top + box.scrollTop)
  }
  else box.scrollTop = snapshot.top
}

export interface SettleAnchor {
  node: HTMLElement
  top: number
}

function readingNodeAnchor(box: HTMLElement): SettleAnchor | null {
  const rect = box.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(48, rect.height / 4))
  if (!(hit instanceof HTMLElement) || hit === box || !box.contains(hit)) return null
  const node = hit.closest<HTMLElement>('[data-testid="v3-process"]') ?? hit
  return { node, top: node.getBoundingClientRect().top - rect.top }
}

export function settleAnchor(box: HTMLElement, following = true): SettleAnchor | null {
  if (!following) {
    const reading = readingNodeAnchor(box)
    if (reading) return reading
  }
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

export interface GlideMotion {
  speed: number
  peak: number
  accel: number
}

export const GLIDE_FRAME_CAP_MS = 20
const GLIDE_FRAME_MS = 1000 / 60
const GLIDE_VIEWPORT_STEP = 0.6
const GLIDE_MIN_SPEED = 0.06

export function startGlide(distance: number, duration: (distance: number) => number, viewport: number): GlideMotion {
  const ms = Math.max(1, duration(distance))
  const cap = Math.max(1, viewport * GLIDE_VIEWPORT_STEP) / GLIDE_FRAME_MS
  const peak = Math.min(cap, Math.max(GLIDE_MIN_SPEED, (distance * 1.5) / ms))
  return { speed: 0, peak, accel: peak / (ms / 3) }
}

export function advanceGlide(motion: GlideMotion, remaining: number, dt: number): { motion: GlideMotion; move: number; done: boolean } {
  if (remaining <= 0.5) return { motion: { ...motion, speed: 0 }, move: remaining, done: true }
  const braking = Math.sqrt(2 * motion.accel * remaining)
  const speed = Math.max(GLIDE_MIN_SPEED, Math.min(motion.speed + motion.accel * dt, motion.peak, braking))
  return { motion: { ...motion, speed }, move: Math.min(remaining, speed * dt), done: false }
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
