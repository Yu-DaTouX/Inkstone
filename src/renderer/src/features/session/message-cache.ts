export class MessageCache<T> {
  private readonly entries = new Map<string, { value: T; chars: number }>()
  private chars = 0

  constructor(private readonly maxEntries: number, private readonly maxChars: number) {}

  peek(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  set(key: string, value: T, valueChars = 0): void {
    const chars = key.length + valueChars
    this.delete(key)
    if (chars > this.maxChars) return
    this.entries.set(key, { value, chars })
    this.chars += chars
    while (this.entries.size > this.maxEntries || this.chars > this.maxChars) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.delete(oldest.value)
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.chars -= entry.chars
    this.entries.delete(key)
  }
}

export function createFailedImageCache() {
  const entries = new MessageCache<true>(256, 128_000)
  return {
    has: (src: string) => entries.get(src) === true,
    add: (src: string) => { if (src.length <= 4_096) entries.set(src, true) },
    delete: (src: string) => entries.delete(src)
  }
}

export function createRemoteImageCache() {
  const entries = new MessageCache<string>(32, 16_000_000)
  return {
    get: (src: string) => entries.get(src),
    set: (src: string, dataUrl: string) => entries.set(src, dataUrl, dataUrl.length)
  }
}
