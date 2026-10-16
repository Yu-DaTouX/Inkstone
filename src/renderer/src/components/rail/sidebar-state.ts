import { useEffect, useState } from 'react'

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
    try { localStorage.setItem(`yan.sidebar.${key}`, JSON.stringify(value)) } catch { }
  }, [key, value])
  return [value, setValue] as const
}

export function useSidebarJson<T extends object>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(`yan.sidebar.${key}`) ?? 'null')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : fallback
    } catch {
      return fallback
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`yan.sidebar.${key}`, JSON.stringify(value))
    } catch {
    }
  }, [key, value])
  return [value, setValue] as const
}

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
