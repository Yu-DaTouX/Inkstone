/**
 * 中继桥的持久状态：主机长期密钥、房间密钥、已登记的客户端公钥；一次性中继配对码只在内存里（存哈希）。
 *
 * 文件 `relay-bridge.json` 在砚数据目录，权限 0600。损坏时从空开始（所有客户端需重新配对，比误认更安全）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exportKeyPair, generateKeyPair, importKeyPair, randomB64u, sha256, toB64u, type KeyPair } from './crypto'

export const RELAY_PAIR_TTL_MS = 10 * 60_000
const MAX_CLIENTS = 16

export type RelayClientKind = 'phone' | 'agent'

export interface RelayClient {
  id: string
  /** 客户端长期公钥（base64url） */
  key: string
  name: string
  kind: RelayClientKind
  addedAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

interface StoredState {
  version: 1
  secret: string
  hostKey: JsonWebKey
  clients: RelayClient[]
}

const hash = (code: string) => createHash('sha256').update(code).digest('hex')

/** 房间号：b64u(SHA-256("reef-room:" + secret)) 前 22 位（与礁石中继一致）。 */
export async function roomIdFor(secret: string): Promise<string> {
  return toB64u(await sha256(new TextEncoder().encode(`reef-room:${secret}`))).slice(0, 22)
}

export class RelayBridgeStore {
  private readonly file: string
  private state: StoredState | null = null
  private key: KeyPair | null = null
  private writing: Promise<void> = Promise.resolve()
  /** code hash → 配对用途 */
  private readonly codes = new Map<string, { kind: RelayClientKind; expiresAt: number }>()

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'relay-bridge.json')
  }

  private async load(): Promise<StoredState> {
    if (this.state) return this.state
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredState>
      if (parsed?.version === 1 && typeof parsed.secret === 'string' && parsed.hostKey && Array.isArray(parsed.clients)) {
        this.state = {
          version: 1,
          secret: parsed.secret,
          hostKey: parsed.hostKey,
          clients: parsed.clients.filter((c) => typeof c?.id === 'string' && typeof c.key === 'string' && (c.kind === 'phone' || c.kind === 'agent'))
        }
        return this.state
      }
    } catch {
      /* 文件不存在或损坏：生成新的 */
    }
    const pair = await generateKeyPair()
    this.state = { version: 1, secret: randomB64u(24), hostKey: (await exportKeyPair(pair)) as JsonWebKey, clients: [] }
    this.key = pair
    await this.save()
    return this.state
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writing = this.writing.then(async () => {
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
    })
    return this.writing
  }

  async hostKey(): Promise<KeyPair> {
    const state = await this.load()
    this.key ??= await importKeyPair(state.hostKey as Parameters<typeof importKeyPair>[0])
    return this.key
  }

  async secret(): Promise<string> {
    return (await this.load()).secret
  }

  /** 生成一次性中继配对码（16 字节随机，10 分钟），绑定这次配对的客户端类型。 */
  startPairing(kind: RelayClientKind): { code: string; expiresAt: number } {
    const code = randomB64u(16)
    const expiresAt = this.now() + RELAY_PAIR_TTL_MS
    for (const [h, entry] of this.codes) if (entry.expiresAt <= this.now()) this.codes.delete(h)
    this.codes.set(hash(code), { kind, expiresAt })
    return { code, expiresAt }
  }

  /**
   * 握手后的认证：已登记且未撤销的公钥直接通过；否则必须带有效的一次性配对码，通过后登记。
   * 返回客户端记录；失败返回原因。
   */
  async authenticate(clientKey: string, name: string, code: string | undefined): Promise<{ ok: true; client: RelayClient } | { ok: false; reason: string }> {
    const state = await this.load()
    const known = state.clients.find((c) => c.key === clientKey)
    if (known && known.revokedAt === null) {
      known.lastSeenAt = this.now()
      void this.save().catch(() => undefined)
      return { ok: true, client: { ...known } }
    }
    if (known && known.revokedAt !== null && !code) return { ok: false, reason: '这台设备已被撤销，请重新配对' }
    if (!code) return { ok: false, reason: '需要配对：请在电脑上生成中继配对二维码' }
    // 配对码是 128 位随机数，只按哈希查表；猜中的概率可以忽略。
    const h = hash(code)
    const entry = this.codes.get(h)
    if (!entry || entry.expiresAt <= this.now()) return { ok: false, reason: '配对码无效或已过期，请在电脑上重新生成' }
    this.codes.delete(h)
    if (state.clients.filter((c) => c.revokedAt === null).length >= MAX_CLIENTS) return { ok: false, reason: '已配对的设备太多，请先在电脑上移除不用的' }
    const client: RelayClient = {
      id: `relay-${randomUUID()}`,
      key: clientKey,
      name: (name || '未命名设备').replace(/[\u0000-\u001f]/g, '').slice(0, 60),
      kind: entry.kind,
      addedAt: this.now(),
      lastSeenAt: this.now(),
      revokedAt: null
    }
    state.clients = state.clients.filter((c) => c.key !== clientKey)
    state.clients.push(client)
    await this.save()
    return { ok: true, client: { ...client } }
  }

  async list(): Promise<RelayClient[]> {
    return (await this.load()).clients.map((c) => ({ ...c }))
  }

  async isActive(id: string): Promise<boolean> {
    return (await this.load()).clients.some((c) => c.id === id && c.revokedAt === null)
  }

  async revoke(id: string): Promise<boolean> {
    const state = await this.load()
    const client = state.clients.find((c) => c.id === id && c.revokedAt === null)
    if (!client) return false
    client.revokedAt = this.now()
    await this.save()
    return true
  }

  async forget(id: string): Promise<boolean> {
    const state = await this.load()
    const before = state.clients.length
    state.clients = state.clients.filter((c) => c.id !== id || c.revokedAt === null)
    if (state.clients.length === before) return false
    await this.save()
    return true
  }
}
