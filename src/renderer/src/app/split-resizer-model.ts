export const MIN_COLUMN = 320

export const KEY_STEP = 8

export const LARGE_KEY_STEP = 32

export interface PairMetrics {
  left: number
  total: number
}

export interface PairBounds {
  min: number
  max: number
}

const usable = (value: number): boolean => Number.isFinite(value) && value > 0

export function measurePair(leftWidth: number, rightWidth: number): PairMetrics {
  const left = usable(leftWidth) ? leftWidth : 0
  const right = usable(rightWidth) ? rightWidth : 0
  return { left, total: left + right }
}

export function samePair(a: PairMetrics | null, b: PairMetrics | null): boolean {
  return !!a && !!b && a.left === b.left && a.total === b.total
}

export function pairBounds(total: number, minColumn: number = MIN_COLUMN): PairBounds {
  if (!usable(total)) return { min: 0, max: 0 }
  if (total < 2 * minColumn) return { min: 0, max: total }
  return { min: minColumn, max: total - minColumn }
}

export function clampPairValue(value: number, bounds: PairBounds): number {
  if (!Number.isFinite(value)) return bounds.min
  if (value < bounds.min) return bounds.min
  if (value > bounds.max) return bounds.max
  return value
}

export function weightsForLeft(leftPx: number, total: number, share: number): { left: number; right: number } {
  const safeShare = usable(share) ? share : 1
  if (!usable(total)) return { left: safeShare / 2, right: safeShare / 2 }
  const at = clampPairValue(leftPx, { min: 0, max: total })
  const left = (safeShare * at) / total
  return { left, right: safeShare - left }
}

export interface MeasuredElement {
  getBoundingClientRect(): { width: number }
}

export interface PairHost {
  previousElementSibling: MeasuredElement | null
  nextElementSibling: MeasuredElement | null
}

export interface PairObserver {
  observe(target: MeasuredElement): void
  disconnect(): void
}

export type PairObserverFactory = (onResize: () => void) => PairObserver

export const createPairObserver: PairObserverFactory = (onResize) =>
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => onResize())
    : { observe: () => {}, disconnect: () => {} }

export function readPair(host: PairHost): PairMetrics | null {
  const a = host.previousElementSibling
  const b = host.nextElementSibling
  if (!a || !b) return null
  return measurePair(a.getBoundingClientRect().width, b.getBoundingClientRect().width)
}

export function bindPairObserver(
  host: PairHost,
  onMeasure: (metrics: PairMetrics) => void,
  createObserver: PairObserverFactory = createPairObserver
): () => void {
  const a = host.previousElementSibling
  const b = host.nextElementSibling
  const read = (): void => {
    const metrics = readPair(host)
    if (metrics) onMeasure(metrics)
  }
  read()
  if (!a || !b) return () => {}
  const observer = createObserver(read)
  observer.observe(a)
  observer.observe(b)
  return () => observer.disconnect()
}
