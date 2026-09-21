import type { QuotaWindow } from '../shared/ipc'

/**
 * Command Code 订阅额度：把 `/alpha/billing/credits` 的 JSON 变成窗口列表。
 *
 * 为什么单独成模块：这里有一个**极易搞反**的口径 —— 同一个响应里
 * `windowLimits.fiveHour/weekly.used` 是「已用」，而 `credits.monthlyCredits`
 * 是「本月剩余」。两者方向相反，又只有真实账号才能复现（要读线上接口），
 * 所以抽成纯函数 + 真实快照单测钉住，不必每次都用凭证去手工核对。
 *
 * ⚠️ 口径的实测证据（2026-09）：
 *   · weekly.cap = 35 ⇒ 套餐总额度 70（GOAT=$70；weekly = 总额度的一半，
 *     fiveHour cap $14 = 五分之一 —— 各套餐都按固定比例切）
 *   · 几乎没消耗的月份：monthlyCredits = 69.996221407，
 *     而 fiveHour.used = weekly.used = 0.003778593，70 − 0.003778593 正好是它
 *   · 曾经把 monthlyCredits 当「已用」→ 面板显示已用 99.99%（看着像本月已用完），
 *     官网 usage 页却是 0% —— 方向反了。
 */

/** `/alpha/billing/credits` 里单个窗口的形状 */
export interface CommandCodeWindow {
  /** 当前窗口**已用**（注意与 credits.monthlyCredits 的剩余口径相反） */
  used?: number
  cap?: number
  exceeded?: boolean
  /** 毫秒时间戳 */
  resetAt?: number
}

/** `/alpha/billing/credits` 的整体形状 */
export interface CommandCodeCredits {
  credits?: {
    /** ⚠️ 本月**剩余**额度（不是已用）—— 见本文件顶部的实测证据 */
    monthlyCredits?: number
    purchasedCredits?: number
    freeCredits?: number
  }
  windowLimits?: {
    limited?: boolean
    exceeded?: string
    fiveHour?: CommandCodeWindow
    weekly?: CommandCodeWindow
  }
}

/**
 * 三个窗口：5 小时 / 每周 / 本月，缺哪个就不产出哪个。
 *
 * 分母全靠推算（接口没有「套餐总额度」字段）：月度上限 = weekly.cap × 2。
 * 反推不出来就只给前两个窗口 —— 宁可少一行，也不编一个数字出来。
 *
 * @param periodEnd 本月窗口的重置时间（来自 `/alpha/billing/subscriptions`
 *   的 `currentPeriodEnd`；拿不到就传 undefined，界面只显示无重置时间的窗口）
 */
export function commandCodeWindows(credits: CommandCodeCredits, periodEnd?: number): QuotaWindow[] {
  const wl = credits.windowLimits ?? {}
  const windows: QuotaWindow[] = []
  const add = (id: string, label: string, w?: CommandCodeWindow): void => {
    const cap = Number(w?.cap)
    if (!w || !Number.isFinite(cap) || cap <= 0) return
    windows.push({
      id,
      label,
      used: Number(w.used ?? 0),
      total: cap,
      resetAt: typeof w.resetAt === 'number' ? w.resetAt : undefined,
      exceeded: w.exceeded === true
    })
  }
  add('fiveHour', '5 小时', wl.fiveHour)
  add('weekly', '每周', wl.weekly)

  /*
   * 月度：分母反推，分子由「剩余」换算回「已用」。
   * 套餐总额度 = 月度上限 = weekly.cap × 2（见文件顶部）。
   * 接口的 monthlyCredits 是**剩余** ⇒ 已用 = 总额度 − 剩余。
   */
  const planCredits = Number(wl.weekly?.cap) * 2
  const monthlyRemaining = Number(credits.credits?.monthlyCredits)
  if (Number.isFinite(planCredits) && planCredits > 0 && Number.isFinite(monthlyRemaining)) {
    /*
     * 剩余超过推算出的总额度时（例如另外买了额度包），以剩余为准抬高总额度，
     * 免得算出负数已用；反过来剩余为负说明数据异常，夹回 0 并如实报超支。
     */
    const monthlyTotal = Math.max(planCredits, monthlyRemaining)
    const usedMonthly = Math.max(0, monthlyTotal - monthlyRemaining)
    windows.push({
      id: 'monthly',
      label: '本月',
      used: usedMonthly,
      total: monthlyTotal,
      resetAt: periodEnd,
      exceeded: monthlyRemaining <= 0,
      /*
       * 月度上限是**反推**的（weekly.cap × 2），不是接口给的官方字段。
       * 标出来，UI 才能如实写「月度上限推算」而不是假装精确。
       */
      estimated: true
    })
  }
  return windows
}
