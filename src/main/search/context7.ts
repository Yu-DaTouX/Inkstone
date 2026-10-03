/**
 * Context7 开发文档查询：`yan search docs`。给库名（或已知的库 ID）和问题，
 * 返回该库**最新版本**的文档片段与示例。key 可选：不填也能用，只是限额低。
 *
 * 流程：库名 → `/v2/libs/search` 取候选 → 取排第一的（或调用方指定的 id）→
 * `/v2/context` 取片段。`/context` 直接回 markdown 文本；库改名时回 301 +
 * `redirectUrl`，跟一次。
 */
import { callApi, parseJson, type ApiResult } from './api-call'
import { resolveSearchKey } from './config'

const BASE = 'https://context7.com/api/v2'
export const DOCS_MAX_CHARS_DEFAULT = 12_000
export const DOCS_MAX_CHARS_MAX = 40_000

export class DocsError extends Error {
  constructor(readonly code: string, message: string, readonly candidates?: DocsLibrary[]) {
    super(message)
  }
}

export interface DocsLibrary {
  id: string
  title: string
  description?: string
  snippets?: number
}

export interface DocsResult {
  library: DocsLibrary
  /** 同名的其他候选（库名有歧义时给模型挑），最多 4 个 */
  alternatives: DocsLibrary[]
  text: string
  truncated: boolean
  totalChars: number
}

interface LibsBody {
  results?: Array<Record<string, unknown>>
}
interface ErrBody {
  error?: string
  message?: string
  redirectUrl?: string
}

function headers(key: string | undefined): Record<string, string> {
  return { Accept: 'application/json, text/plain', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

function failure(res: Extract<ApiResult, { ok: false }>): DocsError {
  const detail = parseJson<ErrBody>(res.body ?? '')
  if (res.status === 404) return new DocsError('library_not_found', detail?.message ?? '找不到这个库')
  return new DocsError(res.code, detail?.message ? `${res.message}：${detail.message}` : res.message)
}

const libOf = (r: Record<string, unknown>): DocsLibrary | null =>
  typeof r.id === 'string' && r.id
    ? {
        id: r.id,
        title: typeof r.title === 'string' ? r.title : r.id,
        ...(typeof r.description === 'string' ? { description: r.description.slice(0, 160) } : {}),
        ...(typeof r.totalSnippets === 'number' ? { snippets: r.totalSnippets } : {})
      }
    : null

export async function queryDocs(
  input: { library?: string; libraryId?: string; query: string; maxChars?: number; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch
): Promise<DocsResult> {
  const key = await resolveSearchKey('context7')
  const timeoutMs = Math.min(60_000, Math.max(3_000, Math.round(input.timeoutMs ?? 30_000)))
  const maxChars = Math.min(DOCS_MAX_CHARS_MAX, Math.max(500, Math.round(input.maxChars ?? DOCS_MAX_CHARS_DEFAULT)))

  let library: DocsLibrary | null = null
  let alternatives: DocsLibrary[] = []
  if (input.libraryId) {
    library = { id: input.libraryId, title: input.libraryId }
  } else {
    const url = new URL(`${BASE}/libs/search`)
    url.searchParams.set('libraryName', input.library ?? '')
    url.searchParams.set('query', input.query)
    const res = await callApi('Context7', url, { headers: headers(key) }, timeoutMs, fetchImpl)
    if (!res.ok) throw failure(res)
    const body = parseJson<LibsBody>(res.text)
    const found = (body?.results ?? []).map(libOf).filter((l): l is DocsLibrary => !!l)
    if (!found.length) throw new DocsError('library_not_found', `Context7 里没有找到「${input.library}」`)
    library = found[0]
    alternatives = found.slice(1, 5)
  }

  let libraryId = library.id
  for (let hop = 0; hop < 2; hop++) {
    const url = new URL(`${BASE}/context`)
    url.searchParams.set('libraryId', libraryId)
    url.searchParams.set('query', input.query)
    const res = await callApi('Context7', url, { headers: headers(key) }, timeoutMs, fetchImpl, [301])
    if (!res.ok) throw failure(res)
    if (res.status === 301) {
      const redirect = parseJson<ErrBody>(res.text)?.redirectUrl
      if (!redirect || hop === 1) throw new DocsError('http_error', 'Context7 库重定向失败')
      libraryId = redirect
      library = { ...library, id: redirect }
      continue
    }
    const text = res.text.trim()
    if (!text) throw new DocsError('empty', `${library.title} 里没有找到相关文档（换个说法或指定 --library-id）`, alternatives)
    return {
      library,
      alternatives,
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
      totalChars: text.length
    }
  }
  throw new DocsError('http_error', 'Context7 没有返回文档')
}
