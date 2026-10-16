/**
 * MCP App 实例的资源缓存与归属。
 *
 * ── 它解决什么 ──
 *   App 视图（`inkstone-app:` 协议）需要一份**不会随磁盘/远端变化而变化**的
 *   HTML 快照，并且这份快照必须绑定到「哪个会话、哪个 runner、哪次工具调用」。
 *   本模块就是这两件事：内存缓存 + 实例归属。
 *
 * ── 边界 ──
 *   · 只接受宿主 `McpAppHost.readResource` 的结果（由调用方经 `fetchResource`
 *     注入），本模块**不建连接、不发 RPC、不调 `tools/call`**；
 *   · 资源 URI 只当缓存键与读取参数，**绝不当作本机路径**打开；
 *   · 不保存 bearer / 环境变量 / 请求头等凭据；`structuredContent` 与 HTML
 *     只留在内存快照里，不回传模型（模型文本由上层自己取）；
 *   · MIME 必须 `text/html;profile=mcp-app`，体积默认 2 MiB；缺省一律拒绝。
 *
 * ── 归属失效（默认失败封闭） ──
 *   `ownerGuard` 是构造必填项：缺省、坏类型或 `isActive` 抛异常都按「不活跃」
 *   处理，绝不构造一个稍后再注入守卫的放行 store。每次 `prepare` / `read` 都
 *   重新问守卫；异步读取返回后再问一次，并核对**撤销 epoch** —— 抓取期间发生
 *   `invalidateSession/Runner/Owner`、`clear` 或 `release` 时，即使守卫仍报活跃，
 *   迟到资源也直接拒绝（`stale`），不会登记一个无人释放的实例。
 *   内部 owner 只存副本、返回副本，调用者改不到实例归属。
 *
 * 规范字段（MIME、体积上限）从 `app-spec.ts` 导入，不在这里另写。
 */
import { createHash, randomBytes } from 'node:crypto'
import { isMcpAppMimeType, MCP_APP_RESOURCE_MAX_BYTES } from './app-spec'
import {
  buildMcpAppUrl,
  isCompleteMcpAppOwner,
  parseMcpAppUrl,
  sameMcpAppOwner,
  type McpAppOwner
} from '../../shared/mcp-app-preview'

/** 一个服务固定 origin 的哈希：只由 serverId 决定，与资源 URI 无关。 */
export function appServerHash(serverId: string): string {
  return createHash('sha256').update(serverId).digest('hex').slice(0, 32)
}

/** 宿主读取后、交给 store 之前的成品资源。`csp` 已由上层按共享规则推导并收紧。 */
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
  /**
   * 调用者项目身份，只来自**宿主事实**（实例 owner 的 projectId），
   * 由 store 原样透传给 `host.readResource`；绝不由请求 / renderer / server 自报，
   * 也不从 `server.projectScope` 猜。
   */
  projectId?: string
}

/** 可注入的宿主资源获取回调（生产环境接 `McpAppHost.readResource`）。 */
export type McpAppResourceFetch = (request: McpAppResourceFetchRequest) => Promise<McpAppLoadedResource>

/** 当前该 owner 是否仍然有效（会话没切、runner 没重启、toolCall 没失效）。 */
export interface McpAppOwnerGuard {
  isActive(owner: McpAppOwner): boolean
}

export interface McpAppResourceStoreOptions {
  fetchResource: McpAppResourceFetch
  /**
   * 归属守卫，**必填**。缺失或坏类型会让构造直接抛错（fail-closed），
   * 不允许用「稍后注入」替代默认安全。整合前若必须占位，只能显式传
   * `{ isActive: () => false }`，并由 A6 用真实 owner 事实替换。
   */
  ownerGuard: McpAppOwnerGuard
  /** 无版本资源的缓存 TTL；默认 60s。 */
  cacheTtlMs?: number
  /** 同时存活的实例上限；默认 8。 */
  maxInstances?: number
  /** 资源缓存条目上限；默认 64。 */
  maxCacheEntries?: number
  /** 单份资源体积上限；默认取规范值 2 MiB。 */
  maxResourceBytes?: number
  /** 测试可注入时钟。 */
  now?: () => number
}

export interface McpAppPrepareInput {
  serverId: string
  resourceUri: string
  owner: McpAppOwner
  /** 资源版本；提供时按版本区分缓存，缺省按 TTL。 */
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
  /** 请求方法；只允许 GET。 */
  method?: string
  /** 调用方已知的 owner；提供时要求与实例归属完全一致。 */
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
  /** 撤销 epoch：任何失效/释放都自增，用来作废抓取中的迟到登记。 */
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

  /**
   * 为一次工具调用创建/复用 App 实例。
   *
   * 顺序：输入与归属校验 → 缓存命中 → 宿主读取 → **异步返回后重查归属** →
   * MIME/体积校验 → 生成随机实例号并登记。任何一步失败都不登记实例。
   */
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
    /* 守卫缺失/坏类型/抛异常都算不活跃：不抓取、不登记。 */
    if (!this.isOwnerActive(owner)) return { ok: false, error: 'revoked' }
    if (input.signal?.aborted) return { ok: false, error: 'aborted' }
    if (this.instances.size >= this.maxInstances) return { ok: false, error: 'busy' }

    /* 记下抓取开始时的撤销基线；抓取中任何失效/释放都会让它失配。 */
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
      /* 异步读取期间可能已经切会话/重启/销毁或被显式释放：迟到结果一律作废。 */
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
    /* 缓存路径也要重查：读缓存不代表 owner 还有效，也不能在撤销后被登记。 */
    if (input.signal?.aborted) return { ok: false, error: 'aborted' }
    if (!this.isOwnerActive(owner) || this.revocationEpoch !== epoch) return { ok: false, error: 'stale' }

    const serverHash = appServerHash(input.serverId)
    const instanceId = randomBytes(16).toString('hex')
    this.instances.set(instanceId, {
      instanceId,
      serverHash,
      serverId: input.serverId,
      resourceUri: input.resourceUri,
      /* 存副本：调用者事后再改自己的 owner 对象影响不到实例归属。 */
      owner: Object.freeze({ ...owner }),
      html: cached.html,
      mimeType: cached.mimeType,
      bytes: cached.bytes,
      csp: cached.csp,
      createdAt: this.now()
    })
    return { ok: true, url: buildMcpAppUrl(serverHash, instanceId), instanceId, serverHash, bytes: cached.bytes, cached: fromCache }
  }

  /**
   * 协议处理前的读取校验：地址身份、owner、活性都要过。
   * `owner` 缺省时只依赖 `ownerGuard`（主进程路径）；提供时还要求完全一致（跨 owner 拒绝）。
   */
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
      /* 返回副本：调用者改不到实例的内部归属。 */
      owner: { ...instance.owner }
    }
  }

  /** 释放实例；提供 owner 时必须一致，否则拒绝（跨 owner 不能卸载别人的视图）。 */
  release(urlOrInstanceId: string, owner?: McpAppOwner): boolean {
    const instanceId = parseMcpAppUrl(urlOrInstanceId)?.instanceId ?? urlOrInstanceId
    const instance = this.instances.get(instanceId)
    if (!instance) return false
    if (owner && !sameMcpAppOwner(instance.owner, owner)) return false
    const removed = this.instances.delete(instanceId)
    /* 释放也作废抓取中的迟到登记（即使释放的是同 owner 的旧实例）。 */
    if (removed) this.revocationEpoch++
    return removed
  }

  /** 切会话：立刻丢掉该会话的全部实例，后续读取直接失败。 */
  invalidateSession(sessionId: string): number {
    return this.invalidateWhere((owner) => owner.sessionId === sessionId)
  }

  /** runner 重启/回收：丢掉该 runner 的全部实例。 */
  invalidateRunner(serverId: string, runnerId: string): number {
    return this.invalidateWhere((owner) => owner.serverId === serverId && owner.runnerId === runnerId)
  }

  /** 精确失效一个 owner（例如某次工具调用被撤销）。 */
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

  /** 守卫必须明确返回 true 才算活跃；缺失/坏类型/抛异常一律 fail-closed。 */
  private isOwnerActive(owner: McpAppOwner): boolean {
    try {
      return this.ownerGuard.isActive(owner) === true
    } catch {
      return false
    }
  }

  private invalidateWhere(predicate: (owner: McpAppOwner) => boolean): number {
    /* 即使当前没有已登记实例，也要作废抓取中的迟到登记。 */
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
