import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  PEER_APPROVAL_TIMEOUT_MS,
  PEER_ARTIFACT_MAX_BYTES,
  PEER_CONNECTION_HEADER,
  type PeerConnectionState,
  type PeerGrantView,
  type PeerImportView,
  type PeerKnowledgeExport,
  type PeerOperation,
  type PeerRecordView,
  type PeerSessionExport,
  type PeerStatusView
} from '../shared/peer-protocol'
import type { ProjectRecord } from '../shared/ipc'
import { YAN_DIR } from './paths'
import { commitKnowledge } from './project-memory-store'

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

type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

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

export class PeerClient {
  private peers: StoredPeer[] | null = null
  private readonly connections = new Map<string, PeerConnectionState>()
  private readonly streams = new Map<string, AbortController>()

  constructor(private readonly onChange: () => void = () => undefined) {}

  private async load(): Promise<StoredPeer[]> {
    if (this.peers) return this.peers
    try {
      const parsed = JSON.parse(await readFile(PEERS_FILE, 'utf8')) as Partial<PeersFile>
      this.peers = parsed.version === 1 && Array.isArray(parsed.peers) ? parsed.peers.filter((peer) => typeof peer?.id === 'string' && typeof peer.token === 'string') : []
    } catch {
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
    this.onChange()
  }

  async pair(addressInput: string, code: string): Promise<Result<PeerRecordView>> {
    const address = normalizePeerAddress(addressInput)
    if (!address) return { ok: false, error: '地址格式不对，例如 100.101.102.103:37892' }
    try {
      const response = await fetch(`${address}/remote/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), deviceName: `砚 · ${hostname()}`, kind: 'peer' }),
        signal: AbortSignal.timeout(15_000)
      })
      const body = (await response.json()) as { ok?: boolean; error?: string; deviceId?: string; token?: string; computer?: { name?: string } }
      if (!response.ok || !body.ok || !body.token || !body.deviceId) return { ok: false, error: body.error ?? `配对失败（HTTP ${response.status}）` }
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
      this.onChange()
      return { ok: true, data: { id: peer.id, computer: peer.computer, address: peer.address, pairedAt: peer.pairedAt } }
    } catch (error) {
      return { ok: false, error: `连不上对方：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async remove(peerId: string): Promise<boolean> {
    this.disconnect(peerId)
    const peers = await this.load()
    const index = peers.findIndex((peer) => peer.id === peerId)
    if (index < 0) return false
    peers.splice(index, 1)
    await this.save()
    this.connections.delete(peerId)
    this.onChange()
    return true
  }

  private async credentials(peerId: string): Promise<{ peer: StoredPeer; token: string } | null> {
    const peer = (await this.load()).find((item) => item.id === peerId)
    const token = peer ? openToken(peer.token) : null
    return peer && token ? { peer, token } : null
  }

  private async request<T>(peerId: string, path: string, init: { method?: string; body?: unknown; idempotent?: boolean; timeoutMs?: number } = {}): Promise<Result<T>> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: '找不到这台砚，或令牌已失效（请重新配对）' }
    const connection = this.connections.get(peerId)
    const headers: Record<string, string> = { authorization: `Bearer ${auth.token}` }
    if (connection?.state === 'connected') headers[PEER_CONNECTION_HEADER] = connection.grant.connectionId
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.idempotent) headers['idempotency-key'] = `peer-${randomUUID()}`
    try {
      const response = await fetch(`${auth.peer.address}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000)
      })
      const body = (await response.json()) as { ok?: boolean; data?: T; error?: string; code?: string }
      if (!response.ok || !body.ok) {
        if (body.code === 'peer_connection_required') this.dropConnection(peerId, '对方已结束本次连接，需要重新申请')
        return { ok: false, error: body.error ?? `请求失败（HTTP ${response.status}）`, code: body.code }
      }
      return { ok: true, data: body.data as T }
    } catch (error) {
      return { ok: false, error: `请求失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async connect(peerId: string, operations: PeerOperation[], note: string): Promise<Result<PeerGrantView>> {
    this.disconnect(peerId)
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
      this.setState(peerId, { state: 'failed', error: opened.error })
      return opened
    }
    this.setState(peerId, { state: 'connected', grant })
    return { ok: true, data: grant }
  }

  private async openStream(peerId: string, grant: PeerGrantView): Promise<Result<true>> {
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: '令牌已失效，请重新配对' }
    const controller = new AbortController()
    this.streams.set(peerId, controller)
    try {
      const response = await fetch(`${auth.peer.address}/remote/v1/peer/events`, {
        headers: { authorization: `Bearer ${auth.token}`, [PEER_CONNECTION_HEADER]: grant.connectionId, accept: 'text/event-stream' },
        signal: controller.signal
      })
      if (!response.ok || !response.body) {
        this.streams.delete(peerId)
        return { ok: false, error: `对方拒绝建立事件流（HTTP ${response.status}）` }
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
        if (this.streams.get(peerId) === controller) this.dropConnection(peerId, controller.signal.aborted ? null : '连接已断开；重新连接需要对方再次批准')
      })()
      return { ok: true, data: true }
    } catch (error) {
      this.streams.delete(peerId)
      return { ok: false, error: `事件流打开失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private dropConnection(peerId: string, reason: string | null): void {
    const controller = this.streams.get(peerId)
    this.streams.delete(peerId)
    controller?.abort()
    this.setState(peerId, reason ? { state: 'failed', error: reason } : { state: 'idle' })
  }

  disconnect(peerId: string): void {
    if (this.streams.has(peerId) || this.connections.get(peerId)?.state === 'connected') this.dropConnection(peerId, null)
  }

  disconnectAll(): void {
    for (const peerId of [...this.streams.keys()]) this.dropConnection(peerId, null)
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

  async importSession(peerId: string, sessionId: string): Promise<Result<PeerImportView>> {
    const exported = await this.request<PeerSessionExport>(peerId, `/remote/v1/peer/sessions/${encodeURIComponent(sessionId)}/export`, { timeoutMs: 60_000 })
    if (!exported.ok) return exported
    const pack = exported.data
    if (pack?.version !== 1 || !pack.source || !Array.isArray(pack.messages)) return { ok: false, error: '对方返回的导出包格式不对' }
    const auth = await this.credentials(peerId)
    if (!auth) return { ok: false, error: '令牌已失效，请重新配对' }
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
      artifacts
    }
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...view, source: pack.source, truncated: pack.truncated, via: auth.peer.address }, null, 2), 'utf8')
    await writeFile(join(dir, 'messages.json'), JSON.stringify(pack.messages), 'utf8')
    this.onChange()
    return { ok: true, data: view }
  }

  async importKnowledge(peerId: string, remoteProjectId: string, local: ProjectRecord): Promise<Result<{ accepted: number; rejected: number }>> {
    const exported = await this.request<PeerKnowledgeExport>(peerId, `/remote/v1/peer/projects/${encodeURIComponent(remoteProjectId)}/knowledge`)
    if (!exported.ok) return exported
    const pack = exported.data
    if (pack?.version !== 1 || !Array.isArray(pack.entries)) return { ok: false, error: '对方返回的项目记忆格式不对' }
    let accepted = 0
    let rejected = 0
    const tool = safeFileName(pack.source.computer).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'peer'
    for (const entry of pack.entries) {
      const outcome = await commitKnowledge({
        identity: { projectId: local.id, cwd: local.cwd },
        request: {
          kind: entry.kind,
          text: entry.text,
          tags: [`peer:${tool}`, ...entry.tags.slice(0, 8)],
          evidence: [{ excerpt: `来自 ${pack.source.computer} 的项目「${pack.source.projectName}」，条目 ${entry.id} 第 ${entry.revision} 版（${entry.confidenceClass}）`.slice(0, 480) }],
          confidenceClass: 'inferred',
          expectedRevision: 0
        }
      })
      if (outcome.ok) accepted += 1
      else rejected += 1
    }
    return { ok: true, data: { accepted, rejected } }
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
          artifacts: manifest.artifacts ?? []
        })
      } catch {
      }
    }
    return out.sort((a, b) => b.importedAt - a.importedAt)
  }

  async readImport(importId: string): Promise<Result<{ dir: string; messages: unknown[] }>> {
    if (!/^imp-[A-Za-z0-9-]+$/.test(importId)) return { ok: false, error: '导入 id 无效' }
    const dir = join(IMPORTS_DIR, importId)
    try {
      return { ok: true, data: { dir, messages: JSON.parse(await readFile(join(dir, 'messages.json'), 'utf8')) as unknown[] } }
    } catch {
      return { ok: false, error: '这份副本已不存在或已损坏' }
    }
  }
}
