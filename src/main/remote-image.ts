import { pick } from '../shared/ui-lang'
import { isLinkLocalHost, isPrivateHost } from './browser/network-boundary'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { isPrivateAddress, resolvesToPrivateAddress } from './browser/network-policy'
import type { RemoteImageResult } from '../shared/ipc'

export const REMOTE_IMAGE_MAX_BYTES = 15 * 1024 * 1024
export const REMOTE_IMAGE_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 4
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i

export type { RemoteImageResult }

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>

const resolveAllAddresses: AddressResolver = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))))

export function createPinnedFetch(resolveAll: AddressResolver = resolveAllAddresses, isPrivate: (address: string) => boolean = isPrivateAddress): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(hostname) && isPrivate(hostname)) throw new Error(pick('目标地址在内网', 'Target address is on a private network'))
    const lookup = (name: string, options: { all?: boolean }, callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void): void => {
      resolveAll(name).then((addresses) => {
        if (!addresses.length || addresses.some((item) => isPrivate(item.address))) return callback(new Error(pick('目标地址在内网', 'Target address is on a private network')))
        if (options.all) return callback(null, addresses)
        return callback(null, addresses[0].address, addresses[0].family)
      }, (error: Error) => callback(error))
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = { 'accept-encoding': 'identity', ...Object.fromEntries(new Headers(init?.headers).entries()) }
    return new Promise<Response>((resolve, reject) => {
      const req = send(url, { method: 'GET', headers, lookup: lookup as never, signal: init?.signal ?? undefined }, (res: IncomingMessage) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
          else if (value !== undefined) responseHeaders.set(name, value)
        }
        const status = res.statusCode ?? 502
        const bodyless = status < 200 || status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400)
        if (bodyless) res.resume()
        resolve(new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: responseHeaders }))
      })
      req.on('error', reject)
      req.end()
    })
  }) as typeof fetch
}

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
  const fetchImpl = deps.fetchImpl ?? createPinnedFetch()
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
