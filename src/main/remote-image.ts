import { isLinkLocalHost, isPrivateHost } from './browser/network-boundary'
import { resolvesToPrivateAddress } from './browser/network-policy'
import type { RemoteImageResult } from '../shared/ipc'

export const REMOTE_IMAGE_MAX_BYTES = 15 * 1024 * 1024
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 4
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i

export type { RemoteImageResult }

export interface RemoteImageGate {
  peek(sessionId: string, url: string): string
  check(sessionId: string, url: string): Promise<string>
}

export interface RemoteImageDeps {
  gate: RemoteImageGate | null
  fetchImpl?: typeof fetch
  isPrivate?: (hostname: string) => Promise<boolean>
}

export function remoteImageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

async function blockedHost(url: URL, isPrivate: (hostname: string) => Promise<boolean>): Promise<boolean> {
  if (isPrivateHost(url.hostname) || isLinkLocalHost(url.hostname)) return true
  return isPrivate(url.hostname)
}

async function readCapped(response: Response, max: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) return null
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

export async function fetchRemoteImage(deps: RemoteImageDeps, sessionId: string, rawUrl: unknown, prompt: boolean): Promise<RemoteImageResult> {
  const url = remoteImageUrl(rawUrl)
  if (!url) return { ok: false, code: 'bad-url' }
  const gate = deps.gate
  if (!gate) return { ok: false, code: 'denied' }
  const href = url.toString()
  const decision = prompt ? await gate.check(sessionId, href) : gate.peek(sessionId, href)
  if (decision === 'ask') return { ok: false, code: 'needs-consent' }
  if (decision !== 'allow') return { ok: false, code: 'denied' }
  const isPrivate = deps.isPrivate ?? resolvesToPrivateAddress
  const fetchImpl = deps.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS)
  let current = url
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (await blockedHost(current, isPrivate)) return { ok: false, code: 'private-host' }
      const response = await fetchImpl(current.toString(), { redirect: 'manual', signal, headers: { accept: 'image/*' } })
      if (response.status >= 300 && response.status < 400) {
        const next = remoteImageUrl(new URL(response.headers.get('location') ?? '', current).toString())
        if (!next) return { ok: false, code: 'bad-url' }
        current = next
        continue
      }
      if (!response.ok) return { ok: false, code: 'http', error: String(response.status) }
      const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (!IMAGE_TYPES.test(type)) return { ok: false, code: 'not-image', error: type }
      const body = await readCapped(response, REMOTE_IMAGE_MAX_BYTES)
      if (!body) return { ok: false, code: 'too-large' }
      return { ok: true, dataUrl: `data:${type};base64,${body.toString('base64')}`, bytes: body.byteLength }
    }
    return { ok: false, code: 'http', error: 'too many redirects' }
  } catch (error) {
    return signal.aborted ? { ok: false, code: 'timeout' } : { ok: false, code: 'network', error: String((error as Error)?.message ?? error) }
  }
}
