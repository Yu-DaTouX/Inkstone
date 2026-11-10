import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { COLLAB_BUNDLE_MAX_BYTES } from '../shared/collab'
import { formatHostFingerprint } from '../shared/host-identity'
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
import { newPeerTunnelKeys, PeerTunnel, tunnelUrlFor, type PeerTunnelKeys } from './peer-tunnel'
import { fromB64u, sha256 } from './relay-bridge/crypto'

const PEERS_FILE = join(YAN_DIR, 'peers.json')
const IMPORTS_DIR = join(YAN_DIR, 'peer-imports')
const PEER_JSON_MAX_BYTES = 16 * 1024 * 1024
const PEER_EXPORT_MAX_BYTES = 64 * 1024 * 1024

interface StoredPeer extends PeerRecordView {
  deviceId: string
  token: string
  hostKey?: string
  keys?: string
}

interface PeersFile {
  version: 1
  peers: StoredPeer[]
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export type PeerDownload<T> = { kind: 'file'; bytes: number } | { kind: 'json'; data: T }

export interface PeerIdentity {
  computer: string
  fingerprint: string
}

export interface PeerTransport {
  call<T>(peerId: string, path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<Result<T>>
  download<T>(peerId: string, path: string, body: unknown, file: string): Promise<Result<PeerDownload<T>>>
  upload<T>(peerId: string, path: string, file: string | null): Promise<Result<T>>
}

function sealText(text: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(text).toString('base64')}`
  return `raw:${text}`
}

function openText(sealed: string): string | null {
  try {
    if (sealed.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(sealed.slice(4), 'base64'))
    if (sealed.startsWith('raw:')) return sealed.slice(4)
  } catch {
  }
  return null
}

function sealKeys(keys: PeerTunnelKeys): string {
  return sealText(JSON.stringify(keys))
}

function openKeys(sealed: string | undefined): PeerTunnelKeys | null {
  if (!sealed) return null
  const text = openText(sealed)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as Partial<PeerTunnelKeys>
    return typeof parsed.publicKey === 'string' && parsed.privateJwk ? { publicKey: parsed.publicKey, privateJwk: parsed.privateJwk } : null
  } catch {
    return null
  }
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
const PAIR_INVITE_TIMEOUT_MS = 15_000

function connectionEnded(code: string | undefined): boolean {
  return code === 'peer_connection_required' || code === 'unauthorized'
}

export async function peerHostFingerprint(hostKey: string): Promise<string> {
  return formatHostFingerprint(await sha256(fromB64u(hostKey)))
}

interface PairInvite {
  hostKey: string
  code: string
  hostFingerprint: string
  computer: string
}

export class PeerClient implements PeerTransport {
  private peers: StoredPeer[] | null = null
  private loading: Promise<StoredPeer[]> | null = null
  private saving: Promise<void> = Promise.resolve()
  private readonly connections = new Map<string, PeerConnectionState>()
  private readonly streams = new Map<string, () => void>()
  private readonly reconnects = new Map<string, { timer: ReturnType<typeof setTimeout>; wake: () => void }>()
  private readonly generations = new Map<string, number>()
  private readonly tunnels = new Map<string, PeerTunnel>()

  private load(): Promise<StoredPeer[]> {
    if (this.peers) return Promise.resolve(this.peers)
    this.loading ??= this.readPeers().then((peers) => {
      this.peers = peers
      return peers
    }).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async readPeers(): Promise<StoredPeer[]> {
    let text: string
    try {
      text = await readFile(PEERS_FILE, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed = JSON.parse(text) as Partial<PeersFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.peers)) throw new SyntaxError('invalid peers file')
      return parsed.peers.filter((peer) => typeof peer?.id === 'string' && typeof peer.token === 'string')
    } catch {
      await copyFile(PEERS_FILE, `${PEERS_FILE}.${Date.now()}.corrupt`).catch(() => undefined)
      return []
    }
  }

  private save(): Promise<void> {
    const run = this.saving.catch(() => undefined).then(() => this.writePeers())
    this.saving = run
    return run
  }

  private async writePeers(): Promise<void> {
    await mkdir(YAN_DIR, { recursive: true })
    const temp = `${PEERS_FILE}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ version: 1, peers: this.peers ?? [] } satisfies PeersFile, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, PEERS_FILE)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
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

  private async inviteOf(address: string): Promise<Result<PairInvite>> {
    try {
      const response = await fetch(`${address}/remote/v1/tunnel/invite`, { signal: AbortSignal.timeout(PAIR_INVITE_TIMEOUT_MS) })
      if (!response.ok) {
        return { ok: false, error: 'That desktop did not offer an encrypted channel. Update Inkstone there and generate a pairing code again', code: 'peer-no-tunnel' }
      }
      const body = (await response.json()) as { ok?: boolean; hostKey?: unknown; code?: unknown; computer?: { name?: unknown }; hostFingerprint?: unknown }
      if (!body.ok || typeof body.hostKey !== 'string' || typeof body.code !== 'string') {
        return { ok: false, error: 'That desktop returned an invalid encrypted channel', code: 'peer-no-tunnel' }
      }
      const hostKey = body.hostKey
      const fingerprint = await peerHostFingerprint(hostKey)
      if (typeof body.hostFingerprint === 'string' && body.hostFingerprint && body.hostFingerprint !== fingerprint) {
        return { ok: false, error: 'The identity that desktop reported does not match the key it sent. Someone may be impersonating it; pairing stopped', code: 'peer-identity-mismatch' }
      }
      return { ok: true, data: { hostKey, code: body.code, hostFingerprint: fingerprint, computer: String(body.computer?.name ?? address).slice(0, 80) } }
    } catch (error) {
      return { ok: false, error: `Could not reach them: ${error instanceof Error ? error.message : String(error)}`, code: 'peer-unreachable' }
    }
  }

  async pair(addressInput: string, code: string, confirm: (identity: PeerIdentity) => Promise<boolean>): Promise<Result<PeerRecordView>> {
    if (typeof confirm !== 'function') {
      return { ok: false, error: 'Pairing another Inkstone requires confirming the identity fingerprint shown on it', code: 'pair-identity-required' }
    }
    const address = normalizePeerAddress(addressInput)
    if (!address) {
      return { ok: false, error: 'That address is not in the right format, for example 100.101.102.103:37892', code: 'address-invalid' }
    }
    const invite = await this.inviteOf(address)
    if (!invite.ok) return invite
    const identity: PeerIdentity = { computer: invite.data.computer, fingerprint: invite.data.hostFingerprint }
    if (!(await confirm(identity))) {
      return { ok: false, error: 'Pairing was cancelled because the desktop identity was not confirmed', code: 'pair-cancelled' }
    }
    const keys = await newPeerTunnelKeys()
    const tunnel = new PeerTunnel({ url: tunnelUrlFor(address), hostKey: invite.data.hostKey, keys, deviceName: hostname().slice(0, 60), pairingCode: invite.data.code })
    try {
      await tunnel.connect()
      const reply = await tunnel.request('POST', '/remote/v1/pair', { body: { code: code.trim(), deviceName: hostname(), kind: 'peer' }, timeoutMs: 20_000, maxBytes: 64 * 1024 })
      let body: { ok?: boolean; error?: string; deviceId?: string; token?: string; computer?: { name?: string } } = {}
      try {
        body = JSON.parse(reply.text) as typeof body
      } catch {
      }
      if (!body.ok || !body.token || !body.deviceId) {
        return { ok: false, error: body.error ?? `Pairing failed (HTTP ${reply.status})`, code: 'pair-failed' }
      }
      const peers = await this.load()
      const peer: StoredPeer = {
        id: `peer-${randomUUID()}`,
        computer: String(body.computer?.name ?? identity.computer).slice(0, 80),
        address,
        pairedAt: Date.now(),
        deviceId: body.deviceId,
        token: sealText(body.token),
        hostKey: invite.data.hostKey,
        keys: sealKeys(keys)
      }
      peers.push(peer)
      await this.save()
      this.tunnels.set(peer.id, tunnel)
      return { ok: true, data: { id: peer.id, computer: peer.computer, address: peer.address, pairedAt: peer.pairedAt } }
    } catch (error) {
      tunnel.close()
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message, code: 'peer-unreachable' }
    }
  }

  async remove(peerId: string): Promise<boolean> {
    await this.bestEffort(peerId, '/remote/v1/devices/self/revoke', {})
    this.disconnect(peerId)
    this.dropTunnel(peerId)
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
      const tunnel = await this.tunnelOf(auth.peer)
      await tunnel.request('POST', path, { headers: { authorization: `Bearer ${auth.token}` }, body, timeoutMs: PEER_NOTICE_TIMEOUT_MS, maxBytes: 64 * 1024 })
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
    const token = peer ? openText(peer.token) : null
    return peer && token ? { peer, token } : null
  }

  private async tunnelOf(peer: StoredPeer): Promise<PeerTunnel> {
    const existing = this.tunnels.get(peer.id)
    if (existing?.connected) return existing
    const keys = openKeys(peer.keys)
    if (!peer.hostKey || !keys) throw new Error('This computer was paired before encrypted transfer; pair it again')
    const tunnel = new PeerTunnel({ url: tunnelUrlFor(peer.address), hostKey: peer.hostKey, keys, deviceName: hostname().slice(0, 60) })
    this.tunnels.set(peer.id, tunnel)
    try {
      await tunnel.connect()
      return tunnel
    } catch (error) {
      this.tunnels.delete(peer.id)
      tunnel.close()
      throw error
    }
  }

  private dropTunnel(peerId: string): void {
    const tunnel = this.tunnels.get(peerId)
    this.tunnels.delete(peerId)
    tunnel?.close()
  }

  private async request<T>(peerId: string, path: string, init: { method?: string; body?: unknown; idempotent?: boolean; timeoutMs?: number; maxBytes?: number } = {}): Promise<Result<T>> {
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
        const tunnel = await this.tunnelOf(auth.peer)
        const reply = await tunnel.request(init.method === 'POST' ? 'POST' : 'GET', path, {
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          timeoutMs: init.timeoutMs ?? 30_000,
          maxBytes: init.maxBytes ?? PEER_JSON_MAX_BYTES
        })
        let body: { ok?: boolean; data?: T; error?: string; code?: string } = {}
        try {
          body = JSON.parse(reply.text) as typeof body
        } catch {
        }
        if (reply.status < 200 || reply.status >= 300 || !body.ok) {
          if (connectionEnded(body.code)) this.dropConnection(peerId, { state: 'ended' }, false)
          return { ok: false, error: body.error ?? `Request failed (HTTP ${reply.status})`, code: body.code ?? 'peer-request-failed' }
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

  async download<T>(peerId: string, path: string, body: unknown, file: string): Promise<Result<PeerDownload<T>>> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'That computer could not be found or the token expired; pair again', code: 'peer-auth-missing' }
    const connection = this.connections.get(peerId)
    const headers: Record<string, string> = { authorization: `Bearer ${auth.token}` }
    if (connection?.state === 'connected') headers[PEER_CONNECTION_HEADER] = connection.grant.connectionId
    try {
      const tunnel = await this.tunnelOf(auth.peer)
      const reply = await tunnel.download(path, body, file, COLLAB_BUNDLE_MAX_BYTES, TRANSFER_TIMEOUT_MS, headers)
      if (reply.status < 200 || reply.status >= 300) {
        const parsed = ((): { ok?: boolean; error?: string; code?: string } => {
          try {
            return JSON.parse(reply.text) as { error?: string; code?: string }
          } catch {
            return {}
          }
        })()
        if (connectionEnded(parsed.code)) this.dropConnection(peerId, { state: 'ended' })
        return { ok: false, error: parsed.error ?? `Request failed (HTTP ${reply.status})`, ...(parsed.code ? { code: parsed.code } : {}) }
      }
      if ((reply.headers['content-type'] ?? '').includes('application/json')) {
        const parsed = ((): { ok?: boolean; data?: T; error?: string } => {
          try {
            return JSON.parse(reply.text) as { ok?: boolean; data?: T; error?: string }
          } catch {
            return {}
          }
        })()
        return parsed.ok
          ? { ok: true, data: { kind: 'json', data: parsed.data as T } }
          : { ok: false, error: parsed.error ?? 'They returned a failure', code: 'peer-request-failed' }
      }
      const info = await stat(file).catch(() => null)
      const bytes = info?.size ?? reply.bytes
      if (bytes > COLLAB_BUNDLE_MAX_BYTES) {
        await rm(file, { force: true }).catch(() => undefined)
        return { ok: false, error: 'The code bundle is over the size limit', code: 'bundle-too-large' }
      }
      return { ok: true, data: { kind: 'file', bytes } }
    } catch (error) {
      await rm(file, { force: true }).catch(() => undefined)
      const code = (error as { code?: string }).code
      return { ok: false, error: `Download failed: ${error instanceof Error ? error.message : String(error)}`, ...(code ? { code } : {}) }
    }
  }

  async upload<T>(peerId: string, path: string, file: string | null): Promise<Result<T>> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'That computer could not be found or the token expired; pair again', code: 'peer-auth-missing' }
    const connection = this.connections.get(peerId)
    const headers: Record<string, string> = { authorization: `Bearer ${auth.token}`, 'content-type': 'application/octet-stream' }
    if (connection?.state === 'connected') headers[PEER_CONNECTION_HEADER] = connection.grant.connectionId
    try {
      const tunnel = await this.tunnelOf(auth.peer)
      const reply = file
        ? await tunnel.upload(path, file, headers)
        : await tunnel.request('POST', path, { headers, timeoutMs: TRANSFER_TIMEOUT_MS, maxBytes: 64 * 1024 })
      let parsed: { ok?: boolean; data?: T; error?: string; code?: string } = {}
      try {
        parsed = JSON.parse(reply.text) as typeof parsed
      } catch {
      }
      if (reply.status < 200 || reply.status >= 300 || !parsed.ok) {
        if (connectionEnded(parsed.code)) this.dropConnection(peerId, { state: 'ended' })
        return { ok: false, error: parsed.error ?? `Request failed (HTTP ${reply.status})`, code: parsed.code ?? 'peer-request-failed' }
      }
      return { ok: true, data: parsed.data as T }
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
      this.setState(peerId, { state: 'failed', error: result.error, ...(result.code ? { code: result.code } : {}) })
      return result
    }
    const grant = result.data.grant
    const opened = await this.openStream(peerId, grant)
    if (!opened.ok) {
      if (opened.ended) this.dropConnection(peerId, { state: 'ended' })
      else this.setState(peerId, { state: 'failed', error: opened.error, code: 'event-stream-failed' })
      return { ok: false, error: opened.error, code: 'event-stream-failed' }
    }
    this.setState(peerId, { state: 'connected', grant })
    return { ok: true, data: grant }
  }

  private async openStream(peerId: string, grant: PeerGrantView, attempt = 0, generation = this.generation(peerId)): Promise<{ ok: true } | { ok: false; error: string; ended?: boolean }> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: 'The token expired; pair again' }
    let tunnel: PeerTunnel
    try {
      tunnel = await this.tunnelOf(auth.peer)
    } catch (error) {
      return { ok: false, error: `Could not open the event stream: ${error instanceof Error ? error.message : String(error)}` }
    }
    let ended = false
    let stop: (() => void) | null = null
    const opened = await tunnel.openStream('/remote/v1/peer/events', {
      authorization: `Bearer ${auth.token}`,
      [PEER_CONNECTION_HEADER]: grant.connectionId,
      accept: 'text/event-stream'
    }, (error) => {
      if (stop && this.streams.get(peerId) !== stop) return
      this.streams.delete(peerId)
      if (ended) return
      if (!error) {
        if (generation !== this.generation(peerId)) return
        void this.retryStream(peerId, grant, attempt + 1, generation)
        return
      }
      const code = (error as { code?: string }).code
      if (code === 'tunnel-denied' || /connection|approval|expired/i.test(error.message)) {
        ended = true
        return this.dropConnection(peerId, { state: 'ended' }, false)
      }
      if (generation !== this.generation(peerId)) return
      void this.retryStream(peerId, grant, attempt + 1, generation)
    })
    if (!opened.ok) {
      let code: string | undefined
      try {
        code = (JSON.parse(opened.text) as { code?: string }).code
      } catch {
      }
      if (connectionEnded(code)) return { ok: false, error: 'They ended this connection', ended: true }
      return { ok: false, error: `They refused the event stream (HTTP ${opened.status})` }
    }
    stop = opened.stop
    this.streams.set(peerId, opened.stop)
    return { ok: true }
  }

  private async retryStream(peerId: string, grant: PeerGrantView, attempt: number, generation: number): Promise<void> {
    await this.waitForReconnect(peerId)
    if (generation !== this.generation(peerId)) return
    if (attempt > RECONNECT_ATTEMPTS) {
      return this.dropConnection(peerId, {
        state: 'failed',
        error: 'The connection dropped and could not be re-established; connecting again needs their approval',
        code: 'connection-lost'
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
    const stop = this.streams.get(peerId)
    this.streams.delete(peerId)
    if (abort) stop?.()
    this.cancelReconnect(peerId)
    this.generations.set(peerId, this.generation(peerId) + 1)
    this.setState(peerId, state)
  }

  closeAll(): void {
    for (const peerId of [...this.streams.keys()]) this.dropConnection(peerId, { state: 'idle' }, true)
    for (const peerId of [...this.tunnels.keys()]) this.dropTunnel(peerId)
  }

  disconnect(peerId: string): void {
    if (this.streams.has(peerId) || this.reconnects.has(peerId) || this.connections.get(peerId)?.state === 'connected') this.dropConnection(peerId)
  }

  sessions(peerId: string): Promise<Result<{ projects: Array<{ id: string; name: string }>; sessions: unknown[] }>> {
    return this.request(peerId, '/remote/v1/peer/sessions')
  }

  history(peerId: string, sessionId: string, before?: string): Promise<Result<unknown>> {
    const query = new URLSearchParams({ limit: '50', ...(before ? { before } : {}) })
    return this.request(peerId, `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}?${query}`, { maxBytes: PEER_EXPORT_MAX_BYTES })
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
    const exported = await this.request<PeerSessionExport>(peerId, exportPath, { timeoutMs: 60_000, maxBytes: PEER_EXPORT_MAX_BYTES })
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
        const tunnel = await this.tunnelOf(auth.peer)
        const reply = await tunnel.request('GET', `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.id)}`, {
          headers: {
            authorization: `Bearer ${auth.token}`,
            ...(connection?.state === 'connected' ? { [PEER_CONNECTION_HEADER]: connection.grant.connectionId } : {})
          },
          timeoutMs: 60_000,
          maxBytes: PEER_ARTIFACT_MAX_BYTES
        })
        if (reply.status < 200 || reply.status >= 300 || reply.bytes > PEER_ARTIFACT_MAX_BYTES) throw new Error('unavailable')
        await writeFile(join(artifactDir, `${safeFileName(artifact.id)}-${safeFileName(artifact.filename)}`), reply.body)
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
