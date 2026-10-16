/**
 * 定时运行来源与 T 编号作用域（v3 WP-51）。
 *
 * 定时任务每触发一次就是一个正式运行实例，但它**不占会话 S 号**：编号作用域
 * 落在任务 id 上，由现行 `SessionCodeStore` 分配一次 `kind:'scheduled'` 的 T 号
 * 并持久化。这里只放可脱离 IO 测试的纯逻辑：
 *
 *   · `normalizeScheduledOrigin` —— 任务 id → 来源；空 id 返回 null，不发假编号；
 *   · `scheduledRunContext` —— 把观察到的会话事实与来源拼成正式 `RunContext`；
 *   · `ScheduledOriginTable` —— 稳定 runner / 会话的来源表，供宿主在第一个运行
 *     事件之前绑定，避免先给会话分了 S 号再事后改 T。
 *
 * 分配编号、开运行、写历史都与 IO 有关，留在 `runs-host.ts`，本文件不 import 主进程模块。
 *
 * ── 为什么会话 id 是主键、代次只作退化键 ──
 * 运行事件总带真实 `sessionId`；而 runner 空闲复用时 pi 进程没换，AgentController
 * 构造时捕获的 observer 代次会停在旧值。若把代次当兜底，一个曾被定时任务用过的
 * runner 之后跑普通会话，会被误判成定时。所以 `resolve` 只在**没有会话 id**时才
 * 看代次，不用它给会话 id 兜底。
 */
import type { RunModel } from '../../shared/runs'
import type { RunContext } from './registry'

export interface ScheduledOrigin {
  kind: 'scheduled'
  scopeId: string
}

export interface ScheduledOriginKey {
  sessionId?: string
  generation?: number
}

/** 构造定时运行上下文所需的最小会话事实。 */
export interface ScheduledContextSeed {
  sessionId: string
  sessionPath?: string
  title?: string
  model?: RunModel
  generation?: number
}

/** 规范化任务 id；只有非空字符串才是一个真实来源。 */
export function normalizeScheduledOrigin(scopeId: unknown): ScheduledOrigin | null {
  const id = typeof scopeId === 'string' ? scopeId.trim() : ''
  return id ? { kind: 'scheduled', scopeId: id } : null
}

/**
 * 由会话事实 + 来源构造正式 `RunContext`。
 *
 * 保留会话身份（sessionPath / title / model / generation），`kind` 固定为
 * `scheduled`、`scopeId` 用任务 id；调用方确定的 `code` / `runId` 原样带上。
 */
export function scheduledRunContext(
  seed: ScheduledContextSeed,
  origin: ScheduledOrigin,
  extra: { code?: string; runId?: string } = {}
): RunContext {
  return {
    sessionId: seed.sessionId,
    kind: 'scheduled',
    scopeId: origin.scopeId,
    ...(seed.sessionPath ? { sessionPath: seed.sessionPath } : {}),
    ...(seed.title ? { title: seed.title } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.generation !== undefined ? { generation: seed.generation } : {}),
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.runId ? { runId: extra.runId } : {})
  }
}

/** 稳定 runner 代次 / 会话双键的来源表。 */
export class ScheduledOriginTable {
  private readonly bySession = new Map<string, ScheduledOrigin>()
  private readonly byGeneration = new Map<number, ScheduledOrigin>()

  bind(origin: ScheduledOrigin, key: ScheduledOriginKey): void {
    if (key.sessionId) this.bySession.set(key.sessionId, origin)
    if (key.generation !== undefined) this.byGeneration.set(key.generation, origin)
  }

  /** 会话 id 优先；没有会话 id 时退到代次，绝不用代次给会话 id 兜底。 */
  resolve(key: ScheduledOriginKey): ScheduledOrigin | undefined {
    if (key.sessionId) return this.bySession.get(key.sessionId)
    if (key.generation !== undefined) return this.byGeneration.get(key.generation)
    return undefined
  }

  clear(key: ScheduledOriginKey): void {
    if (key.sessionId) this.bySession.delete(key.sessionId)
    if (key.generation !== undefined) this.byGeneration.delete(key.generation)
  }

  reset(): void {
    this.bySession.clear()
    this.byGeneration.clear()
  }

  size(): number {
    return this.bySession.size
  }
}
