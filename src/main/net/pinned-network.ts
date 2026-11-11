import { session as electronSession, type Session } from 'electron'
import { isIP } from 'node:net'
import type { Socket } from 'node:net'
import { PinnedProxy, type PinnedRoutePlan } from './pinned-proxy'
import { PublicPinResolver } from './pinned-resolver'

export type PinnedGuardStatus = 'idle' | 'starting' | 'ready' | 'system-proxy' | 'failed'

export interface PinnedGuardOptions {
  resolver?: Pick<PublicPinResolver, 'resolve'>
  connect?: (options: { host: string; port: number }) => Socket
  systemRoute?: (url: string) => Promise<string>
  onReject?: (reason: string, host: string) => void
}

export type PinnedGuardAttachResult =
  | { status: 'attached'; port: number }
  | { status: 'system-proxy'; resolution: string }
  | { status: 'failed'; message: string }

interface SessionGuardState {
  status: PinnedGuardStatus
  reason: string
  promise: Promise<PinnedGuardAttachResult>
}

let sessionStates = new WeakMap<Session, SessionGuardState>()

export function pinnedRoutingStatus(): { direct: number; upstream: number; unsupported: number; lastUpstream: string } {
  return proxy ? { ...proxy.stats().routing, lastUpstream: proxy.stats().lastUpstream } : { direct: 0, upstream: 0, unsupported: 0, lastUpstream: '' }
}

export function pinnedGuardStatus(ses: Session): { status: PinnedGuardStatus; reason: string } {
  const state = sessionStates.get(ses)
  return state ? { status: state.status, reason: state.reason } : { status: 'idle', reason: '' }
}

let proxy: PinnedProxy | null = null
let resolver: PublicPinResolver | null = null
let starting: Promise<PinnedProxy> | null = null
let probeSession: Session | null = null
let probeReady: Promise<Session> | null = null

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host
}

async function systemRoute(url: string): Promise<string> {
  if (!probeReady) {
    probeSession = electronSession.fromPartition('yan-pinned-probe', { cache: false })
    const session = probeSession
    probeReady = session
      .setProxy({ mode: 'system' })
      .then(() => session)
      .catch((error) => {
        probeSession = null
        probeReady = null
        throw error
      })
  }
  return (await probeReady).resolveProxy(url)
}

function parseProxyRoute(route: string): { mode: 'direct' } | { mode: 'upstream'; protocol: 'http' | 'https'; host: string; port: number } | null {
  for (const part of route.split(';')) {
    const entry = part.trim()
    if (!entry) continue
    if (entry.toUpperCase() === 'DIRECT') return { mode: 'direct' }
    const match = /^(PROXY|HTTPS)\s+(.+)$/i.exec(entry)
    if (!match) continue
    const protocol = match[1].toUpperCase() === 'HTTPS' ? 'https' : 'http'
    const authority = match[2].trim()
    let host: string
    let port: number
    if (authority.startsWith('[')) {
      const end = authority.indexOf(']')
      if (end < 0) continue
      host = authority.slice(1, end)
      const rest = authority.slice(end + 1)
      port = rest.startsWith(':') ? Number(rest.slice(1)) : protocol === 'https' ? 443 : 80
    } else {
      const separator = authority.lastIndexOf(':')
      if (separator < 0) {
        host = authority
        port = protocol === 'https' ? 443 : 80
      } else {
        host = authority.slice(0, separator)
        port = Number(authority.slice(separator + 1))
      }
    }
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) continue
    return { mode: 'upstream', protocol, host, port }
  }
  return null
}

async function routeDecision(routeFor: (url: string) => Promise<string>, request: { kind: 'http' | 'connect' | 'upgrade'; url?: string; host: string; port: number }): Promise<PinnedRoutePlan> {
  const authority = `${formatHost(request.host)}:${request.port}`
  const urls = request.kind === 'http'
    ? [request.url ?? `http://${authority}/`]
    : request.kind === 'upgrade'
      ? [request.url ?? `http://${authority}/`, `wss://${authority}/`]
      : [`https://${authority}/`, `wss://${authority}/`]
  let seenDirect = false
  const unsupported: string[] = []
  for (const url of urls) {
    let route: string
    try {
      route = (await routeFor(url)).trim()
    } catch {
      unsupported.push(`${url}=route-unavailable`)
      continue
    }
    const plan = parseProxyRoute(route)
    if (!plan) {
      unsupported.push(`${url}=${route}`)
      continue
    }
    if (plan.mode === 'upstream') return plan
    seenDirect = true
  }
  if (seenDirect) return { mode: 'direct' }
  return { mode: 'unsupported', reason: unsupported.join('|') }
}

export const PINNED_GUARD_TTL_MS = 30_000

export function sharedPinResolver(): PublicPinResolver {
  if (!resolver) resolver = new PublicPinResolver({ ttlMs: PINNED_GUARD_TTL_MS, limit: 256, maxPending: 64, timeoutMs: 5_000 })
  return resolver
}

async function ensureProxy(options: PinnedGuardOptions = {}): Promise<PinnedProxy> {
  if (proxy) return proxy
  if (!starting) {
    const routeFor = options.systemRoute ?? systemRoute
    const instance = new PinnedProxy({
      resolver: options.resolver ?? sharedPinResolver(),
      onReject: options.onReject ?? (() => undefined),
      routeCheck: (request) => routeDecision(routeFor, request),
      ...(options.connect ? { connect: options.connect } : {})
    })
    starting = instance
      .start()
      .then(() => {
        proxy = instance
        return instance
      })
      .catch((error) => {
        proxy = null
        throw error
      })
      .finally(() => {
        starting = null
      })
  }
  return starting
}

export function attachPinnedNetworkGuard(ses: Session, probeUrl = 'https://example.com/', options: PinnedGuardOptions = {}): Promise<PinnedGuardAttachResult> {
  const existing = sessionStates.get(ses)
  if (existing && existing.status !== 'failed') return existing.promise
  const state: SessionGuardState = { status: 'starting', reason: '', promise: Promise.resolve({ status: 'failed', message: 'guard not started' }) }
  sessionStates.set(ses, state)
  state.promise = (async (): Promise<PinnedGuardAttachResult> => {
    try {
      const instance = await ensureProxy(options)
      const address = instance.listening
      if (!address) {
        state.status = 'failed'
        state.reason = 'pinned proxy not listening'
        return { status: 'failed', message: state.reason }
      }
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
        proxyBypassRules: '<-loopback>'
      })
      const applied = await ses.resolveProxy(probeUrl)
      if (!applied.trim().toUpperCase().startsWith(`PROXY 127.0.0.1:${address.port}`)) {
        await ses.setProxy({ mode: 'system' })
        state.status = 'failed'
        state.reason = `proxy route mismatch: ${applied.trim()}`
        return { status: 'failed', message: state.reason }
      }
      await ses.closeAllConnections()
      state.status = 'ready'
      state.reason = ''
      return { status: 'attached', port: address.port }
    } catch (error) {
      state.status = 'failed'
      state.reason = error instanceof Error ? error.message : String(error)
      return { status: 'failed', message: state.reason }
    }
  })()
  return state.promise
}

export async function shutdownPinnedNetworkGuard(): Promise<void> {
  const instance = proxy
  proxy = null
  starting = null
  resolver?.close()
  resolver = null
  probeSession = null
  probeReady = null
  sessionStates = new WeakMap()
  if (instance) await instance.close()
}
