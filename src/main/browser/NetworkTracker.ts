import type { BrowserNetworkEntry, BrowserNetworkSnapshot } from '../../shared/ipc'
import type { CdpChannel } from './CdpChannel'

const LIMIT = 80
const MAX_URL_LENGTH = 2_048

/**
 * A bounded, read-only network ledger. It deliberately drops query strings,
 * fragments, credentials, request/response headers, bodies, and cookie data.
 */
export class NetworkTracker {
  private readonly entries = new Map<string, BrowserNetworkEntry>()
  private started = false

  constructor(private readonly cdp: CdpChannel) {}

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.cdp.on('Network.requestWillBeSent', (params, sessionId) => {
      const request = params.request as Record<string, unknown> | undefined
      const requestId = String(params.requestId ?? '')
      if (!requestId || !request) return
      this.put(requestId, {
        url: safeNetworkUrl(request.url),
        method: safeMethod(request.method),
        resourceType: safeResourceType(params.type),
        state: 'pending'
      }, sessionId)
    })
    this.cdp.on('Network.responseReceived', (params, sessionId) => {
      const id = scopedId(params.requestId, sessionId)
      const prior = this.entries.get(id)
      const response = params.response as Record<string, unknown> | undefined
      if (!prior || !response) return
      const status = Number(response.status)
      this.entries.set(id, {
        ...prior,
        status: Number.isFinite(status) ? status : undefined,
        resourceType: safeResourceType(params.type) || prior.resourceType
      })
    })
    this.cdp.on('Network.loadingFinished', (params, sessionId) => this.finish(params, sessionId, 'finished'))
    this.cdp.on('Network.loadingFailed', (params, sessionId) => this.finish(params, sessionId, 'failed'))
    await this.cdp.send('Network.enable').catch(() => undefined)
  }

  snapshot(): BrowserNetworkSnapshot {
    return { capturedAt: Date.now(), entries: [...this.entries.values()].slice(-LIMIT), limit: LIMIT }
  }

  private put(requestId: string, entry: BrowserNetworkEntry, sessionId?: string): void {
    this.entries.set(scopedId(requestId, sessionId), entry)
    while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value as string)
  }

  private finish(params: Record<string, unknown>, sessionId: string | undefined, state: 'finished' | 'failed'): void {
    const id = scopedId(params.requestId, sessionId)
    const prior = this.entries.get(id)
    if (prior) this.entries.set(id, { ...prior, state })
  }
}

function scopedId(requestId: unknown, sessionId?: string): string {
  return `${sessionId ?? 'root'}:${String(requestId ?? '')}`
}

function safeNetworkUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ''))
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const safe = url.toString()
    return safe.length <= MAX_URL_LENGTH ? safe : `${safe.slice(0, MAX_URL_LENGTH - 1)}…`
  } catch {
    return ''
  }
}

function safeMethod(value: unknown): string {
  return /^[A-Z]{1,12}$/i.test(String(value ?? '')) ? String(value).toUpperCase() : 'OTHER'
}

function safeResourceType(value: unknown): string | undefined {
  const type = String(value ?? '')
  return /^(Document|Stylesheet|Image|Media|Font|Script|TextTrack|XHR|Fetch|Prefetch|EventSource|WebSocket|Manifest|Other)$/.test(type)
    ? type
    : undefined
}
