/**
 * 结构化回答块：模型在回答里写带标签的代码块，宿主校验后用自己的组件画出来。
 *
 * - JSON 数据块（yan-chart / yan-stats / yan-cards / yan-record / yan-flow / yan-steps）：
 *   模型只给数据和文字，样式、比例尺、配色都由宿主决定 —— 换主题自动重画，
 *   历史里存的仍是文字，其他客户端里也能当普通代码读懂。校验失败就退回代码块，绝不猜着画。
 * - mermaid：标准 mermaid 语法，宿主离线渲染（严格安全级别）。
 * - yan-widget：自由 HTML/SVG 小部件，放进与 HTML 成果同一个隔离协议（无网络、无宿主对象），
 *   宿主注入主题变量；页面只能回报高度、请求把一段追问填进输入框，由用户决定是否发送。
 */

export const VISUAL_DATA_LANGS = ['yan-chart', 'yan-stats', 'yan-cards', 'yan-record', 'yan-flow', 'yan-steps'] as const
export type VisualDataLang = (typeof VISUAL_DATA_LANGS)[number]
export const VISUAL_BLOCK_LANGS = [...VISUAL_DATA_LANGS, 'mermaid', 'yan-widget'] as const
export type VisualBlockLang = (typeof VISUAL_BLOCK_LANGS)[number]

/** 小部件 HTML 上限：内联在消息里，过大应改用 HTML 成果文件 */
export const VISUAL_WIDGET_MAX_CHARS = 200_000
/** mermaid 源码上限 */
export const VISUAL_MERMAID_MAX_CHARS = 20_000

export interface VisualSource {
  label?: string
  url: string
}
export interface VisualLink {
  label: string
  url: string
}

export type ChartType = 'bar' | 'hbar' | 'stacked' | 'line' | 'area' | 'dumbbell' | 'diverging'
export interface ChartBlock {
  kind: 'chart'
  type: ChartType
  title: string
  subtitle?: string
  unit?: string
  max?: number
  labels: string[]
  series: Array<{ name: string; values: number[] }>
  stats?: Array<{ label: string; value: string; detail?: string }>
  source: string
  note?: string
  sources?: VisualSource[]
}
export type Trend = 'up' | 'down' | 'flat'
export interface StatsBlock {
  kind: 'stats'
  title?: string
  items: Array<{
    label: string
    value: string
    delta?: string
    trend?: Trend
    /** 哪个方向是好事（决定涨跌着色），缺省 up */
    good?: 'up' | 'down'
    detail?: string
    spark?: number[]
    meter?: { value: number; max: number }
  }>
  source?: string
  sources?: VisualSource[]
}
export interface CardsBlock {
  kind: 'cards'
  title?: string
  layout: 'list' | 'grid'
  items: Array<{ title: string; icon?: string; badge?: string; recommended?: boolean; description?: string; meta?: string; links?: VisualLink[] }>
  sources?: VisualSource[]
}
export interface RecordBlock {
  kind: 'record'
  title: string
  subtitle?: string
  badge?: string
  fields: Array<{ label: string; value: string; icon?: string }>
  links?: VisualLink[]
  note?: string
}
export type FlowTone = 'ok' | 'warn' | 'err' | 'info'
export interface FlowBlock {
  kind: 'flow'
  title?: string
  join: 'plus' | 'arrow'
  steps: Array<{ icon?: string; title: string; detail?: string }>
  result?: { tone: FlowTone; text: string }
  note?: string
  sources?: VisualSource[]
}
export interface StepsBlock {
  kind: 'steps'
  title?: string
  /** 最后一步的「下一步」回到第一步（事件循环这类循环过程） */
  loop: boolean
  steps: Array<{ title: string; body: string; icon?: string }>
}
export type VisualBlock = ChartBlock | StatsBlock | CardsBlock | RecordBlock | FlowBlock | StepsBlock

export type VisualParse = { ok: true; block: VisualBlock } | { ok: false; error: string }

export function isVisualBlockLang(lang: string | undefined): lang is VisualBlockLang {
  return !!lang && (VISUAL_BLOCK_LANGS as readonly string[]).includes(lang)
}
export function isVisualDataLang(lang: string | undefined): lang is VisualDataLang {
  return !!lang && (VISUAL_DATA_LANGS as readonly string[]).includes(lang)
}

const LIMIT = { text: 200, long: 600, labels: 24, series: 4, stats: 4, items: 8, links: 4, steps: 6, sources: 6 }

class Invalid extends Error {}
const fail = (message: string): never => { throw new Invalid(message) }

function obj(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} 应为对象`)
  return value as Record<string, unknown>
}
function str(value: unknown, where: string, max = LIMIT.text): string {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value)
  if (typeof value !== 'string' || !value.trim()) fail(`${where} 应为非空文字`)
  const text = (value as string).trim()
  if (text.length > max) fail(`${where} 超过 ${max} 字`)
  return text
}
function optStr(value: unknown, where: string, max = LIMIT.text): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : str(value, where, max)
}
function list(value: unknown, where: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${where} 应为数组`)
  const items = value as unknown[]
  if (items.length < min || items.length > max) fail(`${where} 应有 ${min}–${max} 项`)
  return items
}
function optList(value: unknown, where: string, max: number): unknown[] | undefined {
  return value === undefined ? undefined : list(value, where, 0, max)
}
function num(value: unknown, where: string, { min = -Infinity }: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(`${where} 应为${min === 0 ? '非负' : ''}数字`)
  return value as number
}

/** 只放行 http(s) 绝对地址，不带账号信息。 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
  } catch { return null }
}
function url(value: unknown, where: string): string {
  return safeHttpUrl(value) ?? fail(`${where} 不是有效的 http(s) 地址`)
}
function sources(value: unknown): VisualSource[] | undefined {
  return optList(value, 'sources', LIMIT.sources)?.map((raw, i) => {
    const item = obj(raw, `sources[${i}]`)
    return { url: url(item.url, `sources[${i}].url`), label: optStr(item.label, `sources[${i}].label`) }
  })
}
function links(value: unknown, where: string): VisualLink[] | undefined {
  return optList(value, where, LIMIT.links)?.map((raw, j) => {
    const link = obj(raw, `${where}[${j}]`)
    return { label: str(link.label, `${where}[${j}].label`, 40), url: url(link.url, `${where}[${j}].url`) }
  })
}

const CHART_TYPES: readonly ChartType[] = ['bar', 'hbar', 'stacked', 'line', 'area', 'dumbbell', 'diverging']
function parseChart(data: Record<string, unknown>): ChartBlock {
  const declared = data.type === undefined ? 'bar' : CHART_TYPES.includes(data.type as ChartType) ? data.type as ChartType : fail(`type 只能是 ${CHART_TYPES.join(' / ')}`)
  /* 单组柱状数据里出现负值（如零下气温）：改用偏离基准线的画法，而不是整块作废 */
  const rawSeries = Array.isArray(data.series) ? data.series : []
  const negative = rawSeries.length === 1 && Array.isArray((rawSeries[0] as { values?: unknown })?.values) && ((rawSeries[0] as { values: unknown[] }).values).some((v) => typeof v === 'number' && v < 0)
  const type: ChartType = negative && (declared === 'bar' || declared === 'hbar') ? 'diverging' : declared
  const labels = list(data.labels, 'labels', 1, LIMIT.labels).map((label, i) => str(label, `labels[${i}]`, 40))
  /* 偏离基准线可以为负，其余都从 0 起画 */
  const min = type === 'diverging' ? -Infinity : 0
  const series = list(data.series, 'series', 1, LIMIT.series).map((raw, i) => {
    const item = obj(raw, `series[${i}]`)
    const values = list(item.values, `series[${i}].values`, labels.length, labels.length).map((value, j) => num(value, `series[${i}].values[${j}]`, { min }))
    return { name: str(item.name ?? `系列 ${i + 1}`, `series[${i}].name`, 40), values }
  })
  if (type === 'dumbbell' && series.length !== 2) fail('dumbbell 需要恰好两组数据（之前 / 之后）')
  if (type === 'diverging' && series.length !== 1) fail('diverging 只支持一组数据')
  const max = data.max === undefined ? undefined : typeof data.max === 'number' && Number.isFinite(data.max) && data.max > 0 ? data.max : fail('max 应为正数')
  const peak = type === 'stacked' ? Math.max(...labels.map((_, j) => series.reduce((sum, s) => sum + s.values[j], 0))) : Math.max(...series.flatMap((s) => s.values.map(Math.abs)))
  if (max !== undefined && peak > max) fail('有数值超过 max')
  const stats = optList(data.stats, 'stats', LIMIT.stats)?.map((raw, i) => {
    const item = obj(raw, `stats[${i}]`)
    return { label: str(item.label, `stats[${i}].label`, 40), value: str(item.value, `stats[${i}].value`, 24), detail: optStr(item.detail, `stats[${i}].detail`, 60) }
  })
  return {
    kind: 'chart', type, labels, series, max, stats,
    title: str(data.title, 'title'),
    subtitle: optStr(data.subtitle, 'subtitle'),
    unit: optStr(data.unit, 'unit', 12),
    /* 数据必须写明出处：图表看起来越正式，越不能让来源缺席 */
    source: str(data.source, 'source（数据来源，必填）'),
    note: optStr(data.note, 'note', LIMIT.long),
    sources: sources(data.sources)
  }
}

const TRENDS: readonly Trend[] = ['up', 'down', 'flat']
function parseStats(data: Record<string, unknown>): StatsBlock {
  const items = list(data.items, 'items', 1, 6).map((raw, i) => {
    const item = obj(raw, `items[${i}]`)
    const trend = item.trend === undefined ? undefined : TRENDS.includes(item.trend as Trend) ? item.trend as Trend : fail(`items[${i}].trend 只能是 up / down / flat`)
    const good: 'up' | 'down' | undefined = item.good === undefined ? undefined : item.good === 'up' || item.good === 'down' ? item.good : fail(`items[${i}].good 只能是 up / down`)
    const spark = item.spark === undefined ? undefined : list(item.spark, `items[${i}].spark`, 2, 60).map((v, j) => num(v, `items[${i}].spark[${j}]`))
    let meter: StatsBlock['items'][number]['meter']
    if (item.meter !== undefined) {
      const m = obj(item.meter, `items[${i}].meter`)
      const maxValue = num(m.max, `items[${i}].meter.max`, { min: 0 })
      if (maxValue <= 0) fail(`items[${i}].meter.max 应为正数`)
      meter = { value: Math.min(num(m.value, `items[${i}].meter.value`, { min: 0 }), maxValue), max: maxValue }
    }
    return {
      label: str(item.label, `items[${i}].label`, 40), value: str(item.value, `items[${i}].value`, 24),
      delta: optStr(item.delta, `items[${i}].delta`, 24), trend, good,
      detail: optStr(item.detail, `items[${i}].detail`, 80), spark, meter
    }
  })
  return { kind: 'stats', title: optStr(data.title, 'title'), items, source: optStr(data.source, 'source'), sources: sources(data.sources) }
}

function parseCards(data: Record<string, unknown>): CardsBlock {
  const layout = data.layout === undefined || data.layout === 'list' ? 'list' : data.layout === 'grid' ? 'grid' : fail('layout 只能是 list 或 grid')
  const items = list(data.items, 'items', 1, LIMIT.items).map((raw, i) => {
    const item = obj(raw, `items[${i}]`)
    return {
      title: str(item.title, `items[${i}].title`, 80),
      icon: optStr(item.icon, `items[${i}].icon`, 32),
      badge: optStr(item.badge, `items[${i}].badge`, 24),
      recommended: item.recommended === true ? true : undefined,
      description: optStr(item.description, `items[${i}].description`, LIMIT.long),
      meta: optStr(item.meta, `items[${i}].meta`),
      links: links(item.links, `items[${i}].links`)
    }
  })
  if (items.filter((item) => item.recommended).length > 1) fail('最多一个 recommended')
  return { kind: 'cards', title: optStr(data.title, 'title'), layout, items, sources: sources(data.sources) }
}

function parseRecord(data: Record<string, unknown>): RecordBlock {
  const fields = list(data.fields, 'fields', 1, 16).map((raw, i) => {
    const field = obj(raw, `fields[${i}]`)
    return { label: str(field.label, `fields[${i}].label`, 40), value: str(field.value, `fields[${i}].value`, 300), icon: optStr(field.icon, `fields[${i}].icon`, 32) }
  })
  return {
    kind: 'record', title: str(data.title, 'title', 80), subtitle: optStr(data.subtitle, 'subtitle'), badge: optStr(data.badge, 'badge', 24),
    fields, links: links(data.links, 'links'), note: optStr(data.note, 'note', LIMIT.long)
  }
}

const TONES: readonly FlowTone[] = ['ok', 'warn', 'err', 'info']
function parseFlow(data: Record<string, unknown>): FlowBlock {
  const steps = list(data.steps, 'steps', 1, LIMIT.steps).map((raw, i) => {
    const step = obj(raw, `steps[${i}]`)
    return { title: str(step.title, `steps[${i}].title`, 60), detail: optStr(step.detail, `steps[${i}].detail`, 120), icon: optStr(step.icon, `steps[${i}].icon`, 32) }
  })
  const join = data.join === undefined || data.join === 'arrow' ? 'arrow' : data.join === 'plus' ? 'plus' : fail('join 只能是 plus 或 arrow')
  let result: FlowBlock['result']
  if (data.result !== undefined) {
    const raw = obj(data.result, 'result')
    const tone = raw.tone === undefined ? 'info' : TONES.includes(raw.tone as FlowTone) ? raw.tone as FlowTone : fail('result.tone 只能是 ok / warn / err / info')
    result = { tone, text: str(raw.text, 'result.text', 120) }
  }
  return { kind: 'flow', title: optStr(data.title, 'title'), join, steps, result, note: optStr(data.note, 'note', LIMIT.long), sources: sources(data.sources) }
}

function parseSteps(data: Record<string, unknown>): StepsBlock {
  const steps = list(data.steps, 'steps', 2, 10).map((raw, i) => {
    const step = obj(raw, `steps[${i}]`)
    return { title: str(step.title, `steps[${i}].title`, 60), body: str(step.body, `steps[${i}].body`, 800), icon: optStr(step.icon, `steps[${i}].icon`, 32) }
  })
  return { kind: 'steps', title: optStr(data.title, 'title'), loop: data.loop === true, steps }
}

export function parseVisualBlock(lang: VisualDataLang, text: string): VisualParse {
  let data: unknown
  try { data = JSON.parse(text) } catch { return { ok: false, error: 'JSON 不完整或格式有误' } }
  try {
    const root = obj(data, '整体')
    const block = lang === 'yan-chart' ? parseChart(root)
      : lang === 'yan-stats' ? parseStats(root)
      : lang === 'yan-cards' ? parseCards(root)
      : lang === 'yan-record' ? parseRecord(root)
      : lang === 'yan-flow' ? parseFlow(root)
      : parseSteps(root)
    return { ok: true, block }
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message }
    throw error
  }
}

/** 纵轴：取「好看」的上限（1/2/2.5/5 × 10ⁿ），刻度 4–5 格；百分比数据封顶 100。 */
export function niceScale(maxValue: number, unit?: string): { max: number; ticks: number[] } {
  if (unit === '%' && maxValue <= 100 && maxValue > 50) return { max: 100, ticks: [0, 25, 50, 75, 100] }
  const raw = maxValue > 0 ? maxValue : 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [0.2, 0.25, 0.5, 1, 2].map((f) => f * power).find((s) => raw / s <= 5) ?? 2 * power
  const max = Math.ceil(raw / step - 1e-9) * step
  const ticks: number[] = []
  for (let v = 0; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)))
  return { max, ticks }
}
