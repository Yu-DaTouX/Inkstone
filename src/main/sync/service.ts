import { existsSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { atomicWriteFile } from './atomic'
import { sha256Hex, shortHash } from './canonical'
import { LocalStore, defaultSyncPaths, forbiddenFieldsInRecord } from './local-store'
import { buildConflictCopy } from './resolve'
import { SyncFolder } from './sync-folder'
import type { SyncResolution } from '../../shared/sync'
import type { AppSettings } from '../../shared/ipc'
import type { BaselineFile, ConflictRecord, RemoteRecord, SyncPaths, SyncRecord, SyncReport } from './types'

export interface SyncServiceOptions {
  dataDir: string
  syncRoot: string
  piAgentDir?: string
  paths?: Partial<SyncPaths>
  deviceId?: string
  deviceName?: string
  now?: () => number
  settingsApplier?: (patch: Partial<AppSettings>) => Promise<void>
}

const DEVICE_FILE = 'sync-device.json'
const STATE_FILE = 'sync-state.json'

export class SyncService {
  private readonly now: () => number
  private readonly dataDir: string
  private readonly paths: SyncPaths
  private readonly folder: SyncFolder
  private readonly store: LocalStore
  private readonly deviceFile: string
  private readonly stateFile: string
  private devicePromise?: Promise<{ deviceId: string; deviceName: string }>
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: SyncServiceOptions) {
    if (!options.dataDir) throw new Error('SyncService 需要一个本机数据目录')
    if (!options.syncRoot) throw new Error('SyncService 需要一个同步文件夹')
    this.now = options.now ?? Date.now
    this.dataDir = options.dataDir
    this.paths = { ...defaultSyncPaths(options.dataDir, options.piAgentDir), ...options.paths }
    this.folder = new SyncFolder(options.syncRoot)
    this.store = new LocalStore(this.paths, options.settingsApplier ? { applySettings: options.settingsApplier } : {})
    this.deviceFile = join(options.dataDir, DEVICE_FILE)
    this.stateFile = join(options.dataDir, STATE_FILE)
    if (options.deviceName) this.optionsDeviceName = options.deviceName
    if (options.deviceId) this.optionsDeviceId = options.deviceId
  }

  private optionsDeviceName?: string
  private optionsDeviceId?: string

  device(): Promise<{ deviceId: string; deviceName: string }> {
    return (this.devicePromise ??= this.loadDevice())
  }

  path(name: keyof SyncPaths): string {
    return this.paths[name]
  }

  sync(): Promise<SyncReport> {
    const run = this.chain.then(
      () => this.runSync(),
      () => this.runSync()
    )
    this.chain = run.catch(() => undefined)
    return run
  }

  async listConflicts(): Promise<ConflictRecord[]> {
    return this.folder.readConflicts()
  }

  countConflicts(): Promise<number> {
    return this.folder.countConflicts()
  }

  get syncRoot(): string {
    return this.folder.root
  }

  async resolveConflict(id: string, resolution: SyncResolution): Promise<{ ok: boolean; error?: string }> {
    const conflict = await this.folder.findConflict(id)
    if (!conflict) return { ok: false, error: '冲突不存在或已经处理' }
    try {
      const { deviceId, deviceName } = await this.device()
      const now = this.now()
      const localHash =
        conflict.localHash ?? (conflict.localPayload !== undefined ? sha256Hex(conflict.localPayload) : undefined)
      const remoteHash = conflict.remoteHash

      if (resolution === 'remote') {
        await this.store.apply(this.remoteRecordOf(conflict))
        await this.updateBaseline(conflict.key, { localHash: remoteHash, remoteHash, syncedAt: now })
        await this.folder.removeConflict(id)
        return { ok: true }
      }

      if (resolution === 'both') {
        const copy = buildConflictCopy(conflict)
        if (copy) await this.store.apply(copy)
        else await this.preserveSettingsSnapshot(conflict)
      }

      if (conflict.localPayload !== undefined && localHash) {
        await this.folder.writeRecord({
          key: conflict.key,
          kind: conflict.kind,
          payload: conflict.localPayload,
          modifiedAt: conflict.localModifiedAt ?? now,
          deviceId,
          deviceName,
          hash: localHash
        })
        await this.updateBaseline(conflict.key, { localHash, remoteHash: localHash, syncedAt: now })
      } else if (resolution === 'both') {
        await this.store.apply(this.remoteRecordOf(conflict))
        await this.updateBaseline(conflict.key, { localHash: remoteHash, remoteHash, syncedAt: now })
      } else {
        await this.updateBaseline(conflict.key, { remoteHash, syncedAt: now })
      }
      await this.folder.removeConflict(id)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `处理冲突失败：${describe(error)}` }
    }
  }

  private remoteRecordOf(conflict: ConflictRecord): SyncRecord {
    return {
      key: conflict.key,
      kind: conflict.kind,
      payload: conflict.remotePayload,
      modifiedAt: conflict.remoteModifiedAt
    }
  }

  private async preserveSettingsSnapshot(conflict: ConflictRecord): Promise<void> {
    const stamp = formatTime(conflict.remoteModifiedAt || this.now()).replace(/\D/g, '')
    const target = join(this.dataDir, `desktop.remote-${stamp}-${shortHash(conflict.id, 6)}.json`)
    await atomicWriteFile(target, conflict.remotePayload)
  }

  private async updateBaseline(key: string, entry: BaselineFile['records'][string]): Promise<void> {
    const { deviceId, deviceName } = await this.device()
    const report: SyncReport = {
      ok: true,
      deviceId,
      deviceName,
      pushed: [],
      pulled: [],
      conflicts: [],
      skipped: [],
      errors: [],
      at: this.now()
    }
    const baseline = await this.readBaseline(deviceId, report)
    baseline.records[key] = entry
    await atomicWriteFile(this.stateFile, JSON.stringify(baseline, null, 2))
  }

  private async runSync(): Promise<SyncReport> {
    const { deviceId, deviceName } = await this.device()
    const report: SyncReport = {
      ok: false,
      deviceId,
      deviceName,
      pushed: [],
      pulled: [],
      conflicts: [],
      skipped: [],
      errors: [],
      at: this.now()
    }
    const check = await this.folder.check()
    if (!check.ok) {
      report.errors.push(check.error)
      return report
    }

    const localRead = await this.store.readAll()
    report.skipped.push(...localRead.skipped)
    const remoteRead = await this.folder.readRecords()
    report.skipped.push(...remoteRead.skipped)

    const local = new Map<string, SyncRecord>()
    for (const record of localRead.records) local.set(record.key, record)

    const baseline = await this.readBaseline(deviceId, report)
    const keys = new Set<string>([...local.keys(), ...remoteRead.records.keys(), ...Object.keys(baseline.records)])
    const next: BaselineFile = { v: 1, deviceId, records: {} }

    for (const key of [...keys].sort()) {
      const localRecord = local.get(key)
      const remoteRecord = remoteRead.records.get(key)
      const base = baseline.records[key]
      try {
        await this.reconcile({
          key,
          localRecord,
          remoteRecord,
          base,
          deviceId,
          deviceName,
          report,
          next
        })
      } catch (error) {
        report.errors.push(`${key}：${describe(error)}`)
        if (base) next.records[key] = base
      }
    }

    try {
      await atomicWriteFile(this.stateFile, JSON.stringify(next, null, 2))
    } catch (error) {
      report.errors.push(`同步基线写入失败：${describe(error)}`)
    }
    report.ok = report.errors.length === 0
    return report
  }

  private async reconcile(input: {
    key: string
    localRecord?: SyncRecord
    remoteRecord?: RemoteRecord
    base?: BaselineFile['records'][string]
    deviceId: string
    deviceName: string
    report: SyncReport
    next: BaselineFile
  }): Promise<void> {
    const { key, localRecord, remoteRecord, base, deviceId, deviceName, report, next } = input
    const now = this.now()
    const localHash = localRecord ? sha256Hex(localRecord.payload) : undefined
    const remoteHash = remoteRecord?.hash
    const localChanged = localRecord ? base?.localHash !== localHash : false
    const remoteChanged = remoteRecord ? base?.remoteHash !== remoteHash : false

    const push = async (): Promise<void> => {
      if (!localRecord || !localHash) return
      const forbidden = forbiddenFieldsInRecord(localRecord)
      if (forbidden.length) {
        report.errors.push(`拒绝写出 ${key}：含凭证字段 ${forbidden.join('、')}`)
        if (base) next.records[key] = base
        return
      }
      const remote: RemoteRecord = {
        key,
        kind: localRecord.kind,
        payload: localRecord.payload,
        modifiedAt: localRecord.modifiedAt,
        deviceId,
        deviceName,
        hash: localHash
      }
      await this.folder.writeRecord(remote)
      next.records[key] = { localHash, remoteHash: localHash, syncedAt: now }
      report.pushed.push(key)
    }

    const pull = async (): Promise<void> => {
      if (!remoteRecord || !remoteHash) return
      await this.store.apply(remoteRecord)
      next.records[key] = { localHash: remoteHash, remoteHash, syncedAt: now }
      report.pulled.push(key)
    }

    const conflict = async (): Promise<void> => {
      if (!localRecord || !remoteRecord || !localHash || !remoteHash) return
      const entry: ConflictRecord = {
        id: randomUUID(),
        key,
        kind: localRecord.kind,
        detectedAt: now,
        localDeviceId: deviceId,
        localDeviceName: deviceName,
        localModifiedAt: localRecord.modifiedAt,
        localHash,
        localPayload: localRecord.payload,
        remoteDeviceId: remoteRecord.deviceId,
        remoteDeviceName: remoteRecord.deviceName,
        remoteModifiedAt: remoteRecord.modifiedAt,
        remoteHash,
        remotePayload: remoteRecord.payload,
        suffix: `来自 ${remoteRecord.deviceName} · ${formatTime(now)}`
      }
      await this.folder.writeConflict(entry)
      next.records[key] = { localHash, remoteHash, syncedAt: now }
      report.conflicts.push(entry)
    }

    if (localRecord && remoteRecord) {
      if (localChanged && remoteChanged) {
        if (localHash === remoteHash) {
          next.records[key] = { localHash, remoteHash: localHash, syncedAt: now }
        } else {
          await conflict()
        }
      } else if (localChanged) {
        await push()
      } else if (remoteChanged) {
        await pull()
      } else if (base) {
        next.records[key] = base
      } else {
        if (localHash === remoteHash) next.records[key] = { localHash, remoteHash: localHash, syncedAt: now }
        else await push()
      }
      return
    }

    if (localRecord && !remoteRecord) {
      await push()
      return
    }

    if (!localRecord && remoteRecord) {
      if (remoteChanged || !base) await pull()
      else next.records[key] = base
      return
    }

  }

  private async readBaseline(deviceId: string, report: SyncReport): Promise<BaselineFile> {
    const empty: BaselineFile = { v: 1, deviceId, records: {} }
    if (!existsSync(this.stateFile)) return empty
    try {
      const raw = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<BaselineFile>
      if (!raw || raw.v !== 1 || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) {
        throw new Error('基线结构无效')
      }
      const records: BaselineFile['records'] = {}
      for (const [key, value] of Object.entries(raw.records as Record<string, unknown>)) {
        const entry = value as { localHash?: unknown; remoteHash?: unknown; syncedAt?: unknown }
        if (!entry || typeof entry !== 'object') continue
        records[key] = {
          ...(typeof entry.localHash === 'string' ? { localHash: entry.localHash } : {}),
          ...(typeof entry.remoteHash === 'string' ? { remoteHash: entry.remoteHash } : {}),
          syncedAt: typeof entry.syncedAt === 'number' ? entry.syncedAt : 0
        }
      }
      return { v: 1, deviceId, records }
    } catch (error) {
      const backup = `${this.stateFile}.corrupt-${randomUUID()}`
      await rename(this.stateFile, backup).catch(() => undefined)
      report.skipped.push(`${this.stateFile}：基线损坏（${describe(error)}），已隔离到 ${backup}`)
      return empty
    }
  }

  private async loadDevice(): Promise<{ deviceId: string; deviceName: string }> {
    await mkdir(this.dataDir, { recursive: true })
    let stored: { deviceId?: unknown; deviceName?: unknown } | undefined
    if (existsSync(this.deviceFile)) {
      try {
        const raw = JSON.parse(await readFile(this.deviceFile, 'utf8')) as { v?: unknown; deviceId?: unknown; deviceName?: unknown }
        if (raw && raw.v === 1 && typeof raw.deviceId === 'string' && raw.deviceId) {
          stored = raw
        } else {
          throw new Error('设备标识结构无效')
        }
      } catch {
        const backup = `${this.deviceFile}.corrupt-${randomUUID()}`
        await rename(this.deviceFile, backup).catch(() => undefined)
      }
    }
    const deviceId = this.optionsDeviceId || (typeof stored?.deviceId === 'string' ? stored.deviceId : '') || randomUUID()
    const deviceName =
      this.optionsDeviceName ||
      (typeof stored?.deviceName === 'string' && stored.deviceName ? stored.deviceName : '') ||
      safeHostname()
    if (deviceId !== stored?.deviceId || deviceName !== stored?.deviceName) {
      await atomicWriteFile(this.deviceFile, JSON.stringify({ v: 1, deviceId, deviceName }, null, 2))
    }
    return { deviceId, deviceName }
  }
}

function safeHostname(): string {
  try {
    return hostname() || 'device'
  } catch {
    return 'device'
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
