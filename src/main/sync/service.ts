/**
 * 跨设备同步核心服务（WP-53 A 阶段）。
 *
 * 设计口径（决定 D1：同步文件夹，不建账号）：
 *   · 用户指定一个普通文件夹（OneDrive / 坚果云 / Syncthing 等负责传输），
 *     同步核心只按文件读写，不关心底层用哪种云盘。
 *   · 每台设备有稳定 deviceId / deviceName；每条记录带修改时间与来源设备。
 *   · 变更判定 = 与上次同步基线比对哈希，而不是比对时钟，避免两端时钟不一致。
 *   · 冲突（两端自上次同步后都改过同一条且内容不同）：本地版本不动、他端版本写成
 *     带设备名与时间后缀的副本，并生成冲突记录；**绝不静默覆盖**。
 *   · 同步目录缺失 / 不可写 / 文件损坏 / 半写入：跳过并报告，不崩溃、不删除。
 *
 * 这里是纯 Node 实现，不依赖 Electron；接线层负责传入真实目录并调用 `sync()`。
 */
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
import type { BaselineFile, ConflictRecord, RemoteRecord, SyncPaths, SyncRecord, SyncReport } from './types'

export interface SyncServiceOptions {
  /** 本机数据目录（真实接线为 `YAN_DIR`）。 */
  dataDir: string
  /** 用户指定的同步文件夹。 */
  syncRoot: string
  /** pi 私有目录；提示词模板在其 `prompts/` 下。缺省与 dataDir 同根。 */
  piAgentDir?: string
  /** 逐项覆盖各存储位置（主要给测试与将来迁移用）。 */
  paths?: Partial<SyncPaths>
  /** 固定 deviceId（测试用）；缺省从 dataDir 持久化。 */
  deviceId?: string
  /** 设备显示名（测试用）；缺省优先读持久化，其次系统 hostname。 */
  deviceName?: string
  now?: () => number
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
    this.store = new LocalStore(this.paths)
    this.deviceFile = join(options.dataDir, DEVICE_FILE)
    this.stateFile = join(options.dataDir, STATE_FILE)
    if (options.deviceName) this.optionsDeviceName = options.deviceName
    if (options.deviceId) this.optionsDeviceId = options.deviceId
  }

  private optionsDeviceName?: string
  private optionsDeviceId?: string

  /** 稳定设备身份；首次使用时在数据目录落盘。 */
  device(): Promise<{ deviceId: string; deviceName: string }> {
    return (this.devicePromise ??= this.loadDevice())
  }

  path(name: keyof SyncPaths): string {
    return this.paths[name]
  }

  /**
   * 立即同步一次。串行执行，重复调用不会互相穿插。
   * 任何单项失败都记进报告，不抛异常（除非 dataDir / syncRoot 参数本身非法）。
   */
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

  /** 当前生效的同步文件夹（接线层与设置界面读它做展示）。 */
  get syncRoot(): string {
    return this.folder.root
  }

  /**
   * 处理一条冲突。三种方式都不丢内容：
   *   · local  —— 本机版本为准：写回同步目录并把基线固定到本机哈希；
   *   · remote —— 他端版本为准：合并进本机再把基线固定到他端哈希；
   *   · both   —— 本机仍为主记录，他端另存一份（可复制类别生成本地副本；
   *              单例 settings 把远端设置存成数据目录下的时间戳快照）。
   * 成功后删除该冲突副本。失败返回可读原因，不改动基线；绝不静默覆盖。
   */
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
        /* 他端版本先留下来（副本或快照），再让本机版本继续做主。 */
        const copy = buildConflictCopy(conflict)
        if (copy) await this.store.apply(copy)
        else await this.preserveSettingsSnapshot(conflict)
      }

      if (conflict.localPayload !== undefined && localHash) {
        /* local / both：本机版本写回同步目录，基线两端都指向本机哈希。 */
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
        /* both 但本机已无版本：退回采用他端，至少内容不丢。 */
        await this.store.apply(this.remoteRecordOf(conflict))
        await this.updateBaseline(conflict.key, { localHash: remoteHash, remoteHash, syncedAt: now })
      } else {
        /* local 但本机没有版本：不能假装本机赢，基线保留他端。 */
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

  /** 单例设置无法复制成本地第二份，把他端内容原样留成数据目录下的时间戳快照。 */
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
        // 失败时保留原基线，下次再试；不写半成品。
        if (base) next.records[key] = base
      }
    }

    try {
      await atomicWriteFile(this.stateFile, JSON.stringify(next, null, 2))
    } catch (error) {
      report.errors.push(`同步基线写入失败：${describe(error)}`)
    }
    report.ok = true
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
      // 冻结：两端各保留自己的版本，不再互相覆盖，直到用户处理。
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
        // 双方都有内容、都没有基线（例如都一样但基线丢了）：以本地为准推一次。
        if (localHash === remoteHash) next.records[key] = { localHash, remoteHash: localHash, syncedAt: now }
        else await push()
      }
      return
    }

    if (localRecord && !remoteRecord) {
      // 本机独有 / 他端删除：A 阶段不做删除同步，以本机为准写回，保证两端一致。
      await push()
      return
    }

    if (!localRecord && remoteRecord) {
      // 远端独有：拉取；若本机曾同步过又删除了本机副本，且远端未变，则尊重本机删除。
      if (remoteChanged || !base) await pull()
      else next.records[key] = base
      return
    }

    // 两边都没有：丢掉基线（本机 / 远端均已不存在）。
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
      /*
       * 基线损坏不阻塞同步：隔离原文件后从空基线开始。空基线只会让下一次同步
       * 更保守（可能多报一次冲突），绝不会静默丢掉任何一端的内容。
       */
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
