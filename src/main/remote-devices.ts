/**
 * 手机配对与设备令牌。
 *
 * 规则：
 *   · 配对码只在内存里：6 位数字，5 分钟有效，一次有效；输错 5 次立即作废（防枚举）。
 *   · 每台手机一个令牌，配对时只返回一次；磁盘上只存 SHA-256 哈希，原文不落盘。
 *   · 撤销立即生效：撤销后的令牌再也认不出来（已经交给手机的内容无法收回，这点在界面上写明）。
 *   · 这里只管「是谁」；「能做什么」（例如敏感确认不能在手机上做）由远程服务的路由决定。
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  REMOTE_PAIRING_CODE_RE,
  REMOTE_PAIRING_TTL_MS,
  type RemoteDeviceRecord,
  type RemoteDeviceSummary
} from '../shared/remote-protocol'

interface StoredDevice extends RemoteDeviceRecord {
  tokenHash: string
}

interface DeviceFile {
  version: 1
  devices: StoredDevice[]
}

const MAX_DEVICES = 20
const MAX_PAIR_ATTEMPTS = 5
const DEVICE_NAME_MAX = 60
/** 最后在线时间最多每分钟落盘一次（每个请求都写盘没有必要） */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function cleanName(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  return (text || '未命名设备').slice(0, DEVICE_NAME_MAX)
}

export type PairResult =
  | { ok: true; device: RemoteDeviceSummary; token: string }
  | { ok: false; error: 'no_pairing' | 'expired' | 'invalid_code' | 'too_many_attempts' | 'device_limit' }

export class RemoteDeviceStore {
  private readonly file: string
  private devices: StoredDevice[] | null = null
  /** 首次加载共享同一个 Promise：并发调用不会各自读盘、互相覆盖 */
  private loading: Promise<StoredDevice[]> | null = null
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private lastSeenWrittenAt = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()
  /**
   * 设备表操作的串行闸门。
   *
   * 「验证配对码 → 消费码 → 登记设备 → 落盘」必须整体串行：否则两个并发请求
   * 会在同一个 await 处同时通过验证，于是一个一次性码产出多个令牌。
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'remote-devices.json')
  }

  /** 排队执行一个设备表操作（前一个任务失败不影响后一个） */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private async load(): Promise<StoredDevice[]> {
    if (this.devices) return this.devices
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<DeviceFile>
          return parsed?.version === 1 && Array.isArray(parsed.devices)
            ? parsed.devices.filter((device) =>
                typeof device?.id === 'string' && typeof device.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(device.tokenHash)
              )
            : []
        } catch {
          /* 文件不存在或损坏：从空设备表开始（损坏时所有旧令牌失效，比误认更安全） */
          return []
        }
      })()
    }
    const devices = await this.loading
    if (!this.devices) this.devices = devices
    return this.devices
  }

  /**
   * 把**候选**设备表落盘（原子替换）。
   *
   * 传候选数组而不是读 this.devices 的原因：调用方先构造新状态、落盘成功后才提交
   * 到内存 —— 写盘失败时内存不能先变，否则失败的操作会在下一次保存时"偷偷"生效
   * （空间/关注/成果几个 Store 都踩过这个形状）。
   *
   * 队列续接同时带成功与失败分支：一次写盘失败（磁盘满、权限、同步盘冲突）不能让
   * 之后所有保存都被跳过并继续 reject。
   */
  private save(candidate: StoredDevice[]): Promise<void> {
    const snapshot: DeviceFile = { version: 1, devices: candidate }
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    }
    const next = this.writing.then(run, run)
    this.writing = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /** 生成新的配对码（旧码立即作废） */
  startPairing(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairing = { code, expiresAt: this.now() + REMOTE_PAIRING_TTL_MS, attempts: 0 }
    return { code, expiresAt: this.pairing.expiresAt }
  }

  cancelPairing(): void {
    this.pairing = null
  }

  currentPairing(): { code: string; expiresAt: number } | null {
    if (!this.pairing) return null
    if (this.pairing.expiresAt <= this.now()) {
      this.pairing = null
      return null
    }
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
  }

  async pair(code: unknown, deviceName: unknown, kind: unknown = 'phone'): Promise<PairResult> {
    return this.enqueue(async () => {
      const pairing = this.pairing
      if (!pairing) return { ok: false, error: 'no_pairing' }
      if (pairing.expiresAt <= this.now()) {
        this.pairing = null
        return { ok: false, error: 'expired' }
      }
      const given = typeof code === 'string' ? code.trim() : ''
      const matches = REMOTE_PAIRING_CODE_RE.test(given) &&
        timingSafeEqual(Buffer.from(given.padEnd(6, ' ')), Buffer.from(pairing.code))
      if (!matches) {
        pairing.attempts += 1
        if (pairing.attempts >= MAX_PAIR_ATTEMPTS) {
          this.pairing = null
          return { ok: false, error: 'too_many_attempts' }
        }
        return { ok: false, error: 'invalid_code' }
      }
      const devices = await this.load()
      if (devices.filter((device) => device.revokedAt === null).length >= MAX_DEVICES) {
        return { ok: false, error: 'device_limit' }
      }
      /* 校验通过且确认还有名额，才消费配对码（没名额时保留，用户可清掉旧设备后重试） */
      this.pairing = null
      const token = randomBytes(32).toString('base64url')
      const device: StoredDevice = {
        id: `device-${randomUUID()}`,
        name: cleanName(deviceName),
        kind: kind === 'peer' || kind === 'agent' ? kind : 'phone',
        createdAt: this.now(),
        lastSeenAt: null,
        revokedAt: null,
        tokenHash: hashToken(token)
      }
      const next = [...devices, device]
      /* 落盘成功才提交到内存：写盘失败时这台设备不存在，用户看到的就是真实的失败 */
      await this.save(next)
      this.devices = next
      return { ok: true, device: summaryOf(device), token }
    })
  }

  /** 令牌 → 设备；撤销或不认识的令牌返回 null */
  async authenticate(token: string): Promise<RemoteDeviceSummary | null> {
    if (!token) return null
    const hash = hashToken(token)
    const devices = await this.load()
    const device = devices.find((item) => item.revokedAt === null && sameHash(item.tokenHash, hash))
    if (!device) return null
    const now = this.now()
    device.lastSeenAt = now
    if (now - (this.lastSeenWrittenAt.get(device.id) ?? 0) >= LAST_SEEN_WRITE_INTERVAL_MS) {
      this.lastSeenWrittenAt.set(device.id, now)
      /* 尽力而为：排队写当前状态，失败只丢这一次「最后在线」记录 */
      void this.enqueue(async () => {
        await this.save(this.devices ?? devices).catch(() => undefined)
      })
    }
    return summaryOf(device)
  }

  async list(): Promise<RemoteDeviceRecord[]> {
    return (await this.load()).map(({ tokenHash: _hash, ...record }) => ({ ...record }))
  }

  async revoke(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const devices = await this.load()
      const device = devices.find((item) => item.id === id && item.revokedAt === null)
      if (!device) return false
      const now = this.now()
      const next = devices.map((item) => (item.id === id ? { ...item, revokedAt: now } : item))
      /* 撤销必须落盘成功才算完成：写盘失败时内存也保持「未撤销」，避免重启后状态回退 */
      await this.save(next)
      this.devices = next
      return true
    })
  }

  async renameDevice(id: string, name: string): Promise<RemoteDeviceSummary | null> {
    return this.enqueue(async () => {
      const devices = await this.load()
      const device = devices.find((item) => item.id === id && item.revokedAt === null)
      if (!device) return null
      const clean = cleanName(name)
      const next = devices.map((item) => (item.id === id ? { ...item, name: clean } : item))
      await this.save(next)
      this.devices = next
      return summaryOf({ ...device, name: clean })
    })
  }

  /** 已撤销的设备记录可以从列表里删掉（令牌早已失效） */
  async forget(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const devices = await this.load()
      const index = devices.findIndex((item) => item.id === id && item.revokedAt !== null)
      if (index < 0) return false
      const next = devices.filter((item) => item.id !== id)
      await this.save(next)
      this.devices = next
      return true
    })
  }
}

function summaryOf(device: StoredDevice): RemoteDeviceSummary {
  return { id: device.id, name: device.name, kind: device.kind === 'peer' || device.kind === 'agent' ? device.kind : 'phone', createdAt: device.createdAt, lastSeenAt: device.lastSeenAt }
}
