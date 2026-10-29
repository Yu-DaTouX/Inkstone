import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isPrivateAddress } from '../browser/network-policy'
import { normalizeReadUrl, ReadPageError } from './page-types'

export interface PublicResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Uint8Array
}

type Address = { address: string; family: number }
interface PublicPageDeps {
  resolve(host: string): Promise<Address[]>
  open(url: URL, addresses: Address[], signal: AbortSignal, options: PublicPageOptions): Promise<PublicResponse>
}

export interface PublicPageOptions {
  maxBytes?: number
  accept?: string
}

const MAX_BYTES = 12 * 1024 * 1024
const defaults: PublicPageDeps = {
  resolve: (host) => lookup(host, { all: true, verbatim: true }),
  open: (url, addresses, signal, options) => new Promise((resolve, reject) => {
    const address = addresses[0]
    const maxBytes = Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES)
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', signal, agent: false,
      family: address.family,
      headers: { Accept: options.accept ?? 'text/html,application/pdf,text/plain,text/markdown;q=0.9,*/*;q=0.1', 'User-Agent': 'Inkstone/0.12 WebReader', 'Accept-Encoding': 'identity' },
      lookup: (_host, _options, done) => done(null, address.address, address.family)
    }, (res) => {
      if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(new ReadPageError('too_large', '响应超过读取大小上限')); return }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: new Uint8Array() }); return }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxBytes) { res.destroy(new ReadPageError('too_large', '响应超过读取大小上限')); return }
        chunks.push(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
      res.on('aborted', () => reject(new ReadPageError('network_error', '网页响应中途断开')))
    })
    req.on('error', reject)
    req.end()
  })
}

export async function fetchPublicPage(rawUrl: string, signal: AbortSignal, deps: PublicPageDeps = defaults, options: PublicPageOptions = {}) {
  let current = normalizeReadUrl(rawUrl)
  for (let hop = 0; hop < 6; hop++) {
    signal.throwIfAborted()
    const url = new URL(current)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    let addresses: Address[]
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([deps.resolve(host), cancelled]) }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
    signal.throwIfAborted()
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new ReadPageError('private_host', '网址解析到本机或内网地址，已停止读取')
    const response = await deps.open(url, addresses, signal, options)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (typeof location !== 'string') throw new ReadPageError('http_error', '网页重定向缺少目标地址')
      current = normalizeReadUrl(new URL(location, current).href)
      continue
    }
    if (response.status < 200 || response.status >= 300) throw new ReadPageError('http_error', `网页返回 HTTP ${response.status}，未取得正文`)
    if (response.body.byteLength > Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES)) throw new ReadPageError('too_large', '响应超过读取大小上限')
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
    return { ...response, finalUrl: current, contentType }
  }
  throw new ReadPageError('redirect_limit', '网页重定向次数过多')
}
