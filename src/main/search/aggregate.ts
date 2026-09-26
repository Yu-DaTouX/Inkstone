/**
 * 搜索结果归一化与合并（实施-27 S1）。
 *
 * 这一层是**纯函数**：输入是「每个来源的原始输出」，输出是统一的 SearchItem
 * 列表与来源级状态。没有子进程、没有 Electron —— 所以单测可以直接喂假数据，
 * 不需要装 OpenCLI。
 *
 * 三条必须守住的口径：
 *   ① **N 个来源 → N 条状态**：哪怕某个来源什么都没返回，也要有条状态；
 *   ② `empty`（查到了但没有结果）与 `unavailable` / `timeout` / `error`
 *      （根本没查成）严格分开 —— 把失败写成「没有」是最要命的失真；
 *   ③ 归一化失败**不算来源失败**：单条脏数据丢弃并计数，来源仍按 ok 上报。
 */
import {
  SEARCH_SNIPPET_MAX,
  type PerSourceStatus,
  type SearchItem,
  type SearchSourceId,
  type SourceStatusKind
} from '../../shared/search'

/** 一个来源跑完后的原始结果（由 opencli.ts 产出） */
export interface SourceRun {
  source: SearchSourceId
  /** 解析成功的行；解析失败 / 没取到时是 null */
  rows: unknown[] | null
  /** 没取到时的后端错误（与 rows 互斥，但都为空也算 empty） */
  error?: { code?: string; message?: string }
  timedOut?: boolean
  /** 拿不到可执行文件 / 不在白名单 */
  unavailable?: boolean
  elapsedMs: number
}

export interface AggregateOptions {
  /** 每个来源最多保留几条（从原始输出里截前 N） */
  limitPerSource: number
  /** 合并去重后总数上限 */
  limitTotal: number
}

export interface AggregateResult {
  items: SearchItem[]
  sources: PerSourceStatus[]
  truncated: boolean
}

/** 常见 HTML 实体 —— 搜索结果里标题/摘要会带转义（wikipedia 的 &quot; 等） */
const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n)
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&(?:quot|amp|lt|gt|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

/** 压平空白并截断到上限（超长只标一个 …，不悄悄留半句） */
export function cleanText(input: unknown, max = SEARCH_SNIPPET_MAX): string | undefined {
  if (typeof input !== 'string') return undefined
  const t = decodeEntities(input).replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/**
 * URL 规范化 —— 只用来判重，不改写用户看到的链接。
 *
 * 去掉 hash、常见跟踪参数（utm_*、fbclid、ref）、末尾斜杠；
 * host 小写。保留协议与路径大小写（路径大小写敏感的站点不少）。
 */
export function normalizeUrlForDedupe(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw.trim()
  }
  u.hash = ''
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|ref|ref_src|source)$/i.test(key)) u.searchParams.delete(key)
  }
  u.host = u.host.toLowerCase()
  const qs = u.searchParams.toString()
  const path = u.pathname.replace(/\/+$/, '') || '/'
  return `${u.protocol}//${u.host}${path}${qs ? '?' + qs : ''}`
}

/** Hacker News 的行没有链接，用 id 拼；拼不出来这一条就丢 */
function hackerNewsUrl(id: unknown): string | null {
  const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN
  return Number.isFinite(n) && n > 0 ? `https://news.ycombinator.com/item?id=${n}` : null
}

/** 各来源的字段映射。行结构对不上就返回 null（丢一条，不算来源失败） */
export function normalizeRow(source: SearchSourceId, row: unknown): SearchItem | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const title = cleanText(r.title, 200)
  if (!title) return null

  if (source === 'hackernews') {
    const url = hackerNewsUrl(r.id)
    if (!url) return null
    const meta: Record<string, string | number> = {}
    if (typeof r.score === 'number') meta.score = r.score
    if (typeof r.comments === 'number') meta.comments = r.comments
    if (typeof r.author === 'string' && r.author) meta.author = r.author
    const item: SearchItem = { title, url, source }
    if (Object.keys(meta).length) item.meta = meta
    return item
  }

  const url = cleanText(r.url, 500)
  if (!url) return null
  const item: SearchItem = { title, url, source }
  const snippet = cleanText(r.snippet)
  if (snippet) item.snippet = snippet
  const published = cleanText(r.published, 40)
  if (published) item.published = published
  const meta: Record<string, string | number> = {}
  if (typeof r.authors === 'string' && r.authors) meta.authors = cleanText(r.authors, 160) ?? r.authors
  if (typeof r.primary_category === 'string' && r.primary_category) meta.category = r.primary_category
  if (Object.keys(meta).length) item.meta = meta
  return item
}

function statusOf(run: SourceRun): { status: SourceStatusKind; code?: string; message?: string } {
  if (run.unavailable) return { status: 'unavailable', code: run.error?.code ?? 'backend_unavailable', message: run.error?.message }
  if (run.timedOut) return { status: 'timeout', code: run.error?.code ?? 'timeout', message: run.error?.message }
  if (run.error) return { status: 'error', code: run.error.code ?? 'error', message: run.error.message }
  if (!run.rows || run.rows.length === 0) return { status: 'empty' }
  return { status: 'ok' }
}

/**
 * 合并：按**来源顺序**（= 注册顺序）拼接，来源内部保持后端给的顺序；
 * 跨来源按规范化 URL 去重（先到先得）；最后按总数上限截断。
 */
export function aggregate(runs: SourceRun[], opts: AggregateOptions): AggregateResult {
  const items: SearchItem[] = []
  const sources: PerSourceStatus[] = []
  const seen = new Set<string>()
  let truncated = false

  for (const run of runs) {
    const { status, code, message } = statusOf(run)
    let kept = 0
    let badRows = 0

    if (status === 'ok') {
      const rows = run.rows ?? []
      if (rows.length > opts.limitPerSource) truncated = true
      for (const row of rows.slice(0, opts.limitPerSource)) {
        const item = normalizeRow(run.source, row)
        if (!item) {
          badRows++
          continue
        }
        const key = normalizeUrlForDedupe(item.url)
        if (seen.has(key)) continue
        if (items.length >= opts.limitTotal) {
          truncated = true
          break
        }
        seen.add(key)
        items.push(item)
        kept++
      }
    }

    const entry: PerSourceStatus = {
      source: run.source,
      status,
      count: kept,
      elapsedMs: Math.max(0, Math.round(run.elapsedMs))
    }
    if (code) entry.code = code
    if (message) entry.message = message
    if (badRows > 0) entry.message = (entry.message ? entry.message + '；' : '') + `${badRows} 条结果结构不认识，已跳过`
    sources.push(entry)
  }

  return { items, sources, truncated }
}

/** 组合给模型/CLI 看的一句话：先说要紧的，不漏来源 */
export function summarizeSources(sources: PerSourceStatus[]): string {
  const label = (s: PerSourceStatus): string => {
    if (s.status === 'ok') return `${s.source} ${s.count} 条`
    if (s.status === 'empty') return `${s.source} 无结果`
    if (s.status === 'timeout') return `${s.source} 超时`
    if (s.status === 'unavailable') return `${s.source} 不可用`
    return `${s.source} 出错${s.code ? `（${s.code}）` : ''}`
  }
  return sources.map(label).join(' · ')
}
