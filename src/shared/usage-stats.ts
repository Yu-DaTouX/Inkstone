/**
 * 启动页用量概览：按本地日期汇总的会话、消息、token 与模型，以及按范围（全部 / 30 天 / 7 天）的聚合。
 *
 * 主进程逐个会话文件记一份按日的计数（usage-stats.ts，可增量），这里只做纯聚合，便于测试。
 */

export type UsageRange = 'all' | '30d' | '7d'

/** 某个会话文件在某一天（本地日期 YYYY-MM-DD）的计数 */
export interface UsageDay {
  /** 用户与助手消息数 */
  m: number
  /** token 总数（助手回复的 totalTokens，含缓存读写） */
  t: number
  /** 按本地小时的消息数（键 0–23） */
  h: Record<string, number>
  /** 按模型的 token 数（键为 provider/model） */
  models: Record<string, number>
}

export type FileUsage = Record<string, UsageDay>

export interface UsageModelShare {
  /** provider/model */
  key: string
  tokens: number
}

export interface UsageStatsView {
  range: UsageRange
  sessions: number
  messages: number
  tokens: number
  activeDays: number
  /** 消息最多的本地小时；没有数据时为 null */
  peakHour: number | null
  /** 按 token 排序的模型（最多 8 个） */
  models: UsageModelShare[]
  /** 热力图：从最早一周的周一到今天，每天的 token 数 */
  heat: Array<{ date: string; tokens: number }>
  /** 统计时间（ms） */
  at: number
}

/** 热力图显示的周数 */
export const HEAT_WEEKS = 26

export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function rangeStart(range: UsageRange, now: number): string | null {
  if (range === 'all') return null
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (range === '30d' ? 29 : 6))
  return localDay(d.getTime())
}

export function aggregateUsage(files: FileUsage[], range: UsageRange, now = Date.now()): UsageStatsView {
  const from = rangeStart(range, now)
  const inRange = (day: string): boolean => from === null || day >= from
  let sessions = 0
  let messages = 0
  let tokens = 0
  const days = new Set<string>()
  const hours = new Array<number>(24).fill(0)
  const models = new Map<string, UsageModelShare>()
  const perDay = new Map<string, number>()

  for (const file of files) {
    let touched = false
    for (const [day, u] of Object.entries(file)) {
      perDay.set(day, (perDay.get(day) ?? 0) + u.t)
      if (!inRange(day)) continue
      if (u.m > 0 || u.t > 0) {
        touched = true
        days.add(day)
      }
      messages += u.m
      tokens += u.t
      for (const [h, n] of Object.entries(u.h)) {
        const i = Number(h)
        if (i >= 0 && i < 24) hours[i] += n
      }
      for (const [key, n] of Object.entries(u.models)) {
        const hit = models.get(key) ?? { key, tokens: 0 }
        hit.tokens += n
        models.set(key, hit)
      }
    }
    if (touched) sessions++
  }

  const peak = Math.max(...hours)
  const heat: UsageStatsView['heat'] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  /* 从 HEAT_WEEKS 周前的那个周一开始，到今天为止 */
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - (HEAT_WEEKS - 1) * 7)
  for (const d = new Date(start); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
    const date = localDay(d.getTime())
    heat.push({ date, tokens: perDay.get(date) ?? 0 })
  }

  return {
    range,
    sessions,
    messages,
    tokens,
    activeDays: days.size,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
    heat,
    at: now
  }
}

/** 热力图分级（0–4）：按非零天的四分位数，避免一天极端值把其余全压成最浅 */
export function heatLevels(values: number[]): number[] {
  const nonzero = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!nonzero.length) return values.map(() => 0)
  const q = (p: number): number => nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))]
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)]
  return values.map((v) => (v <= 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4))
}
