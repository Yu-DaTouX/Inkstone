import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile, copyFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { COLLAB_BUNDLE_MAX_BYTES } from '../shared/collab'
import {
  PEER_APPROVAL_TIMEOUT_MS,
  PEER_ARTIFACT_MAX_BYTES,
  PEER_CONNECTION_HEADER,
  type PeerConnectionState,
  type PeerGrantView,
  type PeerImportView,
  type PeerOperation,
  type PeerRecordView,
  type PeerSessionExport,
  type PeerStatusView
} from '../shared/peer-protocol'
import { YAN_DIR } from './paths'
import { sanitizePrRefs } from '../shared/collab-github'

const PEERS_FILE = join(YAN_DIR, 'peers.json')
const IMPORTS_DIR = join(YAN_DIR, 'peer-imports')

interface StoredPeer extends PeerRecordView {
  deviceId: string
  token: string
}

interface PeersFile {
  version: 1
  peers: StoredPeer[]
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export type PeerDownload<T> = { kind: 'file'; bytes: number } | { kind: 'json'; data: T }

type StreamOpened = { ok: true; data: true } | { ok: false; error: string; ended?: boolean }

export interface PeerTransport {
  call<T>(peerId: string, path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<Result<T>>
  download<T>(peerId: string, path: string, body: unknown, file: string): Promise<Result<PeerDownload<T>>>
  upload<T>(peerId: string, path: string, file: string | null): Promise<Result<T>>
}

function sealToken(token: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(token).toString('base64')}`
  return `raw:${token}`
}

function openToken(sealed: string): string | null {
  try {
    if (sealed.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'))
    if (sealed.startsWith('raw:')) return sealed.slice(4)
  } catch {
  }
  return null
}

export function normalizePeerAddress(input: string): string | null {
  const text = input.trim().replace(/\/+$/, '')
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    if (url.pathname !== '/' && url.pathname !== '') return null
    if (!url.port) url.port = '37892'
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim()
  return (cleaned || 'file').slice(0, 120)
}

const TRANSFER_TIMEOUT_MS = 30 * 60_000
const RECONNECT_DELAY_MS = 3000
const RECONNECT_ATTEMPTS = 3
const PEER_NOTICE_TIMEOUT_MS = 3000

function connectionEnded(code: string | undefined): boolean {
  return code === 'peer_connection_required' || code === 'unauthorized'
}

export class PeerClient implements PeerTransport {
  private peers: StoredPeer[] | null = null
  private readonly connections = new Map<string, PeerConnectionState>()
  private readonly streams = new Map<string, AbortController>()
  private readonly reconnects = new Map<string, { timer: ReturnType<typeof setTimeout>; wake: () => void }>()
  private readonly generations = new Map<string, number>()

  private async load(): Promise<StoredPeer[]> {
    if (this.peers) return this.peers
    try {
      const parsed = JSON.parse(await readFile(PEERS_FILE, 'utf8')) as Partial<PeersFile>
      this.peers = parsed.version === 1 && Array.isArray(parsed.peers) ? parsed.peers.filter((peer) => typeof peer?.id === 'string' && typeof peer.token === 'string') : []
    } catch {
      await copyFile(PEERS_FILE, `${PEERS_FILE}.${Date.now()}.corrupt`).catch(() => undefined)
      this.peers = []
    }
    return this.peers
  }

  private async save(): Promise<void> {
    await mkdir(YAN_DIR, { recursive: true })
    const temp = `${PEERS_FILE}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, peers: this.peers ?? [] } satisfies PeersFile, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temp, PEERS_FILE)
  }

  async status(): Promise<PeerStatusView> {
    const peers = await this.load()
    return {
      peers: peers.map(({ id, computer, address, pairedAt }) => ({
        id,
        computer,
        address,
        pairedAt,
        connection: this.connections.get(id) ?? { state: 'idle' }
      })),
      imports: await this.listImports()
    }
  }

  private setState(peerId: string, state: PeerConnectionState): void {
    this.connections.set(peerId, state)
  }

  async pair(addressInput: string, code: string): Promise<Result<PeerRecordView>> {
    const address = normalizePeerAddress(addressInput)
    if (!address) {
      return { ok: false, error: 'That address is not in the right format, for example 100.101.102.103:37892', code: 'address-invalid' }
    }
    try {
      const response = await fetch(`${address}/remote/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), deviceName: hostname(), kind: 'peer' }),
        signal: AbortSignal.timeout(15_000)
      })
      const body = (await response.json()) as { ok?: boolean; error?: string; deviceId?: string; token?: string; computer?: { name?: string } }
      if (!response.ok || !body.ok || !body.token || !body.deviceId) {
        return { ok: false, error: body.error ?? `Pairing failed (HTTP ${response.status})`, code: 'pair-failed' }
      }
      const peers = await this.load()
      const peer: StoredPeer = {
        id: `peer-${randomUUID()}`,
        computer: String(body.computer?.name ?? address).slice(0, 80),
        address,
        pairedAt: Date.now(),
        deviceId: body.deviceId,
        token: sealToken(body.token)
      }
      peers.push(peer)
      await this.save()
      return { ok: true, data: { id: peer.id, computer: peer.computer, address: peer.address, pairedAt: peer.pairedAt } }
    } catch (error) {
      return { ok: false, error: `Could not reach them: ${error instanceof Error ? error.message : String(error)}`, code: 'peer-unreachable' }
    }
  }

  async remove(peerId: string): Promise<boolean> {
    await this.bestEffort(peerId, '/remote/v1/devices/self/revoke', {})
    this.disconnect(peerId)
    const peers = await this.load()
    const index = peers.findIndex((peer) => peer.id === peerId)
    if (index < 0) return false
    peers.splice(index, 1)
    await this.save()
    this.connections.delete(peerId)
    return true
  }

  private async bestEffort(peerId: string, path: string, body: unknown): Promise<void> {
    const auth = await this.credentials(peerId)
    if (!auth) return
    try {
      await fetch(`${auth.peer.address}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PEER_NOTICE_TIMEOUT_MS)
      })
    } catch {
    }
  }

  async endConnection(peerId: string): Promise<void> {
    const connection = this.connections.get(peerId)
    if (connection?.state === 'connected') {
      await this.bestEffort(peerId, '/remote/v1/peer/disconnect', { connectionId: connection.grant.connectionId })
    }
    this.disconnect(peerId)
  }

  private async credentials(peerId: string): Promise<{ peer: StoredPeer; token: string } | null> {
    const peer = (await this.load()).find((item) => item.id === peerId)
    const token = peer ? openToken(peer.token) : null
    return peer && token ? { peer, token } : null
  }

  private async request<T>(peerId: string, path: string, init: { method?: string; body?: unknown; idempotent?: boolean; timeoutMs?: number } = {}): Promise<Result<T>> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'That computer could not be found or the token expired; pair again', code: 'peer-auth-missing' }
    const connection = this.connections.get(peerId)
    const headers: Record<string, string> = { authorization: `Bearer ${auth.token}` }
    if (connection?.state === 'connected') headers[PEER_CONNECTION_HEADER] = connection.grant.connectionId
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const idempotencyKey = init.idempotent ? `peer-${randomUUID()}` : null
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(`${auth.peer.address}${path}`, {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(init.timeoutMs ?? 30_000)
        })
        const body = (await response.json()) as { ok?: boolean; data?: T; error?: string; code?: string }
        if (!response.ok || !body.ok) {
          if (connectionEnded(body.code)) this.dropConnection(peerId, { state: 'ended' }, false)
          return { ok: false, error: body.error ?? `Request failed (HTTP ${response.status})`, code: body.code ?? 'peer-request-failed' }
        }
        return { ok: true, data: body.data as T }
      } catch (error) {
        if (idempotencyKey && attempt === 0) continue
        return { ok: false, error: `Request failed: ${error instanceof Error ? error.message : String(error)}`, code: 'peer-request-failed' }
      }
    }
  }

  call<T>(peerId: string, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Result<T>> {
    return this.request<T>(peerId, path, init)
  }

  private async authHeaders(peerId: string): Promise<{ address: string; headers: Record<string, string> } | null> {
    const auth = await this.credentials(peerId)
    if (!auth) return null
    const connection = this.connections.get(peerId)
    return {
      address: auth.peer.address,
      headers: {
        authorization: `Bearer ${auth.token}`,
        ...(connection?.state === 'connected' ? { [PEER_CONNECTION_HEADER]: connection.grant.connectionId } : {})
      }
    }
  }

  private async failureOf(peerId: string, response: Response): Promise<{ ok: false; error: string; code?: string }> {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
    if (connectionEnded(body.code)) {
      this.dropConnection(peerId, { state: 'ended' })
      return { ok: false, error: body.error ?? 'They ended this connection', code: body.code }
    }
    return { ok: false, error: body.error ?? `Request failed (HTTP ${response.status})`, ...(body.code ? { code: body.code } : {}) }
  }

  async download<T>(peerId: string, path: string, body: unknown, file: string): Promise<Result<PeerDownload<T>>> {
    const auth = await this.authHeaders(peerId)
    if (!auth) return { ok: false, error: 'That computer could not be found or the token expired; pair again', code: 'peer-auth-missing' }
    try {
      const response = await fetch(`${auth.address}${path}`, {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
      })
      if (!response.ok) return this.failureOf(peerId, response)
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        const parsed = (await response.json()) as { ok?: boolean; data?: T; error?: string }
        return parsed.ok
          ? { ok: true, data: { kind: 'json', data: parsed.data as T } }
          : { ok: false, error: parsed.error ?? 'They returned a failure', code: 'peer-request-failed' }
      }
      const declared = Number(response.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > COLLAB_BUNDLE_MAX_BYTES) {
        return { ok: false, error: 'The code bundle is over the size limit', code: 'bundle-too-large' }
      }
      if (!response.body) return { ok: false, error: 'They did not return a code bundle', code: 'bundle-not-returned' }
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(file))
      const info = await stat(file)
      if (info.size > COLLAB_BUNDLE_MAX_BYTES) {
        return { ok: false, error: 'The code bundle is over the size limit', code: 'bundle-too-large' }
      }
      return { ok: true, data: { kind: 'file', bytes: info.size } }
    } catch (error) {
      return { ok: false, error: `Download failed: ${error instanceof Error ? error.message : String(error)}`, code: 'download-failed' }
    }
  }

  async upload<T>(peerId: string, path: string, file: string | null): Promise<Result<T>> {
    const auth = await this.authHeaders(peerId)
    if (!auth) return { ok: false, error: 'That computer could not be found or the token expired; pair again', code: 'peer-auth-missing' }
    try {
      const size = file ? (await stat(file)).size : 0
      const init: RequestInit & { duplex?: 'half' } = {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/octet-stream', 'content-length': String(size) },
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
      }
      if (file) {
        init.body = Readable.toWeb(createReadStream(file)) as unknown as NonNullable<RequestInit['body']>
        init.duplex = 'half'
      }
      const response = await fetch(`${auth.address}${path}`, init)
      if (!response.ok) return this.failureOf(peerId, response)
      const parsed = (await response.json()) as { ok?: boolean; data?: T; error?: string }
      return parsed.ok
        ? { ok: true, data: parsed.data as T }
        : { ok: false, error: parsed.error ?? 'They returned a failure', code: 'peer-request-failed' }
    } catch (error) {
      return { ok: false, error: `Upload failed: ${error instanceof Error ? error.message : String(error)}`, code: 'upload-failed' }
    }
  }

  async connect(peerId: string, operations: PeerOperation[], note: string): Promise<Result<PeerGrantView>> {
    this.disconnect(peerId)
    this.generations.set(peerId, this.generation(peerId) + 1)
    this.setState(peerId, { state: 'waiting', since: Date.now() })
    const result = await this.request<{ grant: PeerGrantView }>(peerId, '/remote/v1/peer/connect', {
      method: 'POST',
      body: { operations, note },
      timeoutMs: PEER_APPROVAL_TIMEOUT_MS + 15_000
    })
    if (!result.ok) {
      this.setState(peerId, { state: 'failed', error: result.error })
      return result
    }
    const grant = result.data.grant
    const opened = await this.openStream(peerId, grant)
    if (!opened.ok) {
      if (opened.ended) this.dropConnection(peerId, { state: 'ended' })
      else this.setState(peerId, { state: 'failed', error: opened.error })
      return { ok: false, error: opened.error }
    }
    this.setState(peerId, { state: 'connected', grant })
    return { ok: true, data: grant }
  }

  private async openStream(peerId: string, grant: PeerGrantView, attempt = 0, generation = this.generation(peerId)): Promise<StreamOpened> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'The token expired; pair again' }
    const controller = new AbortController()
    this.streams.set(peerId, controller)
    try {
      const response = await fetch(`${auth.peer.address}/remote/v1/peer/events`, {
        headers: { authorization: `Bearer ${auth.token}`, [PEER_CONNECTION_HEADER]: grant.connectionId, accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (!response.ok) {
        this.streams.delete(peerId)
        const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string }
        if (connectionEnded(body.code)) return { ok: false, error: body.error ?? 'They ended this connection', ended: true }
        return { ok: false, error: body.error ?? `They refused the event stream (HTTP ${response.status})` }
      }
      if (!response.body) {
        this.streams.delete(peerId)
        return { ok: false, error: 'They did not return an event stream' }
      }
      const reader = response.body.getReader()
      void (async () => {
        try {
          for (;;) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch {
        }
        if (this.streams.get(peerId) !== controller) return
        if (controller.signal.aborted) return this.dropConnection(peerId, { state: 'idle' }, false)
        await this.retryStream(peerId, grant, attempt + 1, generation)
      })()
      return { ok: true, data: true }
    } catch (error) {
      this.streams.delete(peerId)
      return { ok: false, error: `Could not open the event stream: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private async retryStream(peerId: string, grant: PeerGrantView, attempt: number, generation: number): Promise<void> {
    await this.waitForReconnect(peerId)
    if (generation !== this.generation(peerId)) return
    if (attempt > RECONNECT_ATTEMPTS) {
      return this.dropConnection(peerId, {
        state: 'failed',
        error: 'The connection dropped and could not be re-established; connecting again needs their approval'
      })
    }
    const opened = await this.openStream(peerId, grant, attempt, generation)
    if (opened.ok) return
    if (opened.ended) return this.dropConnection(peerId, { state: 'ended' })
    await this.retryStream(peerId, grant, attempt + 1, generation)
  }

  private waitForReconnect(peerId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => resolve()
      const timer = setTimeout(wake, RECONNECT_DELAY_MS)
      timer.unref?.()
      this.reconnects.set(peerId, { timer, wake })
    })
  }

  private cancelReconnect(peerId: string): void {
    const pending = this.reconnects.get(peerId)
    if (!pending) return
    this.reconnects.delete(peerId)
    clearTimeout(pending.timer)
    pending.wake()
  }

  private generation(peerId: string): number {
    return this.generations.get(peerId) ?? 0
  }

  private dropConnection(peerId: string, state: PeerConnectionState = { state: 'idle' }, abort = true): void {
    const controller = this.streams.get(peerId)
    this.streams.delete(peerId)
    if (abort) controller?.abort()
    this.cancelReconnect(peerId)
    this.generations.set(peerId, this.generation(peerId) + 1)
    this.setState(peerId, state)
  }

  disconnect(peerId: string): void {
    if (this.streams.has(peerId) || this.reconnects.has(peerId) || this.connections.get(peerId)?.state === 'connected') this.dropConnection(peerId)
  }

  sessions(peerId: string): Promise<Result<{ projects: Array<{ id: string; name: string }>; sessions: unknown[] }>> {
    return this.request(peerId, '/remote/v1/peer/sessions')
  }

  history(peerId: string, sessionId: string, before?: string): Promise<Result<unknown>> {
    const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) })
    return this.request(peerId, `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}?${query}`)
  }

  send(peerId: string, sessionId: string, text: string): Promise<Result<unknown>> {
    return this.request(peerId, `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: { text }, idempotent: true })
  }

  startSession(peerId: string, projectId: string, text: string): Promise<Result<{ sessionId: string | null; runId: string; projectId: string }>> {
    return this.request(peerId, `/remote/v1/peer/projects/${encodeURIComponent(projectId)}/sessions`, { method: 'POST', body: { text }, idempotent: true })
  }

  abort(peerId: string, runId: string): Promise<Result<unknown>> {
    return this.request(peerId, '/remote/v1/peer/runs/abort', { method: 'POST', body: { runId }, idempotent: true })
  }

  async importSession(peerId: string, sessionId: string, via: 'transfer' | 'collab' = 'transfer'): Promise<Result<PeerImportView>> {
    const exportPath = via === 'collab'
      ? `/remote/v1/peer/collab/sessions/${encodeURIComponent(sessionId)}/export`
      : `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}/export`
    const exported = await this.request<PeerSessionExport>(peerId, exportPath, { timeoutMs: 60_000 })
    if (!exported.ok) return exported
    const pack = exported.data
    if (pack?.version !== 1 || !pack.source || !Array.isArray(pack.messages)) {
      return { ok: false, error: 'The export package they returned is not in the expected format', code: 'export-invalid' }
    }
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'The token expired; pair again', code: 'peer-auth-missing' }
    const importId = `imp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const dir = join(IMPORTS_DIR, importId)
    const artifactDir = join(dir, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    const connection = this.connections.get(peerId)
    const artifacts: PeerImportView['artifacts'] = []
    for (const artifact of pack.artifacts ?? []) {
      if (!artifact.available) {
        artifacts.push({ id: artifact.id, filename: artifact.filename, status: 'missing' })
        continue
      }
      if (artifact.bytes > PEER_ARTIFACT_MAX_BYTES) {
        artifacts.push({ id: artifact.id, filename: artifact.filename, status: 'too_large' })
        continue
      }
      try {
        const response = await fetch(`${auth.peer.address}/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.id)}`, {
          headers: {
            authorization: `Bearer ${auth.token}`,
            ...(connection?.state === 'connected' ? { [PEER_CONNECTION_HEADER]: connection.grant.connectionId } : {})
          },
          signal: AbortSignal.timeout(60_000)
        })
        const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null
        if (!bytes || bytes.byteLength > PEER_ARTIFACT_MAX_BYTES) throw new Error('unavailable')
        await writeFile(join(artifactDir, `${safeFileName(artifact.id)}-${safeFileName(artifact.filename)}`), bytes)
        artifacts.push({ id: artifact.id, filename: artifact.filename, status: 'copied' })
      } catch {
        artifacts.push({ id: artifact.id, filename: artifact.filename, status: 'missing' })
      }
    }
    const view: PeerImportView = {
      id: importId,
      kind: 'session',
      title: pack.source.title,
      computer: pack.source.computer,
      projectName: pack.source.projectName,
      sourceSessionId: pack.source.sessionId,
      importedAt: Date.now(),
      exportedAt: pack.source.exportedAt,
      messageCount: pack.messages.length,
      ...(sanitizePrRefs(pack.source.prRefs).length ? { prRefs: sanitizePrRefs(pack.source.prRefs) } : {}),
      artifacts
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...view, source: pack.source, truncated: pack.truncated, via: auth.peer.address }, null, 2), 'utf8')
    await writeFile(join(dir, 'messages.json'), JSON.stringify(pack.messages), 'utf8')
    return { ok: true, data: view }
  }

  async listImports(): Promise<PeerImportView[]> {
    const names = await readdir(IMPORTS_DIR).catch(() => [] as string[])
    const out: PeerImportView[] = []
    for (const name of names) {
      if (!/^imp-[A-Za-z0-9-]+$/.test(name)) continue
      try {
        const manifest = JSON.parse(await readFile(join(IMPORTS_DIR, name, 'manifest.json'), 'utf8')) as PeerImportView
        out.push({
          id: manifest.id,
          kind: 'session',
          title: manifest.title,
          computer: manifest.computer,
          projectName: manifest.projectName,
          sourceSessionId: manifest.sourceSessionId,
          importedAt: manifest.importedAt,
          exportedAt: manifest.exportedAt,
          messageCount: manifest.messageCount,
          ...(sanitizePrRefs(manifest.prRefs).length ? { prRefs: sanitizePrRefs(manifest.prRefs) } : {}),
          artifacts: manifest.artifacts ?? []
        })
      } catch {
      }
    }
    return out.sort((a, b) => b.importedAt - a.importedAt)
  }

  async readImport(importId: string): Promise<Result<{ dir: string; messages: unknown[] }>> {
    if (!/^imp-[A-Za-z0-9-]+$/.test(importId)) return { ok: false, error: 'That import id is not valid', code: 'import-invalid' }
    const dir = join(IMPORTS_DIR, importId)
    try {
      return { ok: true, data: { dir, messages: JSON.parse(await readFile(join(dir, 'messages.json'), 'utf8')) as unknown[] } }
    } catch {
      return { ok: false, error: 'This copy no longer exists or is damaged', code: 'import-missing' }
    }
  }
}
