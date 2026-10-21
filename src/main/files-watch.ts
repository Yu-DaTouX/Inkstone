import { watch, type FSWatcher } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isWithin, pathKey, safeJoin } from './files'

const DEBOUNCE_MS = 150
const MAX_WATCH_DIRS = 256

export interface FilesWatchResult {
  dirs: string[]
  dropped: string[]
  superseded?: boolean
}

interface WatchedDir {
  watcher: FSWatcher
  owners: Set<string>
}

interface WatchTarget {
  dirs: Map<string, string>
  onChange: (dir: string) => void
}

function normalizeDir(dir: string): string {
  return (dir ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

export class FilesWatcher {
  private readonly watched = new Map<string, WatchedDir>()
  private readonly targets = new Map<string, WatchTarget>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly generations = new Map<string, number>()
  private generationSeq = 0

  private readonly watchImpl: typeof watch

  constructor(watchImpl: typeof watch = watch) {
    this.watchImpl = watchImpl
  }

  private bump(watchId: string): number {
    const next = ++this.generationSeq
    this.generations.set(watchId, next)
    return next
  }

  private current(watchId: string, generation: number): boolean {
    return this.generations.get(watchId) === generation
  }

  async set(
    watchId: string,
    cwd: string,
    dirs: string[],
    onChange: (dir: string) => void
  ): Promise<FilesWatchResult> {
    const generation = this.bump(watchId)
    const root = await realpath(cwd).catch(() => resolve(cwd))
    const wanted = new Map<string, string>()
    const dropped: string[] = []
    for (const raw of dirs) {
      const dir = normalizeDir(raw)
      if (wanted.size >= MAX_WATCH_DIRS) {
        dropped.push(dir)
        continue
      }
      const abs = safeJoin(root, dir)
      if (!abs || !isWithin(root, abs)) {
        dropped.push(dir)
        continue
      }
      const real = await realpath(abs).catch(() => null)
      if (!this.current(watchId, generation)) return { dirs: [], dropped: [], superseded: true }
      if (!real || !isWithin(root, real)) {
        dropped.push(dir)
        continue
      }
      const key = pathKey(real)
      if (!wanted.has(key)) wanted.set(key, dir)
    }

    if (!this.current(watchId, generation)) return { dirs: [], dropped: [], superseded: true }
    const previous = this.targets.get(watchId)?.dirs ?? new Map<string, string>()
    for (const key of previous.keys()) {
      if (!wanted.has(key)) this.detach(key, watchId)
    }
    for (const key of wanted.keys()) this.attach(key, watchId)
    const attached = new Map<string, string>()
    for (const [key, dir] of wanted) {
      if (this.watched.has(key)) attached.set(key, dir)
      else if (!dropped.includes(dir)) dropped.push(dir)
    }
    this.targets.set(watchId, { dirs: attached, onChange })
    return { dirs: [...attached.values()], dropped }
  }

  release(watchId: string): void {
    this.generations.delete(watchId)
    const target = this.targets.get(watchId)
    if (!target) return
    for (const key of target.dirs.keys()) this.detach(key, watchId)
    this.targets.delete(watchId)
    const prefix = watchId + '\n'
    for (const timerKey of [...this.timers.keys()]) {
      if (!timerKey.startsWith(prefix)) continue
      const timer = this.timers.get(timerKey)
      if (timer) clearTimeout(timer)
      this.timers.delete(timerKey)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const entry of this.watched.values()) entry.watcher.close()
    this.watched.clear()
    this.targets.clear()
    this.generations.clear()
  }

  private attach(key: string, watchId: string): void {
    const existing = this.watched.get(key)
    if (existing) {
      existing.owners.add(watchId)
      return
    }
    let watcher: FSWatcher
    try {
      watcher = this.watchImpl(key, { persistent: false }, () => this.onEvent(key))
    } catch {
      return
    }
    watcher.on('error', () => this.drop(key))
    this.watched.set(key, { watcher, owners: new Set([watchId]) })
  }

  private detach(key: string, watchId: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    entry.owners.delete(watchId)
    if (entry.owners.size > 0) return
    this.drop(key)
  }

  private drop(key: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    this.watched.delete(key)
    entry.watcher.close()
  }

  private onEvent(key: string): void {
    const entry = this.watched.get(key)
    if (!entry) return
    for (const watchId of entry.owners) {
      const target = this.targets.get(watchId)
      const dir = target?.dirs.get(key)
      if (!target || dir === undefined) continue
      const timerKey = watchId + '\n' + key
      if (this.timers.has(timerKey)) continue
      this.timers.set(
        timerKey,
        setTimeout(() => {
          this.timers.delete(timerKey)
          this.targets.get(watchId)?.onChange(dir)
        }, DEBOUNCE_MS)
      )
    }
  }
}

export const filesWatcher = new FilesWatcher()
