import type { CapabilityRunOptions } from './agent'
import { CapabilityCommandError } from './capability-server'
import { memoryStoreOf } from './personal-memory'
import { createOpencliRunner, type AdapterRunner, runSearch, searchDoctor, searchSummary } from './search/opencli'
import { runBraveSearch } from './search/brave'
import { runTavilySearch } from './search/tavily'
import { firecrawlReadPage } from './search/firecrawl'
import { DocsError, queryDocs } from './search/context7'
import { detectLocale, runBingSearch } from './search/bing'
import { runDdgSearch } from './search/ddg'
import { readPage, ReadPageError } from './search/read-page'
import { runSo360Search } from './search/so360'
import { resolveSearchKey, searchApiConfig } from './search/config'
import { DEFAULT_SEARCH_SOURCES, type SearchSourceId } from '../shared/search'
import { isSafeSessionId } from './session-id'
import { commitKnowledge, listKnowledge, readKnowledge } from './project-memory-store'
import { isSafeKnowledgeId, isSafeRelativeRef } from '../shared/project-memory'
import { searchProjectKnowledge } from '../shared/project-memory-search'
import { paramNumber, paramString } from './command-params'

const THIN_PAGE_CHARS = 200

export interface LookupCommandsHost {
  capabilityOpts(): CapabilityRunOptions | undefined
  cwd(): string
  notifySearchApiMissing?(): void
}

export class LookupCommands {
  private searchApiHintSent = false

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

  async runSearchCommand(action: string, params: Record<string, unknown>) {
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
      if (!url) throw new CapabilityCommandError('search_url_required', 'search fetch 需要网址（--url）')
      const via = this.searchString(params, ['via'])
      if (via && via !== 'local' && via !== 'firecrawl') {
        throw new CapabilityCommandError('search_bad_via', '--via 只能是 local 或 firecrawl')
      }
      try {
        const read = {
          maxChars: this.searchNumber(params, ['max-chars', 'maxChars']),
          timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout'])
        }
        const { page, via: usedVia, note } = await this.readWithFallback(url, read, via)
        return {
          data: { ...page, via: usedVia, ...(note ? { note } : {}) },
          summary: {
            kind: 'search',
            action: 'fetch',
            url: page.finalUrl,
            title: page.title,
            chars: page.text.length,
            totalChars: page.totalChars,
            truncated: page.truncated,
            via: usedVia,
            ...(note ? { note } : {})
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
          timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout'])
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
    const text = this.searchString(params, ['query-text', 'queryText', 'query', 'text'])
    if (!text) {
      throw new CapabilityCommandError('search_query_required', 'search query 需要查询词（--query-text）')
    }
    const rawSources = params.sources
    const sources: SearchSourceId[] = [
      ...(Array.isArray(rawSources) ? rawSources : typeof rawSources === 'string' ? rawSources.split(',') : [])
    ]
      .map((s) => String(s).trim())
      .filter((s): s is SearchSourceId => s.length > 0)

    if (sources.length === 0) {
      const [hasTavily, hasBrave] = await Promise.all([resolveSearchKey('tavily'), resolveSearchKey('brave')])
      const hasKey = !!(hasTavily || hasBrave)
      const web: SearchSourceId[] = detectLocale(text) === 'zh' ? ['bing', 'so360'] : ['ddg', 'bing']
      sources.push(
        ...(hasTavily ? (['tavily'] as SearchSourceId[]) : []),
        ...(hasBrave ? (['brave'] as SearchSourceId[]) : []),
        ...web,
        ...DEFAULT_SEARCH_SOURCES
      )
      if (!hasKey && !this.searchApiHintSent) {
        this.searchApiHintSent = true
        if (!(await searchApiConfig()).hintDismissed) this.host.notifySearchApiMissing?.()
      }
    }

    const outcome = await runSearch(
      {
        text,
        ...(sources.length ? { sources } : {}),
        limitPerSource: this.searchNumber(params, ['limit-per-source', 'limitPerSource', 'limit']),
        limitTotal: this.searchNumber(params, ['limit-total', 'limitTotal']) ?? (sources.length > 3 ? 24 : undefined),
        timeoutMs: this.searchNumber(params, ['timeout-ms', 'timeoutMs', 'timeout'])
      },
      { runner: searchRunner(), now: () => Date.now() }
    )

    const sourcesData = {
      query: outcome.query,
      sources: outcome.sources,
      ...(outcome.ignoredSources?.length ? { ignoredSources: outcome.ignoredSources } : {})
    }
    if (outcome.error) {
      throw new CapabilityCommandError(outcome.error.code, outcome.error.message, sourcesData)
    }
    const reached = outcome.sources.filter((s) => s.status === 'ok' || s.status === 'empty')
    if (reached.length === 0) {
      const unavailable = outcome.sources.find((s) => s.status === 'unavailable')
      const timedOut = outcome.sources.find((s) => s.status === 'timeout')
      if (unavailable) {
        throw new CapabilityCommandError(
          'search_backend_unavailable',
          unavailable.message ?? '搜索后端不可用（需要安装 OpenCLI，可用 yan search doctor 看详情）',
          sourcesData
        )
      }
      if (timedOut) {
        throw new CapabilityCommandError(
          'search_timeout',
          timedOut.message ?? '搜索超时（可以调大 --timeout-ms 或换来源）',
          sourcesData
        )
      }
      throw new CapabilityCommandError('search_failed', '所有搜索来源都出错了（逐来源状态见 data.sources）', sourcesData)
    }

    return {
      data: outcome,
      summary: {
        kind: 'search',
        action: 'query',
        query: outcome.query,
        count: outcome.items.length,
        truncated: outcome.truncated,
        durationMs: outcome.durationMs,
        sources: outcome.sources.map((s) => ({
          id: s.source,
          status: s.status,
          count: s.count,
          ...(s.droppedByLimit ? { droppedByLimit: s.droppedByLimit } : {}),
          ...(s.code ? { code: s.code } : {})
        })),
        ...(outcome.ignoredSources?.length ? { ignoredSources: outcome.ignoredSources } : {}),
        summary: searchSummary(outcome)
      }
    }
  }

  private async readWithFallback(
    url: string,
    read: { maxChars?: number; timeoutMs?: number },
    via: string | undefined
  ): Promise<{ page: Awaited<ReturnType<typeof readPage>>; via: 'local' | 'firecrawl'; note?: string }> {
    if (via === 'firecrawl') return { page: await firecrawlReadPage(url, read), via: 'firecrawl' }
    let local: Awaited<ReturnType<typeof readPage>> | null = null
    let localError: ReadPageError | null = null
    try {
      local = await readPage(url, read)
      if (local.text.trim().length >= THIN_PAGE_CHARS || via === 'local') return { page: local, via: 'local' }
    } catch (e) {
      if (!(e instanceof ReadPageError) || e.code === 'bad_url' || e.code === 'private_host' || via === 'local') throw e
      localError = e
    }
    if (!(await resolveSearchKey('firecrawl'))) {
      if (local) return { page: local, via: 'local' }
      throw localError as ReadPageError
    }
    try {
      const page = await firecrawlReadPage(url, read)
      return { page, via: 'firecrawl', note: local ? '本地读到的正文太短，已改用 Firecrawl' : `本地读取失败（${localError?.message}），已改用 Firecrawl` }
    } catch (e) {
      if (local) return { page: local, via: 'local', note: `正文很短，Firecrawl 兜底也失败：${e instanceof Error ? e.message : String(e)}` }
      const reason = e instanceof Error ? e.message : String(e)
      throw new ReadPageError(localError?.code ?? 'network_error', `${localError?.message}；Firecrawl 兜底也失败：${reason}`)
    }
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

function searchRunner(): AdapterRunner {
  const opencli = createOpencliRunner()
  return (source, query, opts) => {
    switch (source.id) {
      case 'brave': return runBraveSearch(query, opts)
      case 'tavily': return runTavilySearch(query, opts)
      case 'bing': return runBingSearch(query, opts)
      case 'ddg': return runDdgSearch(query, opts)
      case 'so360': return runSo360Search(query, opts)
      default: return opencli(source, query, opts)
    }
  }
}
