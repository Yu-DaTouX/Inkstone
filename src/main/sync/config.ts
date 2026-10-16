/**
 * 同步目录配置与「上次同步」摘要的落盘。
 *
 * 为什么单独一个小文件（`<数据目录>/sync-config.json`）而不是塞进 `desktop.json`：
 *   · `desktop.json` 的设置键走同步白名单，同步目录本身是本机专属路径，
 *     绝不能进入同步目录（否则两端会互相指向对方的路径）；
 *   · 这个文件不参与同步（不在 SyncService 的 SyncPaths 里），只记本机选择。
 *
 * 与同步基线（`sync-state.json`）分开：基线由 Synchroncore 维护，
 * 这里只记用户选择与最近一次结果，两者损坏互不影响。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './atomic'

/** 配置文件名；固定在数据目录根部，不随同步走。 */
export const SYNC_CONFIG_FILE = 'sync-config.json'

/** 最近一次同步的可读摘要。 */
export interface SyncRunSummary {
  at: number
  ok: boolean
  pushed: number
  pulled: number
  conflicts: number
  skipped: number
  errors: string[]
}

export interface SyncConfig {
  v: 1
  /** 用户指定的同步文件夹；未配置时缺省。 */
  syncRoot?: string
  /** 最近一次同步结果；切换同步目录会清空。 */
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

/** 读写同步配置的小存储；纯 Node，可在测试里指向临时数据目录。 */
export class SyncConfigStore {
  private readonly file: string
  private cache?: SyncConfig

  constructor(dataDir: string) {
    this.file = join(dataDir, SYNC_CONFIG_FILE)
  }
  path(): string {
    return this.file
  }

  /** 读配置；文件缺失 / 损坏一律回退为空配置，不抛异常、不删除原文件。 */
  async read(): Promise<SyncConfig> {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) return (this.cache = { v: 1 })
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SyncConfig>
      const config: SyncConfig = { v: 1 }
      if (typeof raw?.syncRoot === 'string' && raw.syncRoot) config.syncRoot = raw.syncRoot
      if (isRunSummary(raw?.lastSync)) config.lastSync = raw.lastSync
      return (this.cache = config)
    } catch {
      /* 坏文件不让同步配置页整页失败：回退空配置，下次写入时覆盖。 */
      return (this.cache = { v: 1 })
    }
  }

  private async save(config: SyncConfig): Promise<void> {
    await atomicWriteFile(this.file, JSON.stringify(config, null, 2))
    this.cache = config
  }

  /** 设置 / 清除同步目录；目录变化时清掉旧目录的同步摘要，避免显示错位的「上次结果」。 */
  async setSyncRoot(root: string | undefined): Promise<SyncConfig> {
    const current = await this.read()
    if ((current.syncRoot ?? '') === (root ?? '')) return current
    const next: SyncConfig = { v: 1 }
    if (root) next.syncRoot = root
    await this.save(next)
    return next
  }

  /** 记录一次同步结果；没有配置同步目录时不写。 */
  async recordSync(summary: SyncRunSummary): Promise<void> {
    const current = await this.read()
    if (!current.syncRoot) return
    await this.save({ v: 1, syncRoot: current.syncRoot, lastSync: summary })
  }
}
