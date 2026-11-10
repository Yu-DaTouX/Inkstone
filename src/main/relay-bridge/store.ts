import { pick } from '../../shared/ui-lang'
import { createHash, randomUUID, type webcrypto } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exportKeyPair, generateKeyPair, importKeyPair, randomB64u, sha256, toB64u, type KeyPair } from './crypto'

export const RELAY_PAIR_TTL_MS = 10 * 60_000
const MAX_CLIENTS = 16

export type RelayClientKind = 'phone' | 'peer' | 'agent'

export interface RelayClient {
  id: string
  key: string
  name: string
  kind: RelayClientKind
  addedAt: number
  lastSeenAt: number | null
  revokedAt: number | null
  pairedAt: number | null
  pendingUntil: number | null
}

const KINDS: RelayClientKind[] = ['phone', 'peer', 'agent']

interface StoredState {
  version: 1
  secret: string
  hostKey: webcrypto.JsonWebKey
  clients: RelayClient[]
}

const hash = (code: string) => createHash('sha256').update(code).digest('hex')

export async function roomIdFor(secret: string): Promise<string> {
  return toB64u(await sha256(new TextEncoder().encode(`reef-room:${secret}`))).slice(0, 22)
}

export class RelayBridgeStore {
  private readonly file: string
  private state: StoredState | null = null
  private key: KeyPair | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly codes = new Map<string, { kind: RelayClientKind | 'any'; expiresAt: number }>()

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'relay-bridge.json')
  }

  private loading: Promise<StoredState> | null = null

  private async load(): Promise<StoredState> {
    if (this.state) return this.state
    this.loading ??= this.readState().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async readState(): Promise<StoredState> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.createFreshState()
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoredState>
      if (parsed?.version === 1 && typeof parsed.secret === 'string' && parsed.hostKey && Array.isArray(parsed.clients)) {
        this.state = {
          version: 1,
          secret: parsed.secret,
          hostKey: parsed.hostKey,
          clients: parsed.clients
            .filter((c) => typeof c?.id === 'string' && typeof c.key === 'string' && KINDS.includes(c.kind))
            .map((c) => ({
              ...c,
              pairedAt: typeof c.pairedAt === 'number' ? c.pairedAt : (c.revokedAt === null ? c.addedAt : null),
              pendingUntil: typeof c.pendingUntil === 'number' ? c.pendingUntil : null
            }))
        }
        return this.state
      }
      throw new Error(pick('中继配对存储格式无效', 'Invalid relay pairing store format'))
    } catch (error) {
      const backup = `${this.file}.${hash(text).slice(0, 16)}.corrupt`
      await copyFile(this.file, backup).catch(() => undefined)
      throw error
    }
  }

  private async createFreshState(): Promise<StoredState> {
    const pair = await generateKeyPair()
    const state: StoredState = { version: 1, secret: randomB64u(24), hostKey: (await exportKeyPair(pair)) as webcrypto.JsonWebKey, clients: [] }
    try {
      await this.save(state)
    } catch (error) {
      this.state = null
      this.key = null
      throw error
    }
    this.state = state
    this.key = pair
    return state
  }

  private save(state: StoredState | null = this.state): Promise<void> {
    const snapshot = JSON.stringify(state ?? this.state, null, 2)
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, this.file)
        await chmod(this.file, 0o600).catch(() => undefined)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    }
    const task = this.writing.then(write, write)
    this.writing = task.catch(() => undefined)
    return task
  }

  private queue: Promise<unknown> = Promise.resolve()

  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  async hostKey(): Promise<KeyPair> {
    const state = await this.load()
    this.key ??= await importKeyPair(state.hostKey as Parameters<typeof importKeyPair>[0])
    return this.key
  }

  async secret(): Promise<string> {
    return (await this.load()).secret
  }

  startPairing(kind: RelayClientKind | 'any'): { code: string; expiresAt: number } {
    const code = randomB64u(16)
    const expiresAt = this.now() + RELAY_PAIR_TTL_MS
    for (const [h, entry] of this.codes) if (entry.expiresAt <= this.now()) this.codes.delete(h)
    this.codes.set(hash(code), { kind, expiresAt })
    return { code, expiresAt }
  }

  private async expireLocked(state: StoredState): Promise<string[]> {
    const now = this.now()
    const expired = state.clients.filter((c) => c.revokedAt === null && c.pairedAt === null && c.pendingUntil !== null && c.pendingUntil <= now)
    if (!expired.length) return []
    const ids = new Set(expired.map((c) => c.id))
    state.clients = state.clients.map((c) => (ids.has(c.id) ? { ...c, revokedAt: now } : c))
    await this.save().catch(() => undefined)
    return [...ids]
  }

  async expireUnpaired(): Promise<string[]> {
    return this.mutate(async () => this.expireLocked(await this.load()))
  }

  authenticate(clientKey: string, name: string, code: string | undefined, declared?: RelayClientKind): Promise<{ ok: true; client: RelayClient } | { ok: false; reason: string }> {
    return this.mutate(async () => {
      const state = await this.load()
      await this.expireLocked(state)
      const known = state.clients.find((c) => c.key === clientKey)
      if (known && known.revokedAt === null) {
        const now = this.now()
        const next = state.clients.map((c) => (c.id === known.id ? { ...c, lastSeenAt: now } : c))
        state.clients = next
        void this.save().catch(() => undefined)
        return { ok: true, client: { ...known, lastSeenAt: now } }
      }
      if (known && known.revokedAt !== null && !code) return { ok: false, reason: pick('这台设备已被撤销，请重新配对', 'This device was revoked. Pair again') }
      if (!code) return { ok: false, reason: pick('需要配对：请在电脑上生成中继配对二维码', 'Pairing required: generate a relay pairing QR code on the computer') }
      const h = hash(code)
      const entry = this.codes.get(h)
      if (!entry || entry.expiresAt <= this.now()) return { ok: false, reason: pick('配对码无效或已过期，请在电脑上重新生成', 'Pairing code is invalid or expired. Generate a new one on the computer') }
      if (declared !== undefined && entry.kind !== 'any' && entry.kind !== declared) {
        return { ok: false, reason: pick('这个配对码不属于这类设备，请在电脑上重新生成', 'This pairing code is not for this kind of device. Generate a new one on the computer') }
      }
      const kind: RelayClientKind = entry.kind === 'any' ? (declared ?? 'phone') : entry.kind
      if (state.clients.filter((c) => c.revokedAt === null).length >= MAX_CLIENTS) {
        return { ok: false, reason: pick('已配对的设备太多，请先在电脑上移除不用的', 'Too many paired devices. Remove unused ones on the computer first') }
      }
      const now = this.now()
      const client: RelayClient = {
        id: `relay-${randomUUID()}`,
        key: clientKey,
        name: (name || pick('未命名设备', 'Unnamed device')).replace(/[\u0000-\u001f]/g, '').slice(0, 60),
        kind,
        addedAt: now,
        lastSeenAt: now,
        revokedAt: null,
        pairedAt: null,
        pendingUntil: now + RELAY_PAIR_TTL_MS
      }
      const next = [...state.clients.filter((c) => c.key !== clientKey), client]
      await this.save({ ...state, clients: next })
      state.clients = next
      this.codes.delete(h)
      return { ok: true, client: { ...client } }
    })
  }

  markPaired(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const state = await this.load()
      const client = state.clients.find((c) => c.id === id && c.revokedAt === null)
      if (!client || client.pairedAt !== null) return false
      const next = state.clients.map((c) => (c.id === id ? { ...c, pairedAt: this.now(), pendingUntil: null } : c))
      try {
        await this.save({ ...state, clients: next })
      } catch {
        return false
      }
      state.clients = next
      return true
    })
  }

  list(): Promise<RelayClient[]> {
    return this.mutate(async () => {
      const state = await this.load()
      await this.expireLocked(state)
      return state.clients.map((c) => ({ ...c }))
    })
  }

  async isActive(id: string): Promise<boolean> {
    const list = await this.list()
    return list.some((c) => c.id === id && c.revokedAt === null)
  }

  revoke(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const state = await this.load()
      if (!state.clients.some((c) => c.id === id && c.revokedAt === null)) return false
      const next = state.clients.map((c) => (c.id === id ? { ...c, revokedAt: this.now() } : c))
      try {
        await this.save({ ...state, clients: next })
      } catch {
        return false
      }
      state.clients = next
      return true
    })
  }

  forget(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const state = await this.load()
      const next = state.clients.filter((c) => c.id !== id || c.revokedAt === null)
      if (next.length === state.clients.length) return false
      try {
        await this.save({ ...state, clients: next })
      } catch {
        return false
      }
      state.clients = next
      return true
    })
  }

  resetIdentity(): Promise<void> {
    return this.mutate(async () => {
      const state = await this.load()
      const previousKey = this.key
      const pair = await generateKeyPair()
      const next: StoredState = {
        version: 1,
        secret: randomB64u(24),
        hostKey: (await exportKeyPair(pair)) as webcrypto.JsonWebKey,
        clients: []
      }
      try {
        await this.save(next)
      } catch (error) {
        this.state = state
        this.key = previousKey
        throw error
      }
      this.state = next
      this.key = pair
      this.codes.clear()
    })
  }
}
