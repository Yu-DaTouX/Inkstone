export interface ResolvedImage {
  uri: string
  headers?: Record<string, string>
}

const MAX_ENTRIES = 48
const MAX_CHARS = 16_000_000

export class ImageCache {
  private readonly entries = new Map<string, ResolvedImage>()
  private readonly flights = new Map<string, Promise<ResolvedImage>>()
  private chars = 0

  peek(key: string): ResolvedImage | undefined {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit
  }

  load(key: string, fetcher: () => Promise<ResolvedImage>): Promise<ResolvedImage> {
    const hit = this.peek(key)
    if (hit) return Promise.resolve(hit)
    const flying = this.flights.get(key)
    if (flying) return flying
    const task = fetcher().then((resolved) => {
      this.store(key, resolved)
      return resolved
    }).finally(() => this.flights.delete(key))
    this.flights.set(key, task)
    return task
  }

  private store(key: string, resolved: ResolvedImage): void {
    if (resolved.uri.length > MAX_CHARS) return
    const old = this.entries.get(key)
    if (old) this.chars -= old.uri.length
    this.entries.delete(key)
    this.entries.set(key, resolved)
    this.chars += resolved.uri.length
    while (this.entries.size > MAX_ENTRIES || this.chars > MAX_CHARS) {
      const oldest = this.entries.keys().next().value!
      this.chars -= this.entries.get(oldest)!.uri.length
      this.entries.delete(oldest)
    }
  }
}

export const relayImages = new ImageCache()
