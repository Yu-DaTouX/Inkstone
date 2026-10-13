/**
 * 「额度用尽后换账号续跑」的纯选择逻辑：按什么顺序试哪些账号、谁算可用。
 * 不碰凭证和网络；主进程负责逐个查额度并真正切换。
 */

/** 额度用尽后让模型接着做的话：账号已换，任务没变。 */
export const QUOTA_FAILOVER_PROMPT = '已切换到另一个账号，请从上一轮中断的地方继续完成任务。'

/** 换号后正常跑过这么久再用尽，算新的一轮：先前用过的账号可能已恢复，按额度重新挑，账号之间才能交替。 */
export const FAILOVER_CHAIN_MS = 10 * 60_000

/**
 * 本次换号要跳过的账号。距上次换号不久又用尽，说明刚换上的账号也不行（额度接口说有余量、请求却失败），
 * 沿用已试列表防止来回切；隔得够久就清空，让已恢复的账号重新进入候选。
 */
export function failoverSkip(tried: readonly string[], lastFailoverAt: number, now: number): string[] {
  return lastFailoverAt > 0 && now - lastFailoverAt < FAILOVER_CHAIN_MS ? [...tried] : []
}

export interface FailoverCandidate {
  key: string
  /** 额度窗口里有已用满的 */
  blocked: boolean
  /** 拿不到凭证或查不到额度：不能确认可用，不选 */
  unknown?: boolean
  /** 被卡住窗口里最晚的重置时间 */
  resetAt?: number
}

/**
 * 候选顺序：从当前账号的下一个开始往后轮，到头回到最前面；
 * 当前账号和本轮已经试过的（`skip`）不再进入，免得两个都满的账号来回切。
 */
export function failoverOrder(keys: readonly string[], activeKey: string | undefined, skip: readonly string[] = []): string[] {
  const start = activeKey ? keys.indexOf(activeKey) : -1
  const rotated = start < 0 ? [...keys] : [...keys.slice(start + 1), ...keys.slice(0, start)]
  const skipped = new Set([...skip, ...(activeKey ? [activeKey] : [])])
  return rotated.filter((key) => !skipped.has(key))
}

export type FailoverPick =
  | { ok: true; key: string }
  /** 没有可用账号；earliestResetAt 是各账号里最早恢复的时间，没人给时间就没有 */
  | { ok: false; earliestResetAt?: number }

/** 按给定顺序取第一个确认没被卡住的账号。 */
export function pickFailover(candidates: readonly FailoverCandidate[]): FailoverPick {
  const free = candidates.find((c) => !c.blocked && !c.unknown)
  if (free) return { ok: true, key: free.key }
  const resets = candidates.filter((c) => c.blocked && c.resetAt !== undefined).map((c) => c.resetAt as number)
  return { ok: false, earliestResetAt: resets.length ? Math.min(...resets) : undefined }
}

/** 主进程换号的结果；凭证不出主进程，这里只有显示用的身份。 */
export type CodexFailoverResult =
  | { ok: true; key: string; /** 换走的那个账号 */ fromKey?: string; email?: string; label?: string }
  | { ok: false; error?: string; earliestResetAt?: number }
