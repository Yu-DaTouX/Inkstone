import { watch, type FSWatcher } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isWithin, pathKey, safeJoin } from './files'

const DEBOUNCE_MS = 150
const MAX_WATCH_DIRS = 256

export interface FilesWatchResult {
  dirs: string[]
  dropped: string[]
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

  async set(
    watchId: string,
    cwd: string,
    dirs: string[],
    onChange: (dir: string) => void
  ): Promise<FilesWatchResult> {
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
      if (!real || !isWithin(root, real)) {
        dropped.push(dir)
        continue
      }
      const key = pathKey(real)
      if (!wanted.has(key)) wanted.set(key, dir)
    }

    const previous = this.targets.get(watchId)?.dirs ?? new Map<string, string>()
    for (const key of previous.keys()) {
      if (!wanted.has(key)) this.detach(key, watchId)
    }
    for (const key of wanted.keys()) {
      if (!previous.has(key)) this.attach(key, watchId)
    }
    this.targets.set(watchId, { dirs: wanted, onChange })
    return { dirs: [...wanted.values()], dropped }
  }

  release(watchId: string): void {
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
  }

  private attach(key: string, watchId: string): void {
    const existing = this.watched.get(key)
    if (existing) {
      existing.owners.add(watchId)
      return
    }
    let watcher: FSWatcher
    try {
      watcher = watch(key, { persistent: false }, () => this.onEvent(key))
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
