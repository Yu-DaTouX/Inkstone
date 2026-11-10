import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { isIP } from 'node:net'
import { isLinkLocalAddress, isMetadataAddress } from './address-policy'
import {
  dialLiteral,
  isLocalHostname,
  isPublicAddress,
  PublicPinResolver,
  type PublicPin
} from './pinned-resolver'

export type PinnedRoutePlan =
  | { mode: 'direct' }
  | { mode: 'upstream'; protocol: 'http' | 'https'; host: string; port: number }
  | { mode: 'unsupported'; reason: string }

export interface PinnedProxyOptions {
  resolver?: Pick<PublicPinResolver, 'resolve'>
  connect?: (options: { host: string; port: number }) => Socket
  connectUpstream?: (proxy: { protocol: 'http' | 'https'; host: string; port: number }) => Socket
  routeCheck?: (request: { kind: 'http' | 'connect' | 'upgrade'; url?: string; host: string; port: number }) => Promise<PinnedRoutePlan>
  maxHeaderBytes?: number
  connectTimeoutMs?: number
  onReject?: (reason: string, host: string) => void
}

export interface PinnedProxyAddress {
  host: '127.0.0.1'
  port: number
}

class ProxyRejected extends Error {
  constructor(readonly reason: string, readonly status = 403) {
    super(reason)
  }
}

const HOP_HEADERS = new Set(['proxy-connection', 'proxy-authorization'])

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ProxyRejected('invalid-port', 400)
}

function splitAuthority(raw: string, fallbackPort: number): { host: string; port: number } {
  const value = raw.trim()
  if (!value || value.includes('@') || value.includes('/') || value.includes('\\')) throw new ProxyRejected('invalid-authority', 400)
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end < 0) throw new ProxyRejected('invalid-authority', 400)
    const host = value.slice(1, end)
    const rest = value.slice(end + 1)
    if (rest && !rest.startsWith(':')) throw new ProxyRejected('invalid-authority', 400)
    return { host, port: rest ? Number(rest.slice(1)) : fallbackPort }
  }
  const separator = value.lastIndexOf(':')
  if (separator < 0) return { host: value, port: fallbackPort }
  const host = value.slice(0, separator)
  if (!host || host.includes(':')) throw new ProxyRejected('invalid-authority', 400)
  return { host, port: Number(value.slice(separator + 1)) }
}

function cleanHeaders(raw: IncomingMessage['headers']): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!value || HOP_HEADERS.has(name.toLowerCase())) continue
    headers[name] = value
  }
  return headers
}

export class PinnedProxy {
  private readonly resolver: Pick<PublicPinResolver, 'resolve'>
  private readonly connectTo: (options: { host: string; port: number }) => Socket
  private readonly routeCheck?: PinnedProxyOptions['routeCheck']
  private readonly connectUpstreamTo: (proxy: { protocol: 'http' | 'https'; host: string; port: number }) => Socket
  private readonly maxHeaderBytes: number
  private readonly connectTimeoutMs: number
  private readonly onReject?: (reason: string, host: string) => void
  private server: Server | null = null
  private readonly clients = new Set<Socket>()
  private readonly outbound = new Set<Socket>()
  private readonly routing = { direct: 0, upstream: 0, unsupported: 0 }
  private lastUpstream = ''
  private address: PinnedProxyAddress | null = null
  private closed = false

  constructor(options: PinnedProxyOptions = {}) {
    this.resolver = options.resolver ?? new PublicPinResolver()
    this.connectTo = options.connect ?? ((target) => netConnect({ host: target.host, port: target.port }))
    this.routeCheck = options.routeCheck
    this.connectUpstreamTo = options.connectUpstream ?? ((proxy) => proxy.protocol === 'https'
      ? tlsConnect({ host: proxy.host, port: proxy.port, servername: isIP(proxy.host) ? undefined : proxy.host, rejectUnauthorized: true })
      : netConnect({ host: proxy.host, port: proxy.port }))
    this.maxHeaderBytes = options.maxHeaderBytes ?? 64 * 1024
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.onReject = options.onReject
  }

  get listening(): PinnedProxyAddress | null {
    return this.address
  }

  stats(): { clients: number; outbound: number; routing: { direct: number; upstream: number; unsupported: number }; lastUpstream: string } {
    return { clients: this.clients.size, outbound: this.outbound.size, routing: { ...this.routing }, lastUpstream: this.lastUpstream }
  }

  start(): Promise<PinnedProxyAddress> {
    if (this.address) return Promise.resolve(this.address)
    return new Promise((resolve, reject) => {
      const server = createServer({ maxHeaderSize: this.maxHeaderBytes }, (req, res) => void this.forwardRequest(req, res))
      this.server = server
      server.on('connect', (req, socket, head) => void this.forwardTunnel(req, socket as Socket, head, 'connect'))
      server.on('upgrade', (req, socket, head) => void this.forwardTunnel(req, socket as Socket, head, 'upgrade'))
      server.on('connection', (socket) => {
        this.clients.add(socket)
        socket.on('close', () => this.clients.delete(socket))
        socket.on('error', () => socket.destroy())
      })
      server.on('clientError', (_error, socket) => (socket as Socket).destroy())
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        this.address = { host: '127.0.0.1', port: (server.address() as { port: number }).port }
        resolve(this.address)
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const server = this.server
    this.server = null
    this.address = null
    for (const socket of this.clients) socket.destroy()
    for (const socket of this.outbound) socket.destroy()
    this.clients.clear()
    this.outbound.clear()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private track(socket: Socket): void {
    this.outbound.add(socket)
    socket.on('close', () => this.outbound.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  private async decideRoute(request: { kind: 'http' | 'connect' | 'upgrade'; url?: string; host: string; port: number }): Promise<PinnedRoutePlan> {
    if (!this.routeCheck) {
      this.routing.direct += 1
      return { mode: 'direct' }
    }
    let plan: PinnedRoutePlan
    try {
      plan = await this.routeCheck(request)
    } catch {
      this.routing.unsupported += 1
      this.onReject?.('system-route-unavailable', request.host)
      throw new ProxyRejected('system-proxy-unsupported:system-route-unavailable', 403)
    }
    if (plan.mode === 'direct') {
      this.routing.direct += 1
      return plan
    }
    if (plan.mode === 'upstream') {
      this.routing.upstream += 1
      this.lastUpstream = `${plan.protocol}://${plan.host}:${plan.port}`
      return plan
    }
    this.routing.unsupported += 1
    this.onReject?.(`system-proxy:${plan.reason}`, request.host)
    throw new ProxyRejected(`system-proxy-unsupported:${plan.reason}`, 403)
  }

  private async openProxy(proxy: { protocol: 'http' | 'https'; host: string; port: number }, signal?: AbortSignal): Promise<Socket> {
    const early = this.abortReason(signal)
    if (early) throw early
    let socket: Socket
    try {
      socket = this.connectUpstreamTo(proxy)
    } catch {
      throw new ProxyRejected('upstream-unavailable', 502)
    }
    this.track(socket)
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        socket.off('connect', onReady)
        socket.off('secureConnect', onReady)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error: ProxyRejected | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        cleanup()
        if (error) {
          socket.destroy()
          reject(error)
          return
        }
        resolve(socket)
      }
      const onReady = (): void => finish(null)
      const onError = (): void => finish(new ProxyRejected('upstream-unavailable', 502))
      const onClose = (): void => finish(this.abortReason(signal) ?? new ProxyRejected('upstream-unavailable', 502))
      const onAbort = (): void => finish(new ProxyRejected('cancelled', 499))
      timer = setTimeout(() => finish(new ProxyRejected('connect-timeout', 504)), this.connectTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (proxy.protocol === 'https') socket.once('secureConnect', onReady)
      else socket.once('connect', onReady)
      socket.once('error', onError)
      socket.once('close', onClose)
      if (socket.remoteAddress && proxy.protocol !== 'https') finish(null)
    })
  }

  private formatAuthority(host: string, port: number): string {
    return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`
  }

  private async tunnelViaUpstream(client: Socket, head: Buffer, proxy: { protocol: 'http' | 'https'; host: string; port: number }, host: string, port: number, signal: AbortSignal): Promise<void> {
    const upstream = await this.openProxy(proxy, signal)
    if (this.abortReason(signal)) throw new ProxyRejected('cancelled', 499)
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
    upstream.once('error', () => client.destroy())
    const authority = this.formatAuthority(host, port)
    upstream.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    const response = await new Promise<{ status: number; buffer: Buffer }>((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      let settled = false
      const timer = setTimeout(() => finish(new ProxyRejected('upstream-timeout', 504)), this.connectTimeoutMs)
      const finish = (error: ProxyRejected | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        upstream.off('data', onData)
        upstream.off('error', onError)
        upstream.off('close', onClose)
        if (error) {
          upstream.destroy()
          reject(error)
          return
        }
        const text = buffer.toString('latin1')
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0)
        resolve({ status, buffer })
      }
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.includes(Buffer.from('\r\n\r\n'))) finish(null)
        else if (buffer.length > 64 * 1024) finish(new ProxyRejected('upstream-bad-response', 502))
      }
      const onError = (): void => finish(new ProxyRejected('upstream-unavailable', 502))
      const onClose = (): void => finish(new ProxyRejected('upstream-unavailable', 502))
      upstream.on('data', onData)
      upstream.once('error', onError)
      upstream.once('close', onClose)
    })
    if (response.status < 200 || response.status >= 300) {
      client.write(response.buffer)
      upstream.pipe(client)
      upstream.once('close', () => client.destroy())
      client.once('close', () => upstream.destroy())
      return
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const leftover = response.buffer.subarray(response.buffer.indexOf('\r\n\r\n') + 4)
    if (leftover.length) upstream.write(leftover)
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
    client.resume()
  }

  private async forwardHttpViaUpstream(req: IncomingMessage, res: ServerResponse, url: URL, proxy: { protocol: 'http' | 'https'; host: string; port: number }, controller: AbortController): Promise<void> {
    const upstream = await this.openProxy(proxy, controller.signal)
    const headers = cleanHeaders(req.headers)
    headers.host = req.headers.host ?? url.host
    headers.connection = 'close'
    const upstreamReq = httpRequest({
      createConnection: () => upstream,
      method: req.method,
      path: url.href,
      headers,
      signal: controller.signal
    })
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
    })
    upstreamReq.on('error', () => {
      upstream.destroy()
      if (!res.headersSent) this.sendHttpError(res, new ProxyRejected('upstream-unavailable', 502))
      else res.destroy()
    })
    upstreamReq.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers)
      upstreamRes.on('error', () => {
        upstream.destroy()
        res.destroy()
      })
      upstreamRes.pipe(res)
    })
    req.pipe(upstreamReq)
  }

  private async upgradeViaUpstream(client: Socket, head: Buffer, proxy: { protocol: 'http' | 'https'; host: string; port: number }, requestHead: string, signal: AbortSignal): Promise<void> {
    const upstream = await this.openProxy(proxy, signal)
    if (this.abortReason(signal)) throw new ProxyRejected('cancelled', 499)
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
    upstream.once('error', () => client.destroy())
    upstream.write(requestHead)
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
    client.resume()
  }

  private async resolveTargets(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
    if (isLocalHostname(host)) return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]
    const literal = dialLiteral(host)
    if (literal) {
      if (isMetadataAddress(host) || isLinkLocalAddress(host)) {
        this.onReject?.('metadata-target', host)
        throw new ProxyRejected('metadata-target')
      }
      return [literal]
    }
    let pin: PublicPin
    try {
      pin = await this.resolver.resolve(host)
    } catch (error) {
      const reason = error instanceof Error && error.name === 'PinRejectedError' ? (error as Error & { reason?: string }).reason ?? 'pin-rejected' : 'pin-rejected'
      this.onReject?.(`pin:${reason}`, host)
      throw new ProxyRejected('pin-rejected')
    }
    if (!pin.addresses.length || pin.addresses.some((entry) => !isPublicAddress(entry.address))) {
      this.onReject?.('pin:not-public', host)
      throw new ProxyRejected('pin-rejected')
    }
    return pin.addresses
  }

  private abortReason(signal?: AbortSignal): ProxyRejected | null {
    if (this.closed) return new ProxyRejected('closed', 502)
    if (signal?.aborted) return new ProxyRejected('cancelled', 499)
    return null
  }

  private async openUpstream(host: string, port: number, signal?: AbortSignal): Promise<Socket> {
    const early = this.abortReason(signal)
    if (early) throw early
    const targets = await this.resolveTargets(host)
    for (const target of targets) {
      const cancelled = this.abortReason(signal)
      if (cancelled) throw cancelled
      const socket = await this.connectOnce(target, port, signal).catch(() => {
        const reason = this.abortReason(signal)
        if (reason) throw reason
        return null
      })
      if (socket) return socket
    }
    throw new ProxyRejected('connect-failed', 502)
  }

  private connectOnce(target: { address: string; family: 4 | 6 }, port: number, signal?: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const early = this.abortReason(signal)
      if (early) {
        reject(early)
        return
      }
      let socket: Socket
      try {
        socket = this.connectTo({ host: target.address, port })
      } catch (error) {
        reject(error)
        return
      }
      this.track(socket)
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        socket.off('connect', onConnect)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error: ProxyRejected | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        cleanup()
        if (error) {
          socket.destroy()
          reject(error)
          return
        }
        resolve(socket)
      }
      const onConnect = (): void => finish(null)
      const onError = (): void => finish(new ProxyRejected('connect-failed', 502))
      const onClose = (): void => finish(this.abortReason(signal) ?? new ProxyRejected('connect-failed', 502))
      const onAbort = (): void => finish(new ProxyRejected('cancelled', 499))
      timer = setTimeout(() => finish(new ProxyRejected('connect-timeout', 504)), this.connectTimeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)
      if (socket.remoteAddress) finish(null)
    })
  }

  private async forwardRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    req.once('aborted', abort)
    req.once('close', () => {
      if (!req.complete) abort()
    })
    res.once('close', () => {
      if (!res.writableEnded) abort()
    })
    res.once('error', abort)
    try {
      if (!req.url || !/^https?:\/\//i.test(req.url)) throw new ProxyRejected('invalid-request-target', 400)
      const url = new URL(req.url)
      if (url.protocol !== 'http:') throw new ProxyRejected(url.protocol === 'https:' ? 'https-requires-connect' : 'unsupported-scheme', 400)
      if (url.username || url.password) throw new ProxyRejected('invalid-request-target', 400)
      const port = url.port ? Number(url.port) : 80
      assertPort(port)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const plan = await this.decideRoute({ kind: 'http', url: url.href, host, port })
      if (plan.mode === 'upstream') {
        await this.forwardHttpViaUpstream(req, res, url, plan, controller)
        return
      }
      const upstream = await this.openUpstream(host, port, controller.signal)
      const cancelled = this.abortReason(controller.signal)
      if (cancelled) {
        upstream.destroy()
        throw cancelled
      }
      const headers = cleanHeaders(req.headers)
      headers.host = req.headers.host ?? url.host
      headers.connection = 'close'
      const upstreamReq = httpRequest({
        createConnection: () => upstream,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        signal: controller.signal
      })
      req.on('aborted', () => upstreamReq.destroy())
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy()
      })
      upstreamReq.on('error', () => {
        upstream.destroy()
        if (!res.headersSent) this.sendHttpError(res, new ProxyRejected('upstream-failed', 502))
        else res.destroy()
      })
      upstreamReq.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers)
        upstreamRes.on('error', () => {
          upstream.destroy()
          res.destroy()
        })
        upstreamRes.pipe(res)
      })
      req.pipe(upstreamReq)
    } catch (error) {
      this.sendHttpError(res, error)
    }
  }

  private sendHttpError(res: ServerResponse, error: unknown): void {
    const rejection = error instanceof ProxyRejected ? error : new ProxyRejected('proxy-error', 502)
    const reason = rejection.reason.replace(/[^a-z0-9:._-]/gi, '')
    const body = `pinned network proxy: ${reason}`
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(rejection.status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body), connection: 'close' })
    res.end(body)
  }

  private async forwardTunnel(req: IncomingMessage, client: Socket, head: Buffer, kind: 'connect' | 'upgrade'): Promise<void> {
    client.pause()
    const controller = new AbortController()
    let upstream: Socket | null = null
    let aborted = false
    const abort = (): void => {
      aborted = true
      controller.abort()
      upstream?.destroy()
      client.destroy()
    }
    client.once('close', abort)
    client.once('error', abort)
    try {
      let host: string
      let port: number
      let requestHead = ''
      let upstreamRequestHead = ''
      if (kind === 'connect') {
        const target = splitAuthority(req.url ?? '', 443)
        host = target.host
        port = target.port
        assertPort(port)
      } else {
        const absolute = req.url && /^https?:\/\//i.test(req.url) ? new URL(req.url) : null
        if (req.url && /^https?:\/\//i.test(req.url) && (!absolute || absolute.protocol !== 'http:')) throw new ProxyRejected('upgrade-requires-http', 400)
        const hostHeader = req.headers.host ?? ''
        if (absolute) {
          host = absolute.hostname.replace(/^\[|\]$/g, '')
          port = absolute.port ? Number(absolute.port) : 80
        } else {
          const target = splitAuthority(hostHeader, 80)
          host = target.host
          port = target.port
        }
        assertPort(port)
        const path = absolute ? `${absolute.pathname}${absolute.search}` : req.url ?? '/'
        const headers = cleanHeaders(req.headers)
        if (!headers.host) headers.host = hostHeader
        headers.connection = 'Upgrade'
        const headerText = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`])).join('\r\n')
        requestHead = `${req.method ?? 'GET'} ${path} HTTP/1.1\r\n${headerText}\r\n\r\n`
        upstreamRequestHead = `${req.method ?? 'GET'} ${absolute ? absolute.href : `http://${this.formatAuthority(host, port)}${path}`} HTTP/1.1\r\n${headerText}\r\n\r\n`
      }
      const plan = await this.decideRoute({ kind, url: kind === 'upgrade' && req.url && /^https?:\/\//i.test(req.url) ? req.url : undefined, host, port })
      if (plan.mode === 'upstream') {
        if (kind === 'connect') await this.tunnelViaUpstream(client, head, plan, host, port, controller.signal)
        else await this.upgradeViaUpstream(client, head, plan, upstreamRequestHead, controller.signal)
        return
      }
      upstream = await this.openUpstream(host, port, controller.signal)
      const cancelled = this.abortReason(controller.signal)
      if (cancelled) throw cancelled
      if (aborted || client.destroyed) {
        upstream.destroy()
        return
      }
      upstream.once('close', () => client.destroy())
      upstream.once('error', () => client.destroy())
      if (kind === 'connect') {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      } else {
        upstream.write(requestHead)
      }
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
      client.resume()
    } catch (error) {
      const rejection = error instanceof ProxyRejected ? error : new ProxyRejected('proxy-error', 502)
      client.end(`HTTP/1.1 ${rejection.status} ${rejection.status === 403 ? 'Forbidden' : rejection.status === 400 ? 'Bad Request' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      upstream?.destroy()
    }
  }
}
