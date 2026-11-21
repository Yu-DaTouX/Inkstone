import { MessageCache } from './message-cache'

type Entry<T> = { pending: Promise<T | null> } | { result: T | null; expiresAt: number }

export function createMarkdownPathCache<T>(maxEntries = 2_000, maxChars = 512_000, now = Date.now) {
  const entries = new MessageCache<Entry<T>>(maxEntries, maxChars)
  const get = (key: string): T | null | Promise<T | null> | undefined => {
    const hit = entries.get(key)
    if (!hit) return undefined
    if ('pending' in hit) return hit.pending
    if (hit.result !== null || now() < hit.expiresAt) return hit.result
    entries.delete(key)
    return undefined
  }
  return {
    get,
    load(key: string, stat: () => Promise<T | null>, resultChars: (result: T) => number): Promise<T | null> {
      const hit = get(key)
      if (hit !== undefined) return Promise.resolve(hit)
      const pending = stat().then((result) => {
        if (entries.peek(key) === entry) {
          entries.set(key, { result, expiresAt: result === null ? now() + 3_000 : 0 }, result === null ? 0 : resultChars(result))
        }
        return result
      }, (error: unknown) => {
        if (entries.peek(key) === entry) entries.delete(key)
        throw error
      })
      const entry = { pending }
      entries.set(key, entry)
      return pending
    }
  }
}
