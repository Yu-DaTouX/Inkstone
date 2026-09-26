/*
 * 额度刷新调度（实施-20 U3）的纯决策。
 *
 * 为什么单独抽出来：这一片的要求几乎全是「什么时候**不该**发请求」——
 * 页面不可见、接口不支持、同一 provider 已经有请求在飞、快照还新鲜。
 * 这些条件写在 effect 里就只能靠 sleep 测；抽成纯函数后可以用假时钟
 * 逐条断言，不必真的打真实 provider 的额度接口。
 */
import type { QuotaWindow } from './ipc'

export type QuotaRefreshTrigger = 'initial' | 'periodic' | 'focus' | 'reset'

export type QuotaRefreshReason =
  | 'initial'
  | 'periodic'
  | 'focus-stale'
  | 'reset-due'
  | 'skip-hidden'
  | 'skip-unsupported'
  | 'skip-inflight'
  | 'skip-fresh'

export interface QuotaRefreshInput {
  trigger: QuotaRefreshTrigger
  now: number
  /** 上次**成功**快照的时间；从没成功过就是 null */
  lastCheckedAt: number | null
  intervalMs: number
  visible: boolean
  /** null = 还不知道（先查一次才能知道这个 provider 支不支持） */
  supported: boolean | null
  provider: string
  inFlightProvider: string | null
}

/**
 * 该不该在这个触发点发一笔额度查询，以及理由。
 *
 * `initial` 不受 `visible` 限制：用户刚打开页面（哪怕窗口还不可见）也要先查一次，
 * 否则会看到一段空白的额度卡。
 */
export function decideQuotaRefresh(input: QuotaRefreshInput): {
  query: boolean
  reason: QuotaRefreshReason
} {
  if (!input.provider) return { query: false, reason: 'skip-unsupported' }
  if (input.supported === false) return { query: false, reason: 'skip-unsupported' }
  if (input.trigger !== 'initial' && !input.visible) return { query: false, reason: 'skip-hidden' }
  if (input.inFlightProvider === input.provider) return { query: false, reason: 'skip-inflight' }
  if (input.trigger === 'initial') return { query: true, reason: 'initial' }
  if (input.trigger === 'reset') return { query: true, reason: 'reset-due' }
  const last = input.lastCheckedAt
  if (last !== null && input.now - last < input.intervalMs) {
    return { query: false, reason: 'skip-fresh' }
  }
  return { query: true, reason: input.trigger === 'focus' ? 'focus-stale' : 'periodic' }
}

/**
 * 有没有窗口已经到重置时间但还没刷新。
 * 到点只代表「该重新问一次」，不代表额度已经归零 —— 界面不本地推算。
 */
export function hasDueQuotaWindow(windows: readonly QuotaWindow[], now: number): boolean {
  return windows.some((w) => w.resetAt !== undefined && w.resetAt <= now && !w.exceeded)
}
