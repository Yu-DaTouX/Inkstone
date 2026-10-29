import type { CapabilityRunOptions } from './agent'
import { CapabilityCommandError } from './capability-server'
import { memoryStoreOf } from './personal-memory'
import { type AdapterRunner, runSearch, searchDoctor, searchSummary, type SearchPolicy } from './search/search'
import { runArxivSearch, runHackerNewsSearch, runWikipediaSearch } from './search/public-sources'
import { runBraveSearch } from './search/brave'
import { runTavilySearch } from './search/tavily'
import { firecrawlReadPage } from './search/firecrawl'
import { deepseekHasBalance, fundedDeepseekReadPage, resolveDeepseekSearchKey, runFundedDeepseekSearch } from './search/deepseek'
import { DocsError, queryDocs } from './search/context7'
import { runDdgSearch } from './search/ddg'
import { assertReadablePage, normalizeReadUrl, readPage, ReadPageError, type ReadPageResult } from './search/read-page'
import { resolveSearchKey, searchApiConfig } from './search/config'
import { defaultSearchPlan, mapLimit, searchModifiers, searchQueries, tooManyQueries, TtlCache, type SearchKeys } from './search/plan'
import { SEARCH_QUERIES_MAX, type SearchOutcome, type SearchQuery, type SearchSourceId } from '../shared/search'
import { isSafeSessionId } from './session-id'
import { commitKnowledge, listKnowledge, readKnowledge } from './project-memory-store'
import { isSafeKnowledgeId, isSafeRelativeRef } from '../shared/project-memory'
import { searchProjectKnowledge } from '../shared/project-memory-search'
import { paramNumber, paramString } from './command-params'
import { SourceCooldown } from './search/cooldown'
import { PageStore, pageRange, findInPage } from './search/page-store'

const THIN_PAGE_CHARS = 200
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const SEARCH_CACHE_MAX = 64

type ReadVia = 'local' | 'firecrawl' | 'deepseek'
type FetchedPage = { page: ReadPageResult; via: ReadVia; note?: string }

export interface LookupCommandsHost {
  capabilityOpts(): CapabilityRunOptions | undefined
  cwd(): string
  notifySearchApiMissing?(): void
}

export class LookupCommands {
  private searchApiHintSent = false
  private readonly searchCache = new TtlCache<SearchOutcome>(SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX)
  private readonly searchCooldown = new SourceCooldown()
  private readonly fetchCache = new TtlCache<FetchedPage>(SEARCH_CACHE_TTL_MS, 4)
  private readonly pages = new PageStore()
  private readonly pageRefs = new WeakMap<ReadPageResult, string>()

  constructor(private readonly host: LookupCommandsHost) {}

  searchString(params: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = params[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }

  searchNumber(params: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = params[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
    }
    return undefined
  }

  async runSearchCommand(action: string, params: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (action === 'doctor') {
      const status = await searchDoctor()
      return {
        data: {
          available: status.available,
          version: status.version,
          code: status.code ?? null,
          sources: status.sources
        },
        summary: {
          kind: 'search',
          action: 'doctor',
          available: status.available,
          version: status.version,
          code: status.code ?? null,
          sources: status.sources.map((s) => ({ id: s.id, ready: s.ready }))
        }
      }
    }
    if (action === 'fetch') {
      const url = this.searchString(params, ['url'])
      const pageRef = this.searchString(params, ['page-ref', 'pageRef'])
      if (!url && !pageRef) throw new CapabilityCommandError('search_url_required', 'search fetch 需要网址（--url）或页面快照（--page-ref）')
      const via = this.searchString(params, ['via'])
      if (via && via !== 'local' && via !== 'firecrawl' && via !== 'deepseek') {
        throw new CapabilityCommandError('search_bad_via', '--via 只能是 local、firecrawl 或 deepseek')
      }
      try {
        if (pageRef && (params.refresh === true || params.refresh === 'true')) throw new ReadPageError('bad_refresh', '页面快照固定不刷新；重新抓取时请只传 url，不传 pageRef')
        const read = {
          timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout'])
        }
        let snapshot
        let cached = true
        if (pageRef) snapshot = this.pages.get(pageRef)
        else {
          const cacheKey = JSON.stringify({ url: normalizeReadUrl(url!), timeoutMs: read.timeoutMs ?? null, via: via ?? null })
          const loaded = await this.fetchCache.getOrLoad(cacheKey, (requestSignal) => this.readWithFallback(url!, { ...read, signal: requestSignal }, via), { refresh: params.refresh === true || params.refresh === 'true', signal })
          cached = loaded.cached
          const { page, via: usedVia, note } = loaded.value
          const existing = this.pageRefs.get(page)
          try { snapshot = existing ? this.pages.get(existing) : undefined } catch { }
          if (!snapshot) { snapshot = this.pages.put(page, usedVia, note); this.pageRefs.set(page, snapshot.pageRef) }
        }
        const offset = this.searchNumber(params, ['offset']) ?? 0
        const maxChars = this.searchNumber(params, ['max-chars', 'maxChars']) ?? 12_000
        const mode = this.searchString(params, ['action']) ?? 'read'
        if (!['read', 'find', 'links'].includes(mode)) throw new ReadPageError('bad_action', '读页 action 只能是 read、find 或 links')
        const page = pageRange(snapshot, offset, maxChars)
        const find = this.searchString(params, ['find', 'query'])
        if (mode === 'find' && !find) throw new ReadPageError('bad_find', '页内查询需要 find 或 query')
        const data = mode === 'find' ? findInPage(snapshot, find!, offset) : mode === 'links'
          ? { pageRef: snapshot.pageRef, url: snapshot.url, finalUrl: snapshot.finalUrl, title: snapshot.title, fetchedAt: snapshot.fetchedAt, links: (snapshot.links ?? []).slice(offset, offset + 100), totalLinks: snapshot.links?.length ?? 0, ...(offset + 100 < (snapshot.links?.length ?? 0) ? { nextOffset: offset + 100 } : {}) }
          : page
        return {
          data: { ...data, action: mode, cached, cacheAgeMs: Math.max(0, Date.now() - Date.parse(snapshot.fetchedAt)) },
          summary: {
            kind: 'search',
            action: 'fetch',
            operation: mode,
            url: page.finalUrl,
            title: page.title,
            chars: page.text.length,
            totalChars: page.totalChars,
            truncated: page.truncated,
            via: snapshot.via,
            pageRef: snapshot.pageRef,
            fetchedAt: snapshot.fetchedAt,
            offset: page.offset,
            endOffset: page.endOffset,
            sourceTruncated: page.sourceTruncated,
            ...(snapshot.note ? { note: snapshot.note } : {}),
            cached
          }
        }
      } catch (e) {
        if (e instanceof ReadPageError) throw new CapabilityCommandError('search_fetch_' + e.code, e.message)
        throw e
      }
    }
    if (action === 'docs') {
      const query = this.searchString(params, ['query-text', 'queryText', 'query', 'text'])
      const library = this.searchString(params, ['library', 'lib'])
      const libraryId = this.searchString(params, ['library-id', 'libraryId'])
      if (!query) throw new CapabilityCommandError('search_query_required', 'search docs 需要要查的问题（--query-text）')
      if (!library && !libraryId) {
        throw new CapabilityCommandError('search_library_required', 'search docs 需要库名（--library react）或库 ID（--library-id /owner/repo）')
      }
      try {
        const docs = await queryDocs({
          ...(library ? { library } : {}),
          ...(libraryId ? { libraryId } : {}),
          query,
          maxChars: this.searchNumber(params, ['max-chars', 'maxChars']),
          timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout']),
          signal
        })
        return {
          data: docs,
          summary: {
            kind: 'search',
            action: 'docs',
            library: docs.library.id,
            title: docs.library.title,
            chars: docs.text.length,
            totalChars: docs.totalChars,
            truncated: docs.truncated,
            alternatives: docs.alternatives.map((item) => item.id)
          }
        }
      } catch (e) {
        if (e instanceof DocsError) {
          throw new CapabilityCommandError(
            'search_docs_' + e.code,
            e.message,
            e.candidates?.length ? { alternatives: e.candidates } : undefined
          )
        }
        throw e
      }
    }
    if (action !== 'query') {
      throw new CapabilityCommandError('search_unknown_action', `不认识的 search 动作：${action}`)
    }
    const queries = searchQueries(params)
    if (queries.length === 0) {
      throw new CapabilityCommandError('search_query_required', 'search query 需要查询词（--query-text）')
    }
    if (tooManyQueries(queries)) {
      throw new CapabilityCommandError('search_too_many_queries', `一次最多 ${SEARCH_QUERIES_MAX} 个查询，现在有 ${queries.length} 个`)
    }
    const parsedModifiers = searchModifiers(params)
    if (!parsedModifiers.ok) throw new CapabilityCommandError(parsedModifiers.code, parsedModifiers.message)
    const rawSources = params.sources
    const explicitSources: SearchSourceId[] = [
      ...(Array.isArray(rawSources) ? rawSources : typeof rawSources === 'string' ? rawSources.split(',') : [])
    ]
      .map((s) => String(s).trim())
      .filter((s): s is SearchSourceId => s.length > 0)

    let keys: SearchKeys | undefined
    if (explicitSources.length === 0) {
      const [tavily, brave, deepseek] = await Promise.all([resolveSearchKey('tavily'), resolveSearchKey('brave'), resolveDeepseekSearchKey()])
      keys = { tavily: !!tavily, brave: !!brave, deepseek: !!deepseek && (await deepseekHasBalance(deepseek)) }
      if (!tavily && !brave && !deepseek && !this.searchApiHintSent) {
        this.searchApiHintSent = true
        if (!(await searchApiConfig()).hintDismissed) this.host.notifySearchApiMissing?.()
      }
    }
    const shared = {
      ...parsedModifiers.modifiers,
      limitPerSource: this.searchNumber(params, ['limit-per-source', 'limitPerSource', 'limit']),
      limitTotal: this.searchNumber(params, ['limit-total', 'limitTotal']) ?? (explicitSources.length > 3 ? 24 : undefined),
      timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout'])
    }

    const results = await mapLimit(queries, 2, async (text) => {
      const plan: { sources: SearchSourceId[]; policy?: SearchPolicy } = keys ? defaultSearchPlan(text, keys, parsedModifiers.modifiers) : { sources: explicitSources }
      const input: SearchQuery = { text, sources: plan.sources, ...shared }
      const cacheKey = JSON.stringify({ input, policy: plan.policy ?? null })
      const { value: outcome, cached } = await this.searchCache.getOrLoad(
        cacheKey,
        (requestSignal) => runSearch(input, { runner: searchRunner(), now: () => Date.now(), cooldown: this.searchCooldown, signal: requestSignal }, plan.policy),
        { refresh: params.refresh === true || params.refresh === 'true', accept: (result) => !result.error && result.items.length > 0, signal }
      )
      return { outcome: { ...outcome, cached, cacheAgeMs: outcome.fetchedAt ? Math.max(0, Date.now() - Date.parse(outcome.fetchedAt)) : 0 }, cached }
    })

    if (results.length === 1) {
      const [{ outcome, cached }] = results
      const failure = searchFailure(outcome)
      if (failure) throw new CapabilityCommandError(failure.code, failure.message, searchSourcesData(outcome))
      return { data: outcome, summary: { kind: 'search', action: 'query', ...searchQuerySummary(outcome, cached) } }
    }

    const failures = results.map(({ outcome }) => searchFailure(outcome))
    if (failures.every(Boolean)) {
      throw new CapabilityCommandError(failures[0]!.code, `${results.length} 个查询都没取到结果：${failures[0]!.message}`, {
        queries: results.map(({ outcome }) => searchSourcesData(outcome))
      })
    }
    return {
      data: {
        queries: results.map(({ outcome }, i) =>
          failures[i] ? { ...searchSourcesData(outcome), items: [], error: failures[i] } : outcome
        )
      },
      summary: {
        kind: 'search',
        action: 'query',
        count: results.reduce((sum, { outcome }) => sum + outcome.items.length, 0),
        queries: results.map(({ outcome, cached }, i) =>
          failures[i] ? { query: outcome.query, count: 0, error: failures[i]!.code } : searchQuerySummary(outcome, cached)
        ),
        summary: results.map(({ outcome }, i) => `「${outcome.query}」${failures[i] ? failures[i]!.message : searchSummary(outcome)}`).join('\n')
      }
    }
  }

  private async readWithFallback(
    url: string,
    read: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal },
    via: string | undefined
  ): Promise<FetchedPage> {
    const timeoutMs = Math.min(60_000, Math.max(5_000, Math.round(read.timeoutMs ?? 30_000)))
    const deadline = Date.now() + timeoutMs
    const remaining = (): number => Math.max(0, deadline - Date.now())
    read.signal?.throwIfAborted()
    if (via === 'firecrawl') return { page: assertReadablePage(await firecrawlReadPage(url, { ...read, timeoutMs })), via: 'firecrawl' }
    if (via === 'deepseek') return { page: assertReadablePage(await fundedDeepseekReadPage(url, { ...read, timeoutMs })), via: 'deepseek' }
    let local: ReadPageResult | null = null
    let localError: ReadPageError | null = null
    try {
      local = await readPage(url, { ...read, snapshot: true, timeoutMs: Math.min(20_000, remaining()) })
      if (local.text.trim().length >= THIN_PAGE_CHARS || via === 'local') return { page: local, via: 'local' }
    } catch (e) {
      if (read.signal?.aborted || !(e instanceof ReadPageError) || e.code === 'bad_url' || e.code === 'private_host' || via === 'local') throw e
      localError = e
    }
    const [firecrawlKey, deepseekKey] = await Promise.all([resolveSearchKey('firecrawl'), resolveDeepseekSearchKey()])
    const remotes = [
      ...(firecrawlKey ? [{ via: 'firecrawl' as const, label: 'Firecrawl', read: firecrawlReadPage }] : []),
      ...(deepseekKey ? [{ via: 'deepseek' as const, label: 'DeepSeek', read: fundedDeepseekReadPage }] : [])
    ]
    const failures: string[] = []
    for (const remote of remotes) {
      read.signal?.throwIfAborted()
      if (remaining() < 5_000) {
        failures.push('正文读取总时限已到，未继续请求后备来源')
        break
      }
      try {
        const page = assertReadablePage(await remote.read(url, { ...read, maxChars: 40_000, timeoutMs: remaining() }))
        const why = local ? '本地读到的正文太短' : `本地读取失败（${localError?.message}）`
        return { page, via: remote.via, note: [why, ...failures, `已改用 ${remote.label}`].join('，') }
      } catch (e) {
        failures.push(`${remote.label} 兜底也失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (local) return { page: local, via: 'local', ...(failures.length ? { note: `正文很短，${failures.join('；')}` } : {}) }
    if (failures.length === 0) throw localError as ReadPageError
    throw new ReadPageError(localError?.code ?? 'network_error', `${localError?.message}；${failures.join('；')}`)
  }

  async runKnowledgeCommand(action: string, params: Record<string, unknown>) {
    const rawScope = paramString(params, ['scope'])
    if (rawScope && rawScope !== 'project' && rawScope !== 'personal' && !(action === 'search' && rawScope === 'all')) {
      throw new CapabilityCommandError('knowledge_bad_scope', 'scope 只能是 project、personal（search 另可用 all）')
    }
    const projectId = this.host.capabilityOpts()?.projectId
    const wantsProject = rawScope === 'project' || (!rawScope && action === 'propose')
    if (!projectId && wantsProject) {
      throw new CapabilityCommandError('knowledge_no_project', '当前会话没有绑定项目身份，项目知识不可用（个人记忆可用 --scope personal）')
    }
    const claimed = typeof params.projectId === 'string' ? params.projectId.trim() : ''
    if (claimed && projectId && claimed !== projectId) {
      throw new CapabilityCommandError(
        'knowledge_project_mismatch',
        '项目知识只认宿主绑定的身份，不接受请求里的 projectId'
      )
    }
    const projectStore = projectId ? memoryStoreOf('project', { projectId, cwd: this.host.cwd() }) : null
    const personalStore = memoryStoreOf('personal', null)!
    const storesFor = (scope: string): Array<{ scope: 'project' | 'personal'; store: NonNullable<typeof projectStore> }> => [
      ...(projectStore && scope !== 'personal' ? [{ scope: 'project' as const, store: projectStore }] : []),
      ...(scope !== 'project' ? [{ scope: 'personal' as const, store: personalStore }] : [])
    ]

    if (action === 'search') {
      const queryText = paramString(params, ['queryText', 'query-text', 'query', 'text'])
      if (!queryText) {
        throw new CapabilityCommandError('knowledge_query_required', 'knowledge search 需要 queryText（或 --query-file）')
      }
      const scoped = storesFor(rawScope || 'all')
      const lists = await Promise.all(scoped.map(({ store }) => listKnowledge(store.identity, store.opts)))
      const scopeOf = new Map<string, string>()
      lists.forEach((list, i) => list.forEach((entry) => scopeOf.set(entry.id, scoped[i].scope)))
      const result = searchProjectKnowledge(lists.flat(), {
        queryText,
        limit: paramNumber(params, 'limit'),
        tokenBudget: paramNumber(params, 'tokenBudget')
      })
      return {
        data: {
          hits: result.hits.map((hit) => ({ ...hit, scope: scopeOf.get(hit.id) })),
          considered: result.considered,
          dropped: result.dropped,
          tokens: result.tokens,
          reason: result.reason ?? null
        },
        summary: {
          kind: 'knowledge',
          action: 'search',
          projectId: projectId ?? null,
          scopes: scoped.map((item) => item.scope),
          count: result.hits.length,
          tokens: result.tokens,
          ids: result.hits.map((hit) => hit.id)
        }
      }
    }

    if (action === 'read') {
      const id = paramString(params, ['id'])
      if (!id || !isSafeKnowledgeId(id)) {
        throw new CapabilityCommandError('knowledge_id_required', 'knowledge read 需要合法的 id')
      }
      let entry: Awaited<ReturnType<typeof readKnowledge>>
      let foundIn: 'project' | 'personal' | undefined
      for (const { scope, store } of storesFor(rawScope || 'all')) {
        entry = await readKnowledge(store.identity, id, store.opts)
        if (entry) {
          foundIn = scope
          break
        }
      }
      if (!entry) {
        throw new CapabilityCommandError('knowledge_not_found', `找不到这条项目知识：${id}`)
      }
      return {
        data: { ...entry, scope: foundIn },
        summary: {
          kind: 'knowledge',
          action: 'read',
          scope: foundIn,
          id: entry.id,
          status: entry.status,
          revision: entry.revision
        }
      }
    }

    if (action === 'propose') {
      const raw = params.draft && typeof params.draft === 'object' ? (params.draft as Record<string, unknown>) : params
      const kind = paramString(raw, ['kind'])
      const text = paramString(raw, ['text'])
      if (!kind || !text) {
        throw new CapabilityCommandError('knowledge_draft_invalid', 'knowledge propose 需要 kind 与 text')
      }
      const evidence = Array.isArray(raw.evidence) ? raw.evidence : []
      for (const item of evidence) {
        const file = (item as { file?: unknown })?.file
        if (file !== undefined && !isSafeRelativeRef(file)) {
          throw new CapabilityCommandError(
            'knowledge_evidence_out_of_scope',
            '证据里的 file 只能是项目内相对路径（不接受绝对路径 / .. / 空值）'
          )
        }
      }
      const sessionId = typeof raw.sessionId === 'string' && isSafeSessionId(raw.sessionId) ? raw.sessionId : this.host.capabilityOpts()?.sessionId
      const target = rawScope === 'personal' ? personalStore : projectStore!
      const outcome = await commitKnowledge({
        identity: target.identity,
        opts: target.opts,
        request: {
          id: raw.id,
          kind,
          text,
          tags: raw.tags,
          evidence: evidence.length > 0 ? evidence : sessionId ? [{ sessionId }] : [],
          confidenceClass: raw.confidenceClass,
          validFor: raw.validFor,
          supersedes: raw.supersedes,
          expectedRevision: raw.expectedRevision ?? 0
        }
      })
      if (!outcome.ok) {
        throw new CapabilityCommandError(`knowledge_${outcome.code}`, outcome.message)
      }
      return {
        data: outcome.entry,
        summary: {
          kind: 'knowledge',
          action: 'propose',
          scope: rawScope === 'personal' ? 'personal' : 'project',
          id: outcome.entry.id,
          status: outcome.entry.status,
          revision: outcome.entry.revision
        }
      }
    }

    throw new CapabilityCommandError('unknown_command', `未知的 knowledge 动作：${action}`)
  }
}

function searchSourcesData(outcome: SearchOutcome) {
  return {
    query: outcome.query,
    sources: outcome.sources,
    ...(outcome.ignoredSources?.length ? { ignoredSources: outcome.ignoredSources } : {})
  }
}

function searchFailure(outcome: SearchOutcome): { code: string; message: string } | null {
  if (outcome.error) return outcome.error
  if (outcome.sources.some((s) => s.status === 'ok' || s.status === 'empty')) return null
  const unavailable = outcome.sources.find((s) => s.status === 'unavailable')
  if (unavailable) {
    return { code: 'search_backend_unavailable', message: unavailable.message ?? '搜索来源不可用（可用 yan search doctor 看详情）' }
  }
  const timedOut = outcome.sources.find((s) => s.status === 'timeout')
  if (timedOut) return { code: 'search_timeout', message: timedOut.message ?? '搜索超时（可以调大 --timeout-ms 或换来源）' }
  return { code: 'search_failed', message: '所有搜索来源都出错了（逐来源状态见 data.sources）' }
}

function searchQuerySummary(outcome: SearchOutcome, cached: boolean) {
  return {
    query: outcome.query,
    count: outcome.items.length,
    truncated: outcome.truncated,
    durationMs: outcome.durationMs,
    ...(cached ? { cached: true } : {}),
    sources: outcome.sources.map((s) => ({
      id: s.source,
      status: s.status,
      count: s.count,
      ...(s.droppedByLimit ? { droppedByLimit: s.droppedByLimit } : {}),
      ...(s.code ? { code: s.code } : {})
    })),
    ...(outcome.ignoredSources?.length ? { ignoredSources: outcome.ignoredSources } : {}),
    summary: (cached ? '（10 分钟内查过，直接复用）' : '') + searchSummary(outcome)
  }
}

let cachedSearchRunner: AdapterRunner | null = null

function searchRunner(): AdapterRunner {
  if (cachedSearchRunner) return cachedSearchRunner
  cachedSearchRunner = (source, query, opts) => {
    switch (source.id) {
      case 'brave': return runBraveSearch(query, opts)
      case 'tavily': return runTavilySearch(query, opts)
      case 'deepseek': return runFundedDeepseekSearch(query, opts)
      case 'ddg': return runDdgSearch(query, opts)
      case 'wikipedia': return runWikipediaSearch(query, opts)
      case 'arxiv': return runArxivSearch(query, opts)
      case 'hackernews': return runHackerNewsSearch(query, opts)
    }
  }
  return cachedSearchRunner
}
