import { existsSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic'
import { sha256Hex, shortHash } from './canonical'
import { isRecordKind } from './local-store'
import type { ConflictRecord, RemoteRecord, SyncRecordKind } from './types'

export const SYNC_SUBDIR = 'inkstone-sync'
const KINDS: SyncRecordKind[] = ['settings', 'prompt', 'skill', 'bookmark', 'schedule']

export interface ReadRecordsResult {
  records: Map<string, RemoteRecord>
  skipped: string[]
}

export class SyncFolder {
  readonly dir: string
  readonly recordsDir: string
  readonly conflictsDir: string

  constructor(readonly root: string) {
    this.dir = join(root, SYNC_SUBDIR)
    this.recordsDir = join(this.dir, 'records')
    this.conflictsDir = join(this.dir, 'conflicts')
  }

  async check(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!existsSync(this.root)) return { ok: false, error: `同步文件夹不存在：${this.root}` }
    try {
      await access(this.root, constants.W_OK)
    } catch {
      return { ok: false, error: `同步文件夹不可写：${this.root}` }
    }
    try {
      await mkdir(this.dir, { recursive: true })
    } catch (error) {
      return { ok: false, error: `无法创建同步子目录：${describe(error)}` }
    }
    return { ok: true }
  }

  async readRecords(): Promise<ReadRecordsResult> {
    const records = new Map<string, RemoteRecord>()
    const skipped: string[] = []
    for (const kind of KINDS) {
      const dir = join(this.recordsDir, kind)
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        skipped.push(`${dir}：${describe(error)}`)
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const file = join(dir, entry.name)
        const record = await readRecordFile(file, kind, skipped)
        if (record) records.set(record.key, record)
      }
    }
    return { records, skipped }
  }

  async writeRecord(record: RemoteRecord): Promise<void> {
    const file = join(this.recordsDir, record.kind, `${shortHash(record.key)}.json`)
    await atomicWriteFile(file, JSON.stringify({ v: 1, ...record }, null, 2))
  }

  async readConflicts(): Promise<ConflictRecord[]> {
    let entries
    try {
      entries = await readdir(this.conflictsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return []
    }
    const out: ConflictRecord[] = []
    for (const entry of entries) {
      if (!isConflictFile(entry.name, entry.isFile())) continue
      try {
        const raw = JSON.parse(await readFile(join(this.conflictsDir, entry.name), 'utf8')) as ConflictRecord
        if (raw && typeof raw.id === 'string' && typeof raw.key === 'string' && typeof raw.remoteHash === 'string') out.push(raw)
      } catch {
      }
    }
    out.sort((a, b) => b.detectedAt - a.detectedAt)
    return out
  }

  async countConflicts(): Promise<number> {
    try {
      const entries = await readdir(this.conflictsDir, { withFileTypes: true })
      return entries.filter((entry) => isConflictFile(entry.name, entry.isFile())).length
    } catch {
      return 0
    }
  }

  async findConflict(id: string): Promise<ConflictRecord | undefined> {
    if (!id) return undefined
    return (await this.readConflicts()).find((item) => item.id === id)
  }

  async removeConflict(id: string): Promise<void> {
    if (!id) return
    let names: string[]
    try {
      names = await readdir(this.conflictsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!isConflictFile(name, true)) continue
      const file = join(this.conflictsDir, name)
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as { id?: unknown }
        if (raw?.id === id) await rm(file, { force: true })
      } catch {
      }
    }
  }

  async writeConflict(conflict: ConflictRecord): Promise<void> {
    await mkdir(this.conflictsDir, { recursive: true })
    const suffix = `-${shortHash(conflict.key, 12)}-${shortHash(conflict.localHash ?? 'none', 8)}-${shortHash(
      conflict.remoteHash,
      8
    )}.json`
    const names = await readdir(this.conflictsDir).catch(() => [] as string[])
    if (names.some((name) => isConflictFile(name, true) && name.endsWith(suffix))) return
    const file = join(this.conflictsDir, `${stamp(conflict.detectedAt)}-${safeName(conflict.remoteDeviceName)}${suffix}`)
    await atomicWriteFile(file, JSON.stringify({ v: 1, ...conflict }, null, 2))
  }
}

function isConflictFile(name: string, isFile: boolean): boolean {
  return isFile && name.endsWith('.json') && name !== 'index.json'
}

async function readRecordFile(file: string, expectedKind: SyncRecordKind, skipped: string[]): Promise<RemoteRecord | undefined> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch (error) {
    skipped.push(`${file}：读取或解析失败（${describe(error)}），可能是云盘同步中的半写入文件，已跳过`)
    return undefined
  }
  const key = typeof raw.key === 'string' ? raw.key : ''
  const kind = raw.kind
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''
  const deviceName = typeof raw.deviceName === 'string' ? raw.deviceName : '未知设备'
  const modifiedAt = typeof raw.modifiedAt === 'number' && Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : 0
  const payload = typeof raw.payload === 'string' ? raw.payload : undefined
  const hash = typeof raw.hash === 'string' ? raw.hash : ''
  if (
    raw.v !== 1 ||
    !key ||
    !isRecordKind(kind) ||
    kind !== expectedKind ||
    !deviceId ||
    payload === undefined ||
    hash !== sha256Hex(payload)
  ) {
    skipped.push(`${file}：记录形状或哈希校验不通过，已跳过`)
    return undefined
  }
  return { key, kind, deviceId, deviceName, modifiedAt, payload, hash }
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40)
  return cleaned || 'device'
}

function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
