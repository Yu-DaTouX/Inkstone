import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile, copyFile } from 'node:fs/promises'
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
  private loading: Promise<StoredDevice[]> | null = null
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private lastSeenWrittenAt = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, private readonly now: () => number = Date.now) {
    this.file = join(dir, 'remote-devices.json')
  }

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
        let text: string
        try {
          text = await readFile(this.file, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
        try {
          const parsed: unknown = JSON.parse(text)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('设备表格式无效')
          const document = parsed as Partial<DeviceFile>
          if (document.version !== 1 || !Array.isArray(document.devices)) throw new SyntaxError('设备表格式无效')
          return document.devices.filter((device) =>
            typeof device?.id === 'string' && typeof device.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(device.tokenHash)
          )
        } catch (error) {
          await copyFile(this.file, `${this.file}.corrupt-${randomUUID()}`).catch(() => undefined)
          throw error
        }
      })()
    }
    let devices: StoredDevice[]
    try {
      devices = await this.loading
    } catch (error) {
      this.loading = null
      throw error
    }
    if (!this.devices) this.devices = devices
    return this.devices
  }

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
      await this.save(next)
      this.devices = next
      return { ok: true, device: summaryOf(device), token }
    })
  }

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
