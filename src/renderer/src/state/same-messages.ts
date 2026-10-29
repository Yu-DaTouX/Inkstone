import { dequal } from 'dequal'

export function reuseIfSame<T>(prev: readonly T[], next: readonly T[]): readonly T[] {
  if (prev === next) return prev
  let allSame = prev.length === next.length
  const merged = next.map((item, i) => {
    if (i < prev.length && dequal(prev[i], item)) return prev[i]
    allSame = false
    return item
  })
  return allSame ? prev : merged
}
