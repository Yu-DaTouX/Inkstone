import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

  {
    const { deepseek } = mod
    const never = async () => { throw new Error('不该发请求') }
    const noKey = await deepseek.runDeepseekSearch('q', { limit: 5, timeoutMs: 1000 }, never, async () => undefined)
    ok(noKey.unavailable && noKey.error?.code === 'api_key_missing', 'DeepSeek 没有模型 key → unavailable，不发请求')
    ok((await config.searchApiConfig()).deepseekModelKey === false, '没有模型 key 时设置页显示未检测到')

    const key = async () => 'sk-ds-test'
    const okRun = fakeFetch([json(200, { results: [
      { title: 'D1', url: 'https://d.example/1', snippet: '短摘要', summary: '给模型的长摘要', date: '2026-10-01T08:00:00Z', rerank_score: 2.1 },
      { title: 'D2', url: 'https://d.example/2', snippet: '只有短摘要', summary: '', date: null }
    ] })])
    const run = await deepseek.runDeepseekSearch('查'.repeat(150), { limit: 80, timeoutMs: 1000 }, okRun.impl, key)
    const call = okRun.calls[0]
    ok(call.url === 'https://api.deepseek.com/v1/tools/search' && call.init.method === 'POST', '请求 DeepSeek /v1/tools/search')
    ok(call.init.headers.Authorization === 'Bearer sk-ds-test', '用 Bearer 带模型 key')
    ok(Array.from(call.body.query).length === 128 && call.body.count === 50, '查询截到 128 字符，条数夹到 50')
    ok(run.rows?.length === 2 && run.rows[0].snippet === '给模型的长摘要' && run.rows[0].published === '2026-10-01', 'summary 优先作摘要，日期取到天')
    ok(run.rows[1].snippet === '只有短摘要' && run.rows[1].published === undefined, 'summary 为空时退回 snippet')

    const poor = await deepseek.runDeepseekSearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([json(402, { error: { message: 'Insufficient Balance', type: 'x', code: 'insufficient_balance' } })]).impl, key)
    ok(poor.error?.code === 'insufficient_balance' && /余额不足/.test(poor.error.message) && /Insufficient Balance/.test(poor.error.message), '402 → 余额不足，带上服务端原因')
    const busy = await deepseek.runDeepseekSearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([json(429, {})]).impl, key)
    ok(busy.error?.code === 'rate_limited' && /QPS/.test(busy.error.message), '429 → 超过 QPS')
    const denied = await deepseek.runDeepseekSearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([json(401, {})]).impl, key)
    ok(denied.error?.code === 'api_key_rejected', '401 → api_key_rejected')
    const bad = await deepseek.runDeepseekSearch('q', { limit: 5, timeoutMs: 1000 }, fakeFetch([{ status: 200, body: '<html>' }]).impl, key)
    ok(bad.error?.code === 'bad_response', 'DeepSeek 返回不是 JSON → bad_response')

    let err = null
    await deepseek.deepseekReadPage('http://127.0.0.1:8080/x', {}, never, key).catch((e) => { err = e })
    ok(err?.code === 'private_host', '不把本机地址发给 DeepSeek Fetch')
    const page = fakeFetch([json(200, { title: ' 页面 ', content: '# 正文\n\n'.padEnd(1200, '字') })])
    const read = await deepseek.deepseekReadPage('https://example.com/a', { maxChars: 600 }, page.impl, key)
    ok(page.calls[0].url === 'https://api.deepseek.com/v1/tools/fetch' && page.calls[0].body.url === 'https://example.com/a', '请求 /v1/tools/fetch 并带上网址')
    ok(read.title === '页面' && read.text.length === 600 && read.truncated && read.totalChars > 600, 'Fetch 正文按 maxChars 截断')
    for (const [status, code] of [[403, 'blocked'], [404, 'no_content'], [402, 'insufficient_balance']]) {
      err = null
      await deepseek.deepseekReadPage('https://example.com/a', {}, fakeFetch([json(status, {})]).impl, key).catch((e) => { err = e })
      ok(err?.code === code, `Fetch HTTP ${status} → ${code}`)
    }
  }

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

  {
    const { plan, modifiers, bing, ddg, so360, brave, deepseek } = mod
    const none = { tavily: false, brave: false, deepseek: false }
    const zhFree = plan.defaultSearchPlan('北京天气', none)
    ok(zhFree.sources.join(',') === 'ddg,so360', '没有 key：查 DuckDuckGo + 360，不再带 Bing、维基百科 / arXiv / HN')
    ok(zhFree.policy.primary.join(',') === 'ddg' && zhFree.policy.reserve.length === 0, '没有 key 时 DuckDuckGo 够用就提前停掉慢的 360')
    ok(plan.defaultSearchPlan('weather', none).sources.join(',') === 'ddg,so360', '英文同样是 DuckDuckGo + 360')
    const all = { tavily: true, brave: true, deepseek: true }
    const zhPaid = plan.defaultSearchPlan('北京天气', all)
    ok(zhPaid.sources.join(',') === 'deepseek,ddg', '有 key：中文只用 DeepSeek 一个付费来源加 DuckDuckGo，不再三家同时扣费')
    ok(zhPaid.policy.primary.join(',') === 'deepseek' && zhPaid.policy.reserve.join(',') === 'tavily,brave,so360', '其余付费来源与 360 留作后备')
    const enPaid = plan.defaultSearchPlan('weather', { tavily: false, brave: true, deepseek: true })
    ok(enPaid.sources.join(',') === 'brave,ddg' && enPaid.policy.reserve.join(',') === 'deepseek,so360', '英文按 Tavily → Brave → DeepSeek 挑第一个有 key 的')
    for (const keys of [none, all, { tavily: true, brave: false, deepseek: false }]) {
      for (const text of ['北京天气', 'weather']) {
        const p = plan.defaultSearchPlan(text, keys)
        ok(![...p.sources, ...p.policy.reserve].includes('bing'), `默认来源里没有 Bing（${text}）`)
      }
    }

    ok(plan.searchQueries({ 'query-text': ['a', ' b ', 'a', ''] }).join('|') === 'a|b', '重复的 --query-text 收成多个查询并去重')
    ok(plan.searchQueries({ queries: ['x', 'y'] }).join('|') === 'x|y', '请求文件里的 queries 数组也认')
    ok(plan.searchQueries({ 'query-text': 'one' }).join('|') === 'one', '单个查询照旧')
    ok(plan.tooManyQueries(['1', '2', '3', '4', '5', '6']) && !plan.tooManyQueries(['1', '2', '3', '4', '5']), '一次最多 5 个查询')

    const good = plan.searchModifiers({ recent: 'WEEK', site: 'https://www.GitHub.com/x, docs.python.org', question: ' 原问题 ', 'with-content': true })
    ok(good.ok && good.modifiers.recent === 'week', '--recent 不分大小写')
    ok(good.ok && good.modifiers.sites.join(',') === 'github.com,docs.python.org', '--site 去掉协议、路径和 www，逗号分隔多个')
    ok(good.ok && good.modifiers.question === '原问题' && good.modifiers.withContent === true, '--question 去空白，--with-content 识别为开关')
    ok(plan.searchModifiers({ recent: 'decade' }).code === 'search_bad_recent', '--recent 只认 day/week/month/year')
    ok(plan.searchModifiers({ site: 'not a domain' }).code === 'search_bad_site', '不像域名的站点直接拒绝')
    ok(plan.searchModifiers({}).ok && Object.keys(plan.searchModifiers({}).modifiers).length === 0, '什么都不写就没有限定')
    ok(modifiers.normalizeSites('a.com,b.com,c.com,d.com,e.com,f.com').sites.length === 5, '站点最多 5 个')
    ok(modifiers.siteOperator(['a.com']) === 'site:a.com' && modifiers.siteOperator(['a.com', 'b.org']) === '(site:a.com OR site:b.org)', '站点写成 site: 语法')
    ok(Array.from(modifiers.withOperators('查'.repeat(200), ['after:2026-01-01'], 128)).length === 128, '加上限定后整体仍不超过长度上限')
    ok(modifiers.withOperators('查'.repeat(200), ['after:2026-01-01'], 128).endsWith(' after:2026-01-01'), '截短的是查询词，不是限定条件')

    const now = Date.UTC(2026, 9, 19)
    ok(bing.bingUrl('q', 6, 'en', 'week', now).includes('&filters=' + encodeURIComponent('ex1:"ez2"')), 'Bing 最近一周用 ez2')
    ok(bing.bingUrl('q', 6, 'en', 'year', now).includes(encodeURIComponent(`ex1:"ez5_${Math.floor(now / 86400000) - 366}_${Math.floor(now / 86400000)}"`)), 'Bing 最近一年用日期区间')
    ok(!bing.bingUrl('q', 6, 'en').includes('filters='), '不限时间时不带 filters')
    ok(ddg.ddgUrl('q', 'month').endsWith('&df=m'), 'DuckDuckGo 用 df 时间参数')
    ok(so360.so360Url('q') === 'https://www.so.com/s?q=q', '360 网页没有时间筛选，不再拼无效参数')
    ok(modifiers.siteMatches('https://www.zhuanlan.zhihu.com/p/1', ['zhihu.com']) && !modifiers.siteMatches('https://notzhihu.com/', ['zhihu.com']), '站点匹配包含子域名，不误认相似域名')

    const dsBody = deepseek.deepseekSearchBody('新闻', { limit: 6, timeoutMs: 1000, recent: 'week', sites: ['xinhuanet.com'], question: '这周有什么新闻', withContent: true }, now)
    ok(dsBody.query === '新闻 site:xinhuanet.com after:2026-10-12', 'DeepSeek 用 site: 与 after: 语法')
    ok(dsBody.ori_question === '这周有什么新闻' && dsBody.need_content === true, 'DeepSeek 带上原问题并要正文')
    ok(!('ori_question' in deepseek.deepseekSearchBody('q', { limit: 6, timeoutMs: 1000 })), '没给原问题就不发 ori_question')

    const key = async () => 'sk-ds-test'
    const ranked = fakeFetch([json(200, { results: [
      { title: 'low', url: 'https://d/low', snippet: 's', rerank_score: 0.4, content: '低分正文' },
      { title: 'high', url: 'https://d/high', snippet: 's', rerank_score: 2.6, content: '高分正文' }
    ] })])
    const dsRun = await deepseek.runDeepseekSearch('q', { limit: 6, timeoutMs: 1000, withContent: true }, ranked.impl, key)
    ok(dsRun.rows[0].title === 'high' && dsRun.rows[0].content === '高分正文', 'DeepSeek 结果按 rerank_score 排序，带正文')
    const noContent = await deepseek.runDeepseekSearch('q', { limit: 6, timeoutMs: 1000 }, fakeFetch([json(200, { results: [{ title: 't', url: 'https://d/1', content: 'x' }] })]).impl, key)
    ok(!('content' in noContent.rows[0]), '没要正文时不把正文塞进结果')

    await config.setSearchKey('tavily', 'tvly-test')
    const tv = fakeFetch([json(200, { results: [] })])
    await tavily.runTavilySearch('q', { limit: 5, timeoutMs: 1000, recent: 'month', sites: ['a.com'] }, tv.impl)
    ok(tv.calls[0].body.time_range === 'month' && tv.calls[0].body.include_domains[0] === 'a.com', 'Tavily 用 time_range 与 include_domains')
    await config.clearSearchKey('tavily')

    await config.setSearchKey('brave', 'brave-test')
    let braveUrl = ''
    await brave.runBraveSearch('q', { limit: 5, timeoutMs: 1000, recent: 'day', sites: ['a.com'] }, async (url) => {
      braveUrl = String(url)
      return { ok: true, status: 200, json: async () => ({ web: { results: [] } }) }
    })
    const params = new URL(braveUrl).searchParams
    ok(params.get('freshness') === 'pd' && params.get('q') === 'q site:a.com', 'Brave 用 freshness，站点写进查询')
    await config.clearSearchKey('brave')

    let t = 0
    const cache = new plan.TtlCache(100, 2, () => t)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    ok(cache.get('a') === 1 && cache.get('b') === undefined, '缓存满了先淘汰最久没用的')
    t = 200
    ok(cache.get('a') === undefined, '过期的缓存不再返回')
    const order = []
    const mapped = await plan.mapLimit([30, 5, 10], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      order.push(ms)
      return ms * 2
    })
    ok(mapped.join(',') === '60,10,20' && order[0] === 5, '多个查询并行跑，结果按原顺序返回')
  }
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}
