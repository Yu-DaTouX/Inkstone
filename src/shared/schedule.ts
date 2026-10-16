/**
 * 定时任务的数据形状与触发规则（纯函数，主进程与界面共用）。
 *
 * 一次触发 = 新开一条会话、用任务里的指令与模型跑一遍；任务本身只记「什么时候、做什么」，
 * 不保存运行过程，过程留在触发出来的会话里。
 */

export type ScheduleTrigger =
  /** 每天 HH:MM（本机时区） */
  | { kind: 'daily'; time: string }
  /** 每周的指定几天（0 = 周日 … 6 = 周六）的 HH:MM */
  | { kind: 'weekly'; days: number[]; time: string }
  /** 每隔 N 分钟，从创建 / 启用起算 */
  | { kind: 'interval'; minutes: number }
  /** 只跑一次，绝对时间（毫秒） */
  | { kind: 'once'; at: number }

export interface ScheduledTask {
  id: string
  name: string
  /** 到点发给新会话的指令 */
  prompt: string
  /** 工作目录；空表示用触发时设置里的当前文件夹 */
  cwd?: string
  /** `provider/id`；空表示跟随当时的默认模型 */
  model?: string
  trigger: ScheduleTrigger
  enabled: boolean
  /** 模型创建的任务先停着，等用户在页面上确认启用，免得无人值守地自行运行 */
  pendingApproval?: boolean
  createdBy: 'user' | 'model'
  createdAt: number
  /** 下一次触发时间；停用时为空 */
  nextRunAt?: number
  lastRunAt?: number
  /** 上一次触发出来的会话 */
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

/** 校验并规整触发规则；不合法返回错误文字 */
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

/**
 * `after` 之后（不含）的下一次触发时间；单次任务已过期返回 undefined。
 * 每日 / 每周按本机时区的墙上时间算，所以跨夏令时也停在同一个钟点。
 */
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

/** 触发方式的一句话描述，给列表与确认用 */
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
