import {
  DEFAULT_SEARCH_SOURCES,
  SEARCH_LIMIT_PER_SOURCE_DEFAULT,
  SEARCH_LIMIT_PER_SOURCE_MAX,
  SEARCH_LIMIT_TOTAL_DEFAULT,
  SEARCH_LIMIT_TOTAL_MAX,
  SEARCH_QUERY_MAX,
  SEARCH_SOURCES,
  SEARCH_TIMEOUT_MS_DEFAULT,
  SEARCH_TIMEOUT_MS_MAX,
  type SearchItem,
  type SearchOutcome,
  type SearchQuery,
  type SearchSource,
  type SearchSourceId,
  type SearchBackendStatus
} from '../../shared/search'
import { aggregate, summarizeSources, type SourceRun } from './aggregate'
import type { SourceCooldown } from './cooldown'
import type { SourceRequest } from './modifiers'

export type AdapterRunner = (source: SearchSource, query: string, opts: SourceRequest) => Promise<SourceRun>

export interface SearchDeps {
  runner: AdapterRunner
  now: () => number
  cooldown?: SourceCooldown
}

export interface SearchPolicy {
  primary: readonly SearchSourceId[]
  reserve: readonly SearchSourceId[]
  enoughRows: number
  graceMs: number
}

const byId = new Map<string, SearchSource>(SEARCH_SOURCES.map((s) => [s.id, s]))

export function findSource(id: string): SearchSource | undefined {
  return byId.get(id)
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function normalizeQuery(input: SearchQuery):
  | {
      ok: true
      text: string
      sources: SearchSource[]
      ignoredSources: string[]
      limitPerSource: number
      limitTotal: number
      timeoutMs: number
    }
  | { ok: false; code: string; message: string; ignoredSources: string[] } {
  const text = (input.text ?? '').trim()
  const wanted = input.sources && input.sources.length > 0 ? input.sources : [...DEFAULT_SEARCH_SOURCES]
  const sources: SearchSource[] = []
  const ignoredSources: string[] = []
  for (const id of wanted) {
    const s = byId.get(id as SearchSourceId)
    if (!s) {
      const name = String(id)
      if (!ignoredSources.includes(name)) ignoredSources.push(name)
      continue
    }
    if (!sources.includes(s)) sources.push(s)
  }
  if (!text) return { ok: false, code: 'empty_query', message: '查询词是空的', ignoredSources }
  if (text.length > SEARCH_QUERY_MAX) {
    return { ok: false, code: 'query_too_long', message: `查询词太长（上限 ${SEARCH_QUERY_MAX} 字）`, ignoredSources }
  }
  if (sources.length === 0) return { ok: false, code: 'no_source', message: '没有可用的搜索来源', ignoredSources }
  return {
    ok: true,
    text,
    sources,
    ignoredSources,
    limitPerSource: clamp(input.limitPerSource, 1, SEARCH_LIMIT_PER_SOURCE_MAX, SEARCH_LIMIT_PER_SOURCE_DEFAULT),
    limitTotal: clamp(input.limitTotal, 1, SEARCH_LIMIT_TOTAL_MAX, SEARCH_LIMIT_TOTAL_DEFAULT),
    timeoutMs: clamp(input.timeoutMs, 1000, SEARCH_TIMEOUT_MS_MAX, SEARCH_TIMEOUT_MS_DEFAULT)
  }
}

export async function runSearch(input: SearchQuery, deps: SearchDeps, policy?: SearchPolicy): Promise<SearchOutcome> {
  const started = deps.now()
  const parsed = normalizeQuery(input)
  if (!parsed.ok) {
    return {
      query: (input.text ?? '').trim(),
      items: [],
      sources: [],
      truncated: false,
      durationMs: deps.now() - started,
      error: { code: parsed.code, message: parsed.message },
      ...(parsed.ignoredSources.length ? { ignoredSources: parsed.ignoredSources } : {})
    }
  }

  const CONCURRENCY = 3
  const runs: SourceRun[] = []
  const queue = [...parsed.sources]
  const reserveAll = (policy?.reserve ?? [])
    .map((id) => byId.get(id))
    .filter((s, i, list): s is SearchSource => !!s && !parsed.sources.includes(s) && list.indexOf(s) === i)
  const reserve = [...reserveAll]
  const primary = new Set<SearchSourceId>(policy?.primary ?? [])
  const stop = new AbortController()
  let pendingPrimary = parsed.sources.filter((s) => primary.has(s.id)).length
  let pendingAll = parsed.sources.length
  const cooldown = policy ? deps.cooldown : undefined
  const allCooling = !!cooldown && [...parsed.sources, ...reserveAll].every((s) => cooldown.check(s.id, deps.now()))
  const aggregateOptions = {
    limitPerSource: parsed.limitPerSource,
    limitTotal: parsed.limitTotal,
    ...(input.sites?.length ? { sites: input.sites } : {}),
    ...(input.recent ? { recent: input.recent } : {})
  }
  let grace: NodeJS.Timeout | undefined
  const modifiers = {
    ...(input.recent ? { recent: input.recent } : {}),
    ...(input.sites?.length ? { sites: input.sites } : {}),
    ...(input.question ? { question: input.question } : {}),
    ...(input.withContent ? { withContent: true } : {})
  }

  const settle = (run: SourceRun): void => {
    pendingAll--
    if (cooldown && !allCooling) cooldown.record(run, deps.now())
    if (!policy) return
    if (primary.has(run.source)) pendingPrimary--
    if (pendingPrimary > 0 || stop.signal.aborted) return
    const primaryRows = aggregate(runs.filter((result) => primary.has(result.source)), aggregateOptions).items.length
    if (primaryRows >= policy.enoughRows) {
      if (!grace) grace = setTimeout(() => stop.abort(), policy.graceMs)
      return
    }
    const next = reserve[0]
    if (!next) return
    reserve.shift()
    primary.add(next.id)
    pendingPrimary++
    pendingAll++
    queue.unshift(next)
  }

  const runOne = async (source: SearchSource): Promise<void> => {
    const begun = deps.now()
    const cooling = cooldown && !allCooling ? cooldown.check(source.id, begun) : null
    if (cooling) {
      const run = cooldown!.skippedRun(source.id, cooling, begun)
      runs.push(run)
      settle(run)
      return
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<SourceRun>((resolve) => {
      onAbort = () => resolve({ source: source.id, rows: null, skipped: true, elapsedMs: deps.now() - begun })
      if (stop.signal.aborted) onAbort()
      else stop.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const run = stop.signal.aborted
        ? await aborted
        : await Promise.race([
            deps.runner(source, parsed.text, { limit: parsed.limitPerSource, timeoutMs: parsed.timeoutMs, signal: stop.signal, ...modifiers }),
            aborted
          ])
      runs.push(run)
      settle(run)
    } finally {
      if (onAbort) stop.signal.removeEventListener('abort', onAbort)
    }
  }

  const inflight = new Set<Promise<void>>()
  const pump = (): void => {
    while (inflight.size < CONCURRENCY && queue.length) {
      const task: Promise<void> = runOne(queue.shift()!).finally(() => inflight.delete(task))
      inflight.add(task)
    }
  }
  pump()
  while (inflight.size) {
    await Promise.race(inflight)
    pump()
  }
  if (grace) clearTimeout(grace)
  stop.abort()

  const order = new Map([...parsed.sources, ...reserveAll].map((s, i) => [s.id, i]))
  runs.sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0))

  const merged = aggregate(runs, aggregateOptions)
  return {
    query: parsed.text,
    items: merged.items,
    sources: merged.sources,
    truncated: merged.truncated,
    durationMs: deps.now() - started,
    ...(parsed.ignoredSources.length ? { ignoredSources: parsed.ignoredSources } : {})
  }
}

export function searchDoctor(): SearchBackendStatus {
  return {
    available: true,
    version: null,
    detail: '搜索来源都内置在砚里，无需安装外部后端',
    sources: SEARCH_SOURCES.filter((s) => !s.direct).map((s) => ({ id: s.id, label: s.label, needsBrowser: s.needsBrowser, ready: true }))
  }
}

export function searchSummary(outcome: SearchOutcome): string {
  const parts = [`${outcome.items.length} 条结果`, summarizeSources(outcome.sources)]
  if (outcome.truncated) parts.push('已截断')
  if (outcome.ignoredSources?.length) parts.push(`已忽略未知来源：${outcome.ignoredSources.join('、')}`)
  return parts.join(' · ')
}

export type { SearchItem, SourceRun }

export { SEARCH_SOURCES, SEARCH_LIMIT_PER_SOURCE_MAX } from '../../shared/search'
export {
  aggregate,
  normalizeRow,
  normalizeUrlForDedupe,
  decodeEntities,
  cleanText,
  summarizeSources
} from './aggregate'
