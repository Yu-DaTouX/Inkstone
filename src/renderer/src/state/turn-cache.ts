/**
 * 轮次数据的按需获取与缓存（实施-26 R2）。
 *
 * 为什么不能全图预读：轮次卡要看消息，而会话级地图只看元数据。
 * R0 实测「本机最大的 20 个会话合计 210MB」，一次性读会带来约 1.2s 的连续
 * 卡顿。所以策略是**渐进披露**：默认只有会话级；点开会话节点才读它的轮次。
 *
 * 这里只放纯逻辑（缓存 / 失效 / LRU / 竞态闸门），真正的读取由调用方注入
 * （`snapshotFromPeek` + `window.yan.peekSession`）——
 * 这样「读 17MB 会不会卡」与「缓存有没有丢状态」可以分开测。
 *
 * 两条不变量：
 *   · **版本不对就不显示**：会话文件变了（`version` = 文件 mtime / updatedAt）
 *     就把旧轮次丢掉重新读，不拿过期内容当当前内容。
 *   · **慢结果不许覆盖新状态**：读的时候版本又变了，回来的旧结果直接丢弃。
 *
 * 有损读取要点（截断 / 跳过）随快照一起带出，交给卡片标注 ——
 * 缓存层不隐瞒「这里有内容被省略」。
 */
import type { PeekResult } from '../../../shared/ipc'
import { buildConversationTurns, type ConversationTurn } from '../../../shared/conversation-turns'

/**
 * 同时保留的会话轮次上限。
 *
 * R0 实测 20 个大会话约 1.2s、heap 增量约 76MB；限 3 个既是性能保险，
 * 也是产品判断 —— 一轮展开 4 个会话时用户已经看不到「一眼全局」了。
 */
export const TURN_CACHE_MAX = 3

export interface TurnSnapshot {
  /** 读取时的会话版本（文件 mtime / updatedAt），用于失效判断 */
  version: number
  turns: ConversationTurn[]
  /** 会话文件里一共多少条 message entry（可能大于轮次里的消息数） */
  total: number
  /** 被截断 / 跳过的内容条数；>0 时卡片必须能看出「有内容被省略」 */
  truncated: number
  bytes: number
}

export type TurnEntry =
  | { status: 'loading'; version: number }
  | { status: 'ready'; version: number; snapshot: TurnSnapshot }
  | { status: 'error'; version: number; error: string }

export interface TurnCacheState {
  entries: Record<string, TurnEntry>
  /** LRU：最近请求的 path 在前 */
  order: string[]
}

export interface BeginResult {
  state: TurnCacheState
  /**
   * 调用方是否真的要去读。
   *
   * `false` 有两种情况：缓存命中（版本一致且已就绪），或同一个版本
   * 已经在读了 —— 后者防止重复点开同一张卡时并发读同一份文件。
   */
  shouldLoad: boolean
}

export function initialTurnCache(): TurnCacheState {
  return { entries: {}, order: [] }
}

function touched(order: string[], path: string): string[] {
  return [path, ...order.filter((p) => p !== path)]
}

/**
 * 声明「要展示某个会话的轮次」。
 *
 * 版本变了 → 旧快照立刻不可见（进入 loading），避免显示过期轮次。
 */
export function turnCacheBegin(state: TurnCacheState, path: string, version: number): BeginResult {
  const current = state.entries[path]
  if (current && current.version === version && current.status !== 'error') {
    // 已就绪或已在读：命中，只把它提到 LRU 最前
    return { state: { entries: state.entries, order: touched(state.order, path) }, shouldLoad: false }
  }
  return {
    state: {
      entries: { ...state.entries, [path]: { status: 'loading', version } },
      order: touched(state.order, path)
    },
    shouldLoad: true
  }
}

export type SettleOutcome = { ok: true; snapshot: TurnSnapshot } | { ok: false; error: string }

/**
 * 落一次读取结果。
 *
 * 版本与当前登记的不一致 → **丢弃**：那说明期间又开会话 / 文件又变了，
 * 这是「慢结果覆盖新状态」的唯一入口，必须在这里挡住。
 */
export function turnCacheSettle(
  state: TurnCacheState,
  path: string,
  version: number,
  outcome: SettleOutcome
): TurnCacheState {
  const current = state.entries[path]
  if (!current || current.version !== version) return state

  const entry: TurnEntry = outcome.ok
    ? { status: 'ready', version, snapshot: outcome.snapshot }
    : { status: 'error', version, error: outcome.error }

  return pruneTurns({ entries: { ...state.entries, [path]: entry }, order: touched(state.order, path) })
}

export function turnCacheSelect(state: TurnCacheState, path: string): TurnEntry | undefined {
  return state.entries[path]
}

/**
 * 把 `peekSession` 的结果转成轮次快照。
 *
 * `peek` 为 `null` 表示文件读不出来（`readSessionMessages` 的失败出口）——
 * 调用方应落成 error 态，而不是显示一张空卡。
 */
export function snapshotFromPeek(version: number, peek: PeekResult): TurnSnapshot {
  return {
    version,
    turns: buildConversationTurns(peek.messages),
    total: peek.total,
    truncated: peek.truncated,
    bytes: peek.bytes
  }
}

/**
 * 读一个会话的轮次快照（依赖注入的 `peek`，R3 传 `window.yan.peekSession`）。
 *
 * 把两个失败出口固定在这里，界面就不需要各自判：
 *   · `peek` 返回 `null` → 「内容不可读」（`readSessionMessages` 的失败出口），
 *     界面显示明确失败态，而不是一张看起来正常的空卡；
 *   · `peek` 抛异常 → 把错误交给调用方展示。
 *
 * 读取是异步的：R0 实测单个大会话约 120ms，只要不让它阻塞渲染就不会“卡住”。
 */
export async function loadTurnSnapshot(
  path: string,
  version: number,
  peek: (path: string) => Promise<PeekResult | null>
): Promise<SettleOutcome> {
  try {
    const res = await peek(path)
    if (!res) return { ok: false, error: '内容不可读' }
    return { ok: true, snapshot: snapshotFromPeek(version, res) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * LRU 淘汰，但**正在读的条目一个都不能丢**：它们的 `settle` 必须能落地，
 * 否则会永远停在 loading（这是纯逻辑层最容易埋的坑）。
 */
function pruneTurns(state: TurnCacheState): TurnCacheState {
  const loading = Object.keys(state.entries).filter((p) => state.entries[p]?.status === 'loading')
  const budget = Math.max(0, TURN_CACHE_MAX - loading.length)
  const keep = new Set(loading)
  for (const path of state.order) {
    if (keep.size >= loading.length + budget) break
    if (state.entries[path]?.status !== 'loading') keep.add(path)
  }
  const entries: Record<string, TurnEntry> = {}
  for (const path of Object.keys(state.entries)) {
    if (keep.has(path)) entries[path] = state.entries[path] as TurnEntry
  }
  return { entries, order: state.order.filter((p) => keep.has(p)) }
}
