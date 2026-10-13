/**
 * 「额度恢复后自动续跑」的纯判定：哪些错误值得等、什么时候算恢复、下次什么时候再查。
 * 不碰网络、定时器和会话；宿主侧（store）只负责按这里的结论查询额度并发送续跑消息。
 */
import type { QuotaWindow } from './ipc'
import { classifyModelError } from './model-errors'

/** 续跑时发给模型的话：不重述任务，让它从上一轮停下的地方接着做。 */
export const QUOTA_RESUME_PROMPT = '额度已恢复，请从上一轮中断的地方继续完成任务。'

/** 额度恢复前的轮询间隔；官方窗口最短 5 小时，1 分钟足够，不去打扰接口。 */
export const QUOTA_RESUME_POLL_MS = 60_000

/** 窗口到点后留的余量：服务端重置略有延迟，太早查只会拿到旧值。 */
export const RESET_GRACE_MS = 5_000

/** 套餐/窗口用量用尽才值得等；余额不足要充值，频率限流稍等即可，都不挂按钮。 */
export function isQuotaWaitError(errorText: unknown): boolean {
  const info = classifyModelError(errorText)
  if (info.kind !== 'quota' || info.quotaScope !== 'usage') return false
  return !/insufficient[ _](?:balance|funds|credit)|balance|credit|funds|余额|充值/i.test(info.text)
}

/** 已用满的窗口（5 小时 / 每周等）；仅供参考的窗口不算。 */
export function blockedQuotaWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  return windows.filter((w) => !w.informational && (w.exceeded || (w.total > 0 && w.used >= w.total)))
}

export interface QuotaResumeDecision {
  /** 没有窗口再被卡住：可以续跑 */
  ready: boolean
  /** 被卡住窗口里最晚的重置时间（要等最晚的那个才全部恢复）；接口没给就是 undefined */
  resetAt?: number
  /** 下一次该查询的时间戳；ready 时无意义 */
  nextCheckAt: number
}

/**
 * 根据最新额度快照判断能否续跑。
 *
 * 重置时间已过也以接口返回为准：到点只代表「该再问一次」，
 * 不代表已经恢复（与额度磁贴的口径一致），所以 ready 只看接口是否还报满。
 */
export function decideQuotaResume(windows: readonly QuotaWindow[], now: number): QuotaResumeDecision {
  const blocked = blockedQuotaWindows(windows)
  if (!blocked.length) return { ready: true, nextCheckAt: now }
  const resets = blocked.map((w) => w.resetAt).filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  const resetAt = resets.length ? Math.max(...resets) : undefined
  /* 离重置还远就按固定间隔轮询；快到点时对准重置时间，省一轮等待。 */
  const poll = now + QUOTA_RESUME_POLL_MS
  const aligned = resetAt !== undefined && resetAt > now ? resetAt + RESET_GRACE_MS : poll
  return { ready: false, resetAt, nextCheckAt: Math.min(poll, aligned) }
}
