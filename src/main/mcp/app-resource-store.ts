import { createHash, randomBytes } from 'node:crypto'
import { isMcpAppMimeType, MCP_APP_RESOURCE_MAX_BYTES } from './app-spec'
import {
  buildMcpAppUrl,
  isCompleteMcpAppOwner,
  parseMcpAppUrl,
  sameMcpAppOwner,
  type McpAppOwner
} from '../../shared/mcp-app-preview'

export function appServerHash(serverId: string): string {
  return createHash('sha256').update(serverId).digest('hex').slice(0, 32)
}

export interface McpAppLoadedResource {
  html: string
  mimeType: string
  bytes: number
  csp: string
}

export interface McpAppResourceFetchRequest {
  serverId: string
  resourceUri: string
  signal?: AbortSignal
  projectId?: string
}

export type McpAppResourceFetch = (request: McpAppResourceFetchRequest) => Promise<McpAppLoadedResource>

export interface McpAppOwnerGuard {
  isActive(owner: McpAppOwner): boolean
}

export interface McpAppResourceStoreOptions {
  fetchResource: McpAppResourceFetch
  ownerGuard: McpAppOwnerGuard
  cacheTtlMs?: number
  maxInstances?: number
  maxCacheEntries?: number
  maxResourceBytes?: number
  now?: () => number
}

export interface McpAppPrepareInput {
  serverId: string
  resourceUri: string
  owner: McpAppOwner
  version?: string
  signal?: AbortSignal
}

export type McpAppPrepareError = 'input' | 'owner' | 'revoked' | 'aborted' | 'mime' | 'size' | 'fetch' | 'busy' | 'stale'

export type McpAppPrepareResult =
  | { ok: true; url: string; instanceId: string; serverHash: string; bytes: number; cached: boolean }
  | { ok: false; error: McpAppPrepareError }

export type McpAppReadError = 'unknown' | 'owner' | 'revoked' | 'method'

export type McpAppReadResult =
  | {
      ok: true
      html: string
      csp: string
      mimeType: string
      instanceId: string
      serverHash: string
      owner: McpAppOwner
    }
  | { ok: false; error: McpAppReadError }

export interface McpAppReadOptions {
  method?: string
  owner?: McpAppOwner
}

interface McpAppInstance {
  instanceId: string
  serverHash: string
  serverId: string
  resourceUri: string
  owner: McpAppOwner
  html: string
  mimeType: string
  bytes: number
  csp: string
  createdAt: number
}

interface McpAppCacheEntry {
  html: string
  mimeType: string
  bytes: number
  csp: string
  fetchedAt: number
}

function cacheKey(serverId: string, resourceUri: string, version: string | undefined): string {
  return `${serverId}\u0000${resourceUri}\u0000${version ?? ''}`
}

export class McpAppResourceStore {
  private readonly instances = new Map<string, McpAppInstance>()
  private readonly cache = new Map<string, McpAppCacheEntry>()
  private readonly fetchResource: McpAppResourceFetch
  private readonly ownerGuard: McpAppOwnerGuard
  private revocationEpoch = 0
  private readonly cacheTtlMs: number
  private readonly maxInstances: number
  private readonly maxCacheEntries: number
  private readonly maxResourceBytes: number
  private readonly now: () => number

  constructor(options: McpAppResourceStoreOptions) {
    const guard = options?.ownerGuard
    if (!guard || typeof guard.isActive !== 'function') {
      throw new Error('McpAppResourceStore requires an ownerGuard; refusing to construct a fail-open store')
    }
    this.fetchResource = options.fetchResource
    this.ownerGuard = guard
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000
    this.maxInstances = options.maxInstances ?? 8
    this.maxCacheEntries = options.maxCacheEntries ?? 64
    this.maxResourceBytes = options.maxResourceBytes ?? MCP_APP_RESOURCE_MAX_BYTES
    this.now = options.now ?? Date.now
  }

  serverHash(serverId: string): string {
    return appServerHash(serverId)
  }

  get size(): number {
    return this.instances.size
  }

  get cacheSize(): number {
    return this.cache.size
  }

  async prepare(input: McpAppPrepareInput): Promise<McpAppPrepareResult> {
    if (
      !input ||
      typeof input.serverId !== 'string' ||
      !input.serverId.trim() ||
      typeof input.resourceUri !== 'string' ||
      !input.resourceUri.trim()
    ) {
      return { ok: false, error: 'input' }
    }
    const owner = input.owner
    if (!isCompleteMcpAppOwner(owner) || owner.serverId !== input.serverId) return { ok: false, error: 'owner' }
    if (!this.isOwnerActive(owner)) return { ok: false, error: 'revoked' }
    if (input.signal?.aborted) return { ok: false, error: 'aborted' }
    if (this.instances.size >= this.maxInstances) return { ok: false, error: 'busy' }

    const epoch = this.revocationEpoch
    const key = cacheKey(input.serverId, input.resourceUri, input.version)
    let cached = this.cache.get(key)
    let fromCache = false
    if (cached && this.isFresh(cached)) {
      fromCache = true
    } else {
      let loaded: McpAppLoadedResource
      try {
        loaded = await this.fetchResource({
          serverId: input.serverId,
          resourceUri: input.resourceUri,
          signal: input.signal,
          projectId: owner.projectId
        })
      } catch {
        return { ok: false, error: 'fetch' }
      }
      if (input.signal?.aborted) return { ok: false, error: 'aborted' }
      if (!this.isOwnerActive(owner) || this.revocationEpoch !== epoch) return { ok: false, error: 'stale' }
      if (!loaded || typeof loaded.html !== 'string' || !loaded.html) return { ok: false, error: 'fetch' }
      if (!isMcpAppMimeType(loaded.mimeType)) return { ok: false, error: 'mime' }
      const bytes = typeof loaded.bytes === 'number' ? loaded.bytes : Buffer.byteLength(loaded.html, 'utf8')
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > this.maxResourceBytes) return { ok: false, error: 'size' }
      if (typeof loaded.csp !== 'string' || !loaded.csp) return { ok: false, error: 'fetch' }
      cached = { html: loaded.html, mimeType: loaded.mimeType, bytes, csp: loaded.csp, fetchedAt: this.now() }
      this.cache.set(key, cached)
      this.trimCache()
    }
    if (input.signal?.aborted) return { ok: false, error: 'aborted' }
    if (!this.isOwnerActive(owner) || this.revocationEpoch !== epoch) return { ok: false, error: 'stale' }

    const serverHash = appServerHash(input.serverId)
    const instanceId = randomBytes(16).toString('hex')
    this.instances.set(instanceId, {
      instanceId,
      serverHash,
      serverId: input.serverId,
      resourceUri: input.resourceUri,
      owner: Object.freeze({ ...owner }),
      html: cached.html,
      mimeType: cached.mimeType,
      bytes: cached.bytes,
      csp: cached.csp,
      createdAt: this.now()
    })
    return { ok: true, url: buildMcpAppUrl(serverHash, instanceId), instanceId, serverHash, bytes: cached.bytes, cached: fromCache }
  }

  read(url: string, options: McpAppReadOptions = {}): McpAppReadResult {
    if (options.method && options.method !== 'GET') return { ok: false, error: 'method' }
    const parsed = parseMcpAppUrl(url)
    if (!parsed) return { ok: false, error: 'unknown' }
    const instance = this.instances.get(parsed.instanceId)
    if (!instance || instance.serverHash !== parsed.serverHash) return { ok: false, error: 'unknown' }
    if (options.owner && !sameMcpAppOwner(instance.owner, options.owner)) return { ok: false, error: 'owner' }
    if (!this.isOwnerActive(instance.owner)) {
      this.instances.delete(instance.instanceId)
      return { ok: false, error: 'revoked' }
    }
    return {
      ok: true,
      html: instance.html,
      csp: instance.csp,
      mimeType: instance.mimeType,
      instanceId: instance.instanceId,
      serverHash: instance.serverHash,
      owner: { ...instance.owner }
    }
  }

  release(urlOrInstanceId: string, owner?: McpAppOwner): boolean {
    const instanceId = parseMcpAppUrl(urlOrInstanceId)?.instanceId ?? urlOrInstanceId
    const instance = this.instances.get(instanceId)
    if (!instance) return false
    if (owner && !sameMcpAppOwner(instance.owner, owner)) return false
    const removed = this.instances.delete(instanceId)
    if (removed) this.revocationEpoch++
    return removed
  }

  invalidateSession(sessionId: string): number {
    return this.invalidateWhere((owner) => owner.sessionId === sessionId)
  }

  invalidateRunner(serverId: string, runnerId: string): number {
    return this.invalidateWhere((owner) => owner.serverId === serverId && owner.runnerId === runnerId)
  }

  invalidateOwner(owner: McpAppOwner): number {
    return this.invalidateWhere((candidate) => sameMcpAppOwner(candidate, owner))
  }

  clear(): void {
    this.revocationEpoch++
    this.instances.clear()
    this.cache.clear()
  }

  has(urlOrInstanceId: string): boolean {
    const instanceId = parseMcpAppUrl(urlOrInstanceId)?.instanceId ?? urlOrInstanceId
    return this.instances.has(instanceId)
  }

  private isOwnerActive(owner: McpAppOwner): boolean {
    try {
      return this.ownerGuard.isActive(owner) === true
    } catch {
      return false
    }
  }

  private invalidateWhere(predicate: (owner: McpAppOwner) => boolean): number {
    this.revocationEpoch++
    let removed = 0
    for (const [instanceId, instance] of this.instances) {
      if (predicate(instance.owner)) {
        this.instances.delete(instanceId)
        removed++
      }
    }
    return removed
  }

  private isFresh(entry: McpAppCacheEntry): boolean {
    return this.now() - entry.fetchedAt < this.cacheTtlMs
  }

  private trimCache(): void {
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}
