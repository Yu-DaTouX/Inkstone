import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserLoginImport, BrowserLoginImportStatus } from '../../shared/ipc'

export const COOKIE_BRIDGE_ORIGIN = 'chrome-extension://lbceoiahmfjmmlpmndopbliceoalblcc'
const MAX_BODY_BYTES = 16 * 1024 * 1024

export interface BridgeCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  session: boolean
  expirationDate?: number
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

type Sender = (method: string, params: Record<string, unknown>) => Promise<unknown>

function validCookieDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string' || domain.length > 254) return false
  const host = domain.replace(/^\./, '')
  if (!host || host.startsWith('.')) return false
  try { return new URL(`http://${host}`).hostname === host.toLowerCase() } catch { return false }
}

function validSite(site: unknown): site is string {
  if (typeof site !== 'string') return false
  try { const url = new URL(site); return ['http:', 'https:'].includes(url.protocol) && url.origin === site } catch { return false }
}

export function parseBridgeCookies(raw: unknown): { cookies: BridgeCookie[]; skipped: number } {
  const list = (raw as { cookies?: unknown } | null)?.cookies
  if (!Array.isArray(list) || list.length > 20_000) throw new Error('Invalid cookies')
  let skipped = 0
  const cookies: BridgeCookie[] = list.flatMap((cookie) => {
    if (!cookie || typeof cookie !== 'object') { skipped++; return [] }
    const { name, value, domain, path, hostOnly, secure, httpOnly, session, expirationDate, sameSite, partitionKey } = cookie
    if (typeof name !== 'string' || name.length > 4096 || /[\x00-\x1f\x7f]/.test(name) || typeof value !== 'string' || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value) ||
      !validCookieDomain(domain) ||
      typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) ||
      [hostOnly, secure, httpOnly, session].some(v => typeof v !== 'boolean') ||
      (hostOnly && domain.startsWith('.')) || (!session && (typeof expirationDate !== 'number' || !Number.isFinite(expirationDate))) ||
      (sameSite !== undefined && !['unspecified', 'no_restriction', 'lax', 'strict'].includes(sameSite)) ||
      (partitionKey !== undefined && (!partitionKey || !validSite(partitionKey.topLevelSite) || typeof partitionKey.hasCrossSiteAncestor !== 'boolean'))) { skipped++; return [] }
    return [{ name, value, domain, path, hostOnly, secure, httpOnly, session, expirationDate, sameSite, partitionKey }]
  })
  return { cookies, skipped }
}

export async function writeBridgeCookies(send: Sender, cookies: BridgeCookie[]): Promise<BrowserLoginImport> {
  const result: BrowserLoginImport = { copied: 0, failed: 0, skipped: 0 }
  for (const cookie of cookies) {
    if (!cookie.session && cookie.expirationDate! <= Date.now() / 1000) { result.skipped++; continue }
    const params: Record<string, unknown> = {
      name: cookie.name, value: cookie.value, path: cookie.path,
      url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
      secure: cookie.secure, httpOnly: cookie.httpOnly
    }
    if (!cookie.hostOnly) params.domain = cookie.domain
    if (!cookie.session) params.expires = cookie.expirationDate
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') params.sameSite = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[cookie.sameSite]
    if (cookie.partitionKey) params.partitionKey = cookie.partitionKey
    try {
      const outcome = await send('Network.setCookies', { cookies: [params] })
      if ((outcome as { success?: boolean } | null)?.success === false) result.failed++
      else result.copied++
    } catch { result.failed++ }
  }
  return result
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function createCookieBridge(options: {
  extensionPath: string
  showExtension(): Promise<void>
  receive(cookies: BridgeCookie[]): Promise<BrowserLoginImport>
  timeoutMs?: number
}) {
  const token = randomBytes(32).toString('hex')
  const id = randomUUID()
  const expiresAt = Date.now() + (options.timeoutMs ?? 300_000)
  let status: BrowserLoginImportStatus = { id, phase: 'waiting' }
  const json = (response: ServerResponse, code: number, body: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(code, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const address = server.address()
    const host = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    if (request.headers.host !== host) { json(response, 403, { error: 'forbidden' }); return }
    if (request.method === 'GET' && ['/connect', '/connect.js', '/import.css'].includes(request.url ?? '')) {
      const file = request.url === '/connect' ? 'connect.html' : request.url!.slice(1)
      try {
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${COOKIE_BRIDGE_ORIGIN}`)
        response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' })
        response.end(await readFile(join(options.extensionPath, file)))
      } catch { response.destroy() }
      return
    }
    const origin = request.headers.origin
    const localSetup = ['/v1/setup', '/v1/show-extension', '/v1/failure'].includes(request.url ?? '') && (origin === `http://${host}` || (!origin && request.headers['sec-fetch-site'] === 'same-origin'))
    if (origin !== undefined && origin !== COOKIE_BRIDGE_ORIGIN && !localSetup) { json(response, 403, { error: 'forbidden' }); return }
    response.setHeader('Access-Control-Allow-Origin', COOKIE_BRIDGE_ORIGIN)
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Sync-Browser, X-Sync-Role')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    const provided = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected) || (!localSetup && (request.headers['x-sync-role'] !== 'browser' || !['chrome', 'edge'].includes(String(request.headers['x-sync-browser']))))) {
      json(response, 401, { error: 'unauthorized' }); return
    }
    if (Date.now() >= expiresAt || status.phase !== 'waiting') { json(response, 409, { error: 'not_waiting' }); return }
    if (request.method === 'POST' && request.url === '/v1/failure') {
      try {
        const body = await readJson(request) as { reason?: unknown }
        if (!body || typeof body.reason !== 'string' || !['connection_failed', 'pairing_expired', 'read_failed', 'invalid_payload', 'import_failed'].includes(body.reason)) throw new Error('Invalid reason')
        if (status.phase !== 'waiting' || Date.now() >= expiresAt) { json(response, 409, { error: 'not_waiting' }); return }
        status = { id, phase: 'failed', error: body.reason as NonNullable<BrowserLoginImportStatus['error']> }
        clearTimeout(timer)
        json(response, 200, { ok: true })
        server.close()
        server.closeIdleConnections()
      } catch { json(response, 400, { error: 'invalid_failure' }) }
      return
    }
    if (localSetup) {
      if (request.method === 'GET' && request.url === '/v1/setup') json(response, 200, { extensionPath: options.extensionPath })
      else if (request.method === 'POST' && request.url === '/v1/show-extension') {
        try { await options.showExtension(); json(response, 200, { ok: true }) } catch { json(response, 500, { error: 'open_failed' }) }
      } else json(response, 405, { error: 'method_not_allowed' })
      return
    }
    if (request.method === 'GET' && request.url === '/v1/status') {
      json(response, 200, { runId: id, sourceBrowser: request.headers['x-sync-browser'], sourceNeeded: true, imports: { cookies: true, history: false } }); return
    }
    if (request.method !== 'POST' || request.url !== '/v1/source') { json(response, 404, { error: 'not_found' }); return }
    try {
      if (request.headers['content-type'] !== 'application/json') throw new Error('Invalid content type')
      const { cookies, skipped } = parseBridgeCookies(await readJson(request))
      if (status.phase !== 'waiting' || Date.now() >= expiresAt) { json(response, 409, { error: 'not_waiting' }); return }
      status = { id, phase: 'importing' }
      clearTimeout(timer)
      try {
        const written = await options.receive(cookies)
        const result = { ...written, skipped: written.skipped + skipped }
        status = { id, phase: 'done', result }
        json(response, 200, result)
      } catch {
        status = { id, phase: 'failed', error: 'import_failed' }
        json(response, 500, { error: 'import_failed' })
      } finally { server.close(); server.closeIdleConnections() }
    } catch {
      if (status.phase === 'waiting') {
        status = { id, phase: 'failed', error: 'invalid_payload' }
        clearTimeout(timer)
        server.close()
      }
      json(response, 400, { error: 'invalid_payload' })
      server.closeIdleConnections()
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxConnections = 8
  const cancel = (): void => {
    if (status.phase !== 'waiting') return
    status = { id, phase: 'cancelled' }
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
  const timer = setTimeout(cancel, Math.max(1, expiresAt - Date.now()))
  timer.unref()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) { clearTimeout(timer); throw error }
  server.unref()
  const address = server.address()
  if (!address || typeof address === 'string') { cancel(); throw new Error('导入桥接启动失败') }
  return { id, url: `http://127.0.0.1:${address.port}/connect#${address.port}.${token}`, expiresAt, status: () => ({ ...status }), cancel }
}
