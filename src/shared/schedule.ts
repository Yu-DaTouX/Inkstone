export type ScheduleTrigger =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: number }

export interface ScheduledTask {
  id: string
  name: string
  prompt: string
  cwd?: string
  model?: string
  trigger: ScheduleTrigger
  enabled: boolean
  pendingApproval?: boolean
  createdBy: 'user' | 'model'
  createdAt: number
  nextRunAt?: number
  pendingRun?: { id: string; startedAt: number; scheduledAt?: number; status: 'claimed' | 'unknown' }
  lastRunAt?: number
  lastSessionId?: string
  lastError?: string
}

export const MIN_INTERVAL_MINUTES = 5
export const MAX_PROMPT_LENGTH = 12_000
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function parseTime(time: string): { h: number; m: number } | null {
  const hit = TIME.exec(time)
  return hit ? { h: Number(hit[1]), m: Number(hit[2]) } : null
}

export function normalizeTrigger(value: unknown): { ok: true; trigger: ScheduleTrigger } | { ok: false; error: string } {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') return { ok: false, error: '缺少触发方式' }
  if (v.kind === 'daily' || v.kind === 'weekly') {
    const time = typeof v.time === 'string' ? v.time.trim() : ''
    const parsed = parseTime(time)
    if (!parsed) return { ok: false, error: '时间需要写成 HH:MM（24 小时制）' }
    const clean = `${String(parsed.h).padStart(2, '0')}:${String(parsed.m).padStart(2, '0')}`
    if (v.kind === 'daily') return { ok: true, trigger: { kind: 'daily', time: clean } }
    const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
    if (!days.length) return { ok: false, error: '每周触发至少选一天（0 = 周日 … 6 = 周六）' }
    return { ok: true, trigger: { kind: 'weekly', days, time: clean } }
  }
  if (v.kind === 'interval') {
    const minutes = Math.floor(Number(v.minutes))
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) return { ok: false, error: `间隔至少 ${MIN_INTERVAL_MINUTES} 分钟` }
    return { ok: true, trigger: { kind: 'interval', minutes: Math.min(minutes, 60 * 24 * 30) } }
  }
  if (v.kind === 'once') {
    const at = Number(v.at)
    if (!Number.isFinite(at) || at <= 0) return { ok: false, error: '单次触发需要一个有效的时间' }
    return { ok: true, trigger: { kind: 'once', at: Math.floor(at) } }
  }
  return { ok: false, error: '触发方式只支持 daily / weekly / interval / once' }
}

export function nextRunAt(trigger: ScheduleTrigger, after: number): number | undefined {
  if (trigger.kind === 'once') return trigger.at > after ? trigger.at : undefined
  if (trigger.kind === 'interval') return after + trigger.minutes * 60_000
  const time = parseTime(trigger.time)
  if (!time) return undefined
  const days = trigger.kind === 'weekly' ? new Set(trigger.days) : null
  const start = new Date(after)
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, time.h, time.m, 0, 0)
    if (day.getTime() <= after) continue
    if (days && !days.has(day.getDay())) continue
    return day.getTime()
  }
  return undefined
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function describeTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === 'daily') return `每天 ${trigger.time}`
  if (trigger.kind === 'weekly') {
    const key = trigger.days.join(',')
    const label = key === '1,2,3,4,5' ? '工作日' : key === '0,6' ? '周末' : trigger.days.length === 7 ? '每天' : `每周${trigger.days.map(d => WEEKDAYS[d]).join('、')}`
    return `${label} ${trigger.time}`
  }
  if (trigger.kind === 'interval') return trigger.minutes % 60 === 0 ? `每 ${trigger.minutes / 60} 小时` : `每 ${trigger.minutes} 分钟`
  return `仅一次 ${new Date(trigger.at).toLocaleString()}`
}
