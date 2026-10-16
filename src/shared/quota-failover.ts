export const QUOTA_FAILOVER_PROMPT = '已切换到另一个账号，请从上一轮中断的地方继续完成任务。'

export const FAILOVER_CHAIN_MS = 10 * 60_000

export function failoverSkip(tried: readonly string[], lastFailoverAt: number, now: number): string[] {
  return lastFailoverAt > 0 && now - lastFailoverAt < FAILOVER_CHAIN_MS ? [...tried] : []
}

export interface FailoverCandidate {
  key: string
  blocked: boolean
  unknown?: boolean
  resetAt?: number
}

export function failoverOrder(keys: readonly string[], activeKey: string | undefined, skip: readonly string[] = []): string[] {
  const start = activeKey ? keys.indexOf(activeKey) : -1
  const rotated = start < 0 ? [...keys] : [...keys.slice(start + 1), ...keys.slice(0, start)]
  const skipped = new Set([...skip, ...(activeKey ? [activeKey] : [])])
  return rotated.filter((key) => !skipped.has(key))
}

export type FailoverPick =
  | { ok: true; key: string }
  | { ok: false; earliestResetAt?: number }

export function pickFailover(candidates: readonly FailoverCandidate[]): FailoverPick {
  const free = candidates.find((c) => !c.blocked && !c.unknown)
  if (free) return { ok: true, key: free.key }
  const resets = candidates.filter((c) => c.blocked && c.resetAt !== undefined).map((c) => c.resetAt as number)
  return { ok: false, earliestResetAt: resets.length ? Math.min(...resets) : undefined }
}

export type CodexFailoverResult =
  | { ok: true; key: string; fromKey?: string; email?: string; label?: string }
  | { ok: false; error?: string; earliestResetAt?: number }
