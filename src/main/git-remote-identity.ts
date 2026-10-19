import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gitRun } from './git-service'
import type { GitRemoteIdentity } from '../shared/git'

export function parseRemoteUrl(remote: string): Omit<GitRemoteIdentity, 'remote'> | null {
  const raw = String(remote ?? '').trim()
  if (!raw || raw.length > 2048) return null
  let host = ''
  let path = ''
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw)
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(raw)
  if (url) {
    host = url[1]
    path = url[2]
  } else if (scp && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    host = scp[1]
    path = scp[2]
  } else {
    return null
  }
  const segments = path.replace(/\.git\/?$/i, '').replace(/\/+$/, '').replace(/^\/+/, '').split('/').filter(Boolean)
  if (segments.length < 2) return null
  const name = segments[segments.length - 1]
  const owner = segments.slice(0, -1).join('/')
  if (!/^[\w.-]+$/.test(name) || !/^[\w./-]+$/.test(owner) || !/^[\w.-]+$/.test(host)) return null
  return { host: host.toLowerCase(), owner, name }
}

export class LruCache<V> {
  private readonly map = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  has(key: string): boolean {
    return this.map.has(key)
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  get size(): number {
    return this.map.size
  }
}

const identityCache = new LruCache<GitRemoteIdentity | null>(500)

function cacheKey(dir: string): string {
  const normalized = dir.replace(/[\\/]+/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function readRemoteIdentity(cwd: string, options: { refresh?: boolean } = {}): Promise<GitRemoteIdentity | null> {
  const dir = await realpath(cwd).catch(() => resolve(cwd))
  const key = cacheKey(dir)
  if (!options.refresh && identityCache.has(key)) return identityCache.get(key) ?? null
  const remotes = await gitRun(dir, ['remote'], { allowFailure: true, timeout: 8000 })
  const names = remotes.ok ? remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []
  const remote = names.includes('origin') ? 'origin' : names[0]
  let identity: GitRemoteIdentity | null = null
  if (remote) {
    const url = await gitRun(dir, ['remote', 'get-url', '--', remote], { allowFailure: true, timeout: 8000 })
    const parsed = url.ok ? parseRemoteUrl(url.stdout.trim()) : null
    identity = parsed ? { ...parsed, remote } : null
  }
  if (remotes.ok || remotes.code === 'NOT_A_REPO') identityCache.set(key, identity)
  return identity
}
