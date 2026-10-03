import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 增强搜索服务（Tavily / Firecrawl / Context7）与 key 配置的单测。
 * 全部用替身 fetch，不联网、不花额度；数据目录由调用方指向临时目录。
 */

/** 一个只记录请求、按脚本回复的 fetch 替身 */
function fakeFetch(replies) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null })
    const next = replies.shift()
    if (!next) throw new Error('没有更多替身回复')
    if (next.throws) throw next.throws
    return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.body ?? '' }
  }
  return { impl, calls }
}
const json = (status, value) => ({ status, body: JSON.stringify(value) })

export async function runSearchProviderTests(ok, mod, dataDir) {
  const { config, tavily, firecrawl, context7, shared } = mod

  /* ---- key 配置：按服务存取，环境变量兜底，提醒只看通用搜索 ---- */
  {
    for (const name of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'FIRECRAWL_API_KEY', 'CONTEXT7_API_KEY']) delete process.env[name]
    let view = await config.searchApiConfig()
    ok(!view.configured && Object.values(view.providers).every((p) => !p.configured), '什么都没配 → 全部未配置')

    ok((await config.setSearchKey('tavily', ' tvly-abc ')).ok, '存 Tavily key（去掉首尾空白）')
    ok((await config.resolveSearchKey('tavily')) === 'tvly-abc', '读回的 key 是去过空白的')
    ok((await config.setSearchKey('firecrawl', 'a b')).ok === false, 'key 里有空白 → 拒绝')
    ok((await config.setSearchKey('firecrawl', '   ')).ok === false, '空 key → 拒绝')
    view = await config.searchApiConfig()
    ok(view.providers.tavily.source === 'file' && view.configured, 'Tavily 已配置且来源是文件，通用搜索视为已配置')

    await config.clearSearchKey('tavily')
    await config.setSearchKey('firecrawl', 'fc-1')
    await config.setSearchKey('context7', 'ctx7sk-1')
    view = await config.searchApiConfig()
    ok(!view.configured, '只配 Firecrawl / Context7 不算通用搜索已配置（提醒仍应出现）')
    ok(view.providers.firecrawl.configured && view.providers.context7.configured && !view.providers.tavily.configured, '各服务状态互不串')

    process.env.BRAVE_API_KEY = 'env-brave'
    view = await config.searchApiConfig()
    ok(view.providers.brave.source === 'env' && view.configured, '环境变量能配置 Brave，来源标 env')
    await config.setSearchKey('brave', 'file-brave')
    ok((await config.resolveSearchKey('brave')) === 'file-brave', '文件里的 key 优先于环境变量')
    delete process.env.BRAVE_API_KEY

    /* 旧版配置文件只有 braveKey / hintDismissed，必须继续可读 */
    writeFileSync(join(dataDir, 'search-config.json'), JSON.stringify({ braveKey: 'legacy', hintDismissed: true }))
    view = await config.searchApiConfig()
    ok(view.providers.brave.configured && view.hintDismissed, '旧格式配置文件仍然有效')
    await config.clearSearchKey('brave')
    const raw = JSON.parse(readFileSync(join(dataDir, 'search-config.json'), 'utf8'))
    ok(!('braveKey' in raw) && raw.hintDismissed === true, '清除一个 key 不动其他字段')
    ok(shared.isSearchProviderId('context7') && !shared.isSearchProviderId('google'), '服务名白名单')
    await config.clearSearchKey('firecrawl')
    await config.clearSearchKey('context7')
  }

  /* ---- Tavily ---- */
  {
    const noKey = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000 }, async () => { throw new Error('不该发请求') })
    ok(noKey.unavailable && noKey.error?.code === 'api_key_missing', '没配 key → unavailable，不发请求')

    await config.setSearchKey('tavily', 'tvly-test')
    const okRun = fakeFetch([json(200, { results: [{ title: 'T1', url: 'https://a.example/1', content: '摘要 1', published_date: '2026-09-30T00:00:00Z' }, { title: 'T2', url: 'https://a.example/2', content: '摘要 2' }] })])
    const run = await tavily.runTavilySearch('flash attention', { limit: 50, timeoutMs: 1000 }, okRun.impl)
    const call = okRun.calls[0]
    ok(call.url === 'https://api.tavily.com/search' && call.init.method === 'POST', '请求 Tavily /search')
    ok(call.init.headers.Authorization === 'Bearer tvly-test', '用 Bearer 带 key')
    ok(call.body.query === 'flash attention' && call.body.search_depth === 'basic' && call.body.max_results === 20, 'basic 深度（1 credit），条数上限夹到 20')
    ok(run.rows?.length === 2 && run.rows[0].snippet === '摘要 1' && run.rows[0].published === '2026-09-30' && run.rows[1].published === undefined, '字段映射：content→snippet，日期取到天')

    for (const [status, code] of [[401, 'api_key_rejected'], [429, 'rate_limited'], [432, 'rate_limited'], [433, 'rate_limited'], [500, 'http_error']]) {
      const r = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([json(status, { detail: 'x' })]).impl)
      ok(r.rows === null && r.error?.code === code && !r.unavailable, `HTTP ${status} → ${code}`)
    }
    const bad = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([{ status: 200, body: '<html>' }]).impl)
    ok(bad.error?.code === 'bad_response', '返回不是 JSON → bad_response，不当成没结果')
    const empty = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([json(200, { results: [] })]).impl)
    ok(Array.isArray(empty.rows) && empty.rows.length === 0 && !empty.error, '空结果是空数组，由聚合器判 empty')
    const slow = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 20 }, (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    ok(slow.timedOut === true && slow.error?.code === 'timeout', '超时 → timedOut')
    const net = await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([{ throws: new Error('ECONNRESET') }]).impl)
    ok(net.error?.code === 'network_error' && /ECONNRESET/.test(net.error.message), '网络错误如实上报')
    await config.clearSearchKey('tavily')
  }

  /* ---- Firecrawl 读网页 ---- */
  {
    const never = async () => { throw new Error('不该发请求') }
    let err = null
    await firecrawl.firecrawlReadPage('https://example.com/a', {}, never).catch((e) => { err = e })
    ok(err?.code === 'api_key_missing', '没配 key → api_key_missing')

    await config.setSearchKey('firecrawl', 'fc-test')
    for (const bad of ['http://localhost:3000/x', 'http://192.168.1.5/admin', 'file:///etc/passwd', 'not a url']) {
      err = null
      await firecrawl.firecrawlReadPage(bad, {}, never).catch((e) => { err = e })
      ok(err && ['private_host', 'bad_url'].includes(err.code), `不把 ${bad} 发给云端（${err?.code}）`)
    }

    const good = fakeFetch([json(200, { success: true, data: { markdown: '# 标题\n\n正文'.padEnd(2000, '。'), metadata: { title: ['页面标题', '备用'], sourceURL: 'https://example.com/a', url: 'https://example.com/final', statusCode: 200 } } })])
    const page = await firecrawl.firecrawlReadPage('https://example.com/a', { maxChars: 600 }, good.impl)
    const call = good.calls[0]
    ok(call.url === 'https://api.firecrawl.dev/v2/scrape' && call.init.headers.Authorization === 'Bearer fc-test', '请求 v2 scrape，Bearer 带 key')
    ok(call.body.url === 'https://example.com/a' && call.body.formats[0] === 'markdown' && call.body.onlyMainContent === true, '只要 markdown 正文')
    ok(page.title === '页面标题' && page.finalUrl === 'https://example.com/final', '标题取数组第一项，finalUrl 取 url')
    ok(page.text.length === 600 && page.truncated && page.totalChars > 600, '按 maxChars 截断并标明原文长度')

    for (const [status, code] of [[401, 'api_key_rejected'], [402, 'rate_limited'], [429, 'rate_limited'], [503, 'http_error']]) {
      err = null
      await firecrawl.firecrawlReadPage('https://example.com/a', {}, fakeFetch([json(status, {})]).impl).catch((e) => { err = e })
      ok(err?.code === code, `HTTP ${status} → ${code}`)
    }
    err = null
    await firecrawl.firecrawlReadPage('https://example.com/a', {}, fakeFetch([json(200, { success: false, error: 'blocked' })]).impl).catch((e) => { err = e })
    ok(err?.code === 'bad_response' && /blocked/.test(err.message), 'success:false → bad_response 并带上原因')
    await config.clearSearchKey('firecrawl')
  }

  /* ---- Context7 开发文档 ---- */
  {
    const libs = json(200, { results: [
      { id: '/reactjs/react.dev', title: 'React', description: '官方文档', totalSnippets: 4305 },
      { id: '/react/react', title: 'React' },
      { id: '/websites/react_dev', title: 'React' }
    ] })
    const keyless = fakeFetch([libs, { status: 200, body: '### 清理函数\n\nSource: x\n\n```js\nuseEffect(() => () => {})\n```' }])
    const res = await context7.queryDocs({ library: 'react', query: 'useEffect 清理' }, keyless.impl)
    ok(keyless.calls.length === 2, '库名 → 先搜库再取文档，共两次请求')
    ok(/\/libs\/search\?/.test(keyless.calls[0].url) && keyless.calls[0].url.includes('libraryName=react'), '第一步按库名搜索')
    ok(keyless.calls[1].url.includes('libraryId=%2Freactjs%2Freact.dev') && /\/context\?/.test(keyless.calls[1].url), '第二步用排第一的库 ID 取文档')
    ok(!('Authorization' in keyless.calls[0].init.headers), '没配 key 也能用，不带 Authorization')
    ok(res.library.id === '/reactjs/react.dev' && res.alternatives.length === 2 && res.text.includes('清理函数'), '返回库信息、候选和文档正文')

    await config.setSearchKey('context7', 'ctx7sk-test')
    const keyed = fakeFetch([{ status: 200, body: '正文' }])
    const direct = await context7.queryDocs({ libraryId: '/vercel/next.js', query: 'middleware' }, keyed.impl)
    ok(keyed.calls.length === 1 && keyed.calls[0].init.headers.Authorization === 'Bearer ctx7sk-test', '给了库 ID 就跳过搜库；配了 key 就带上')
    ok(direct.alternatives.length === 0, '指定库 ID 时没有候选')

    const redirected = fakeFetch([{ status: 301, body: JSON.stringify({ error: 'library_redirected', redirectUrl: '/react/react' }) }, { status: 200, body: '新库正文' }])
    const moved = await context7.queryDocs({ libraryId: '/facebook/react', query: 'hooks' }, redirected.impl)
    ok(redirected.calls[1].url.includes('libraryId=%2Freact%2Freact') && moved.library.id === '/react/react', '库改名（301）跟一次重定向')

    let err = null
    await context7.queryDocs({ library: 'nosuchlib', query: 'x' }, fakeFetch([json(200, { results: [] })]).impl).catch((e) => { err = e })
    ok(err?.code === 'library_not_found', '搜不到库 → library_not_found')
    err = null
    await context7.queryDocs({ libraryId: '/a/b', query: 'x' }, fakeFetch([json(404, { error: 'library_not_found', message: '没有这个库' })]).impl).catch((e) => { err = e })
    ok(err?.code === 'library_not_found' && /没有这个库/.test(err.message), '404 → library_not_found 并保留服务端说明')
    err = null
    await context7.queryDocs({ libraryId: '/a/b', query: 'x' }, fakeFetch([json(429, { error: 'rate_limited' })]).impl).catch((e) => { err = e })
    ok(err?.code === 'rate_limited', '429 → rate_limited')
    err = null
    await context7.queryDocs({ library: 'react', query: 'x' }, fakeFetch([libs, { status: 200, body: '   ' }]).impl).catch((e) => { err = e })
    ok(err?.code === 'empty' && err.candidates?.length === 2, '没有相关文档 → empty，并把候选库交还模型换一个')
    err = null
    await context7.queryDocs({ libraryId: '/a/b', query: 'x' }, fakeFetch([{ status: 301, body: JSON.stringify({ redirectUrl: '/c/d' }) }, { status: 301, body: JSON.stringify({ redirectUrl: '/e/f' }) }]).impl).catch((e) => { err = e })
    ok(err?.code === 'http_error', '连续重定向不无限跟')
    const long = await context7.queryDocs({ libraryId: '/a/b', query: 'x', maxChars: 500 }, fakeFetch([{ status: 200, body: 'x'.repeat(3000) }]).impl)
    ok(long.text.length === 500 && long.truncated && long.totalChars === 3000, '正文按 maxChars 截断')
    await config.clearSearchKey('context7')
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}
