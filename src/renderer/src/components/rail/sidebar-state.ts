import { useEffect, useState } from 'react'

/** Small UI preferences only; session contents stay in pi's session files. */
export function useSidebarValue<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(`yan.sidebar.${key}`) ?? 'null')
      if (parsed === null) return fallback
      if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : fallback) as T
      return typeof parsed === typeof fallback ? parsed as T : fallback
    } catch { return fallback }
  })
  useEffect(() => {
    try { localStorage.setItem(`yan.sidebar.${key}`, JSON.stringify(value)) } catch { /* unavailable storage */ }
  }, [key, value])
  return [value, setValue] as const
}

/** Keep ancestors of matches so filtering never turns a branch into a root. */
export function ancestorPaths(path: string, parents: Map<string, string>): string[] {
  const seen = new Set([path])
  const out: string[] = []
  let parent = parents.get(path)
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    out.push(parent)
    parent = parents.get(parent)
  }
  return out
}
