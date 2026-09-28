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
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private lastSeenWrittenAt = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'remote-devices.json')
  }

  private async load(): Promise<StoredDevice[]> {
    if (this.devices) return this.devices
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<DeviceFile>
      this.devices = parsed?.version === 1 && Array.isArray(parsed.devices)
        ? parsed.devices.filter((device) =>
            typeof device?.id === 'string' && typeof device.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(device.tokenHash)
          )
        : []
    } catch {
      /* 文件不存在或损坏：从空设备表开始（损坏时所有旧令牌失效，比误认更安全） */
      this.devices = []
    }
    return this.devices
  }

  private save(): Promise<void> {
    const snapshot: DeviceFile = { version: 1, devices: this.devices ?? [] }
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    })
    return this.writing
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

  async pair(code: unknown, deviceName: unknown): Promise<PairResult> {
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
    /* 配对码一次有效 */
    this.pairing = null
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: `device-${randomUUID()}`,
      name: cleanName(deviceName),
      createdAt: this.now(),
      lastSeenAt: null,
      revokedAt: null,
      tokenHash: hashToken(token)
    }
    devices.push(device)
    await this.save()
    return { ok: true, device: summaryOf(device), token }
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
      void this.save().catch(() => undefined)
    }
    return summaryOf(device)
  }

  async list(): Promise<RemoteDeviceRecord[]> {
    return (await this.load()).map(({ tokenHash: _hash, ...record }) => ({ ...record }))
  }

  async revoke(id: string): Promise<boolean> {
    const devices = await this.load()
    const device = devices.find((item) => item.id === id && item.revokedAt === null)
    if (!device) return false
    device.revokedAt = this.now()
    await this.save()
    return true
  }

  /** 已撤销的设备记录可以从列表里删掉（令牌早已失效） */
  async forget(id: string): Promise<boolean> {
    const devices = await this.load()
    const index = devices.findIndex((item) => item.id === id && item.revokedAt !== null)
    if (index < 0) return false
    devices.splice(index, 1)
    await this.save()
    return true
  }
}

function summaryOf(device: StoredDevice): RemoteDeviceSummary {
  return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt }
}
