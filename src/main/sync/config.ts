import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic'
import { isSyncMode, isSyncNote, type SyncMode, type SyncNote } from '../../shared/sync'

export const SYNC_CONFIG_FILE = 'sync-config.json'

export interface SyncRunSummary {
  at: number
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: SyncNote[]
}

export interface SyncConfig {
  v: 1
  mode: SyncMode
  syncRoot?: string
  lastSync?: SyncRunSummary
}

function isRunSummary(value: unknown): value is SyncRunSummary {
  if (!value || typeof value !== 'object') return false
  const raw = value as Partial<SyncRunSummary>
  return (
    typeof raw.at === 'number' &&
    Number.isFinite(raw.at) &&
    typeof raw.ok === 'boolean' &&
    typeof raw.pushed === 'number' &&
    typeof raw.pulled === 'number' &&
    typeof raw.conflicts === 'number' &&
    typeof raw.skipped === 'number' &&
    Array.isArray(raw.errors)
  )
}

function normalizeErrors(value: unknown): SyncNote[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): SyncNote[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ code: 'sync.raw', params: { text: entry } }] : []
    if (isSyncNote(entry)) return [{ code: entry.code, ...(entry.params ? { params: entry.params } : {}) }]
    return []
  })
}

export class SyncConfigStore {
  private readonly file: string
  private cache?: SyncConfig
  private writes: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = join(dataDir, SYNC_CONFIG_FILE)
  }
  path(): string {
    return this.file
  }

  async read(): Promise<SyncConfig> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) return (this.cache = { v: 1, mode: 'manual' })
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SyncConfig>
      const syncRoot = typeof raw?.syncRoot === 'string' && raw.syncRoot ? raw.syncRoot : undefined
      const legacyMode: SyncMode = syncRoot ? 'auto' : 'manual'
      const config: SyncConfig = { v: 1, mode: isSyncMode(raw?.mode) ? raw.mode : legacyMode }
      if (syncRoot) config.syncRoot = syncRoot
      if (isRunSummary(raw?.lastSync)) config.lastSync = { ...raw.lastSync, errors: normalizeErrors(raw.lastSync.errors) }
      return (this.cache = config)
    } catch {
      return (this.cache = { v: 1, mode: 'manual' })
    }
  }

  private async save(config: SyncConfig): Promise<void> {
    await atomicWriteFile(this.file, JSON.stringify(config, null, 2))
    this.cache = config
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writes.then(task, task)
    this.writes = next.catch(() => undefined)
    return next
  }

  setSyncRoot(root: string | undefined): Promise<SyncConfig> {
    return this.serial(async () => {
      const current = await this.read()
      if ((current.syncRoot ?? '') === (root ?? '')) return current
      const next: SyncConfig = { v: 1, mode: current.mode }
      if (root) next.syncRoot = root
      await this.save(next)
      return next
    })
  }

  setMode(mode: SyncMode): Promise<SyncConfig> {
    return this.serial(async () => {
      const current = await this.read()
      if (current.mode === mode) return current
      const next: SyncConfig = { ...current, mode }
      await this.save(next)
      return next
    })
  }

  recordSync(summary: SyncRunSummary): Promise<void> {
    return this.serial(async () => {
      const current = await this.read()
      if (!current.syncRoot) return
      await this.save({ v: 1, mode: current.mode, syncRoot: current.syncRoot, lastSync: summary })
    })
  }
}
