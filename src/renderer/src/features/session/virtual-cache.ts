import type { CacheSnapshot } from 'virtua'

export function virtualizeSession(wasVirtual: boolean, turns: number, messages: number): boolean {
  const scale = wasVirtual ? 0.8 : 1
  return turns > 80 * scale || messages > 200 * scale
}

const LIMIT = 16
interface Measurements {
  ids: readonly string[]
  width: number
  cache: CacheSnapshot
}
const measurements = new Map<string, Measurements>()

export function readVirtualCache(identity: string, ids: readonly string[], width: number): CacheSnapshot | undefined {
  const saved = measurements.get(identity)
  if (!saved || Math.abs(saved.width - width) > 1 || saved.ids.length !== ids.length || saved.ids.some((id, index) => id !== ids[index])) return undefined
  return saved.cache
}

export function saveVirtualCache(identity: string, ids: readonly string[], width: number, cache: CacheSnapshot): void {
  if (!identity || width <= 0 || !ids.length || cache[0].length !== ids.length) return
  measurements.delete(identity)
  measurements.set(identity, { ids: [...ids], width, cache })
  while (measurements.size > LIMIT) measurements.delete(measurements.keys().next().value!)
}
