import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createWebTools, pageText, searchText } from '../resources/pi-extensions/web-tools.js'
import { callHostTool } from '../resources/pi-extensions/host-tool-call.js'

export function pdfFixture() {
  const stream = (text) => { const value = `BT /F1 12 Tf 30 700 Td (${text}) Tj ET`; return `<< /Length ${value.length} >>\nstream\n${value}\nendstream` }
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream('First page: introduction.'),
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream('Second page: exception clause.'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(text))
}

export async function runWebResearchTests() {
  await mkdir(resolve('.tmp'), { recursive: true })
  const dir = await mkdtemp(resolve('.tmp/web-research-'))
  const stub = join(dir, 'electron.mjs')
  await writeFile(stub, 'export class BrowserWindow { constructor() { throw Error("unexpected browser") } }; export const session = {}')
  const outfile = join(dir, 'research.mjs')
  let checks = 0
  const check = (value, message) => { assert.ok(value, message); checks++ }
  try {
    await build({ stdin: { contents: [
      "export * from './src/main/search/page-store'",
      "export * from './src/main/search/html-content'",
      "export * from './src/main/search/pdf-content'",
      "export * from './src/main/search/public-page'",
      "export * from './src/main/search/plan'",
      "export * from './src/main/search/search'",
      "export { CapabilityServer } from './src/main/capability-server'"
    ].join('\n'), resolveDir: process.cwd() }, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', alias: { electron: stub }, logLevel: 'silent' })
    const mod = await import(pathToFileURL(outfile).href)
    const extracted = mod.extractHtml(`<html><head><title>Research</title><meta property="article:published_time" content="2026-10-01"></head><body><nav>REMOVE NAV</nav><main><h1>Guide</h1><p>${'This is original article text. '.repeat(40)}</p><pre>const value = 1;\n  return value;</pre><table><tr><th>Model</th><th>Limit</th></tr><tr><td>Alpha</td><td>200</td></tr></table><p><a href="../reference">Reference</a><a href="javascript:alert(1)">Unsafe</a></p></main><footer>REMOVE FOOTER</footer></body></html>`, 'https://example.com/docs/page')
    check(extracted.text.includes('# Guide') && !extracted.text.includes('REMOVE NAV') && !extracted.text.includes('REMOVE FOOTER'), '正文保留标题，去掉导航和页尾')
    check(extracted.text.includes('```\nconst value = 1;\n  return value;\n```'), '代码换行和缩进保持')
    check(extracted.text.includes('| Model | Limit |\n| --- | --- |\n| Alpha | 200 |'), '表格单元关系与 Markdown 表头保持')
    check(extracted.links.some((link) => link.url === 'https://example.com/reference') && extracted.links.every((link) => !link.url.startsWith('javascript:')), '相对链接解析，脚本链接不输出')
    check(extracted.publishedAt === '2026-10-01', '发布时间随正文返回')
    const structured = mod.extractHtml(`<html><body><main><h2>Lists</h2><ul><li>alpha<ul><li>alpha-1</li></ul></li><li>beta</li></ul><ol><li>one</li><li>two</li></ol><table><tr><td>plain</td><td>second | pipe</td></tr><tr><td>row2</td><td>x</td></tr></table><p><img src="../pics/a.png" alt="Diagram"> <img src="data:image/gif;base64,AAAA" alt="tracker"> <img src="javascript:alert(1)" alt="bad"></p><pre>raw &lt;block&gt;
  indented</pre><pre>a \`\`\` b</pre></main></body></html>`, 'https://example.com/docs/page')
    check(structured.text.includes('- alpha\n  - alpha-1\n- beta'), '嵌套列表按层级缩进')
    check(structured.text.includes('\n1. one\n2. two'), '有序列表按序编号')
    check(structured.text.includes('| plain | second \\| pipe |\n| --- | --- |\n| row2 | x |'), '没有表头的表格保留首行内容并转义竖线')
    check(
      structured.text.includes('![Diagram](<https://example.com/pics/a.png>)') && !structured.text.includes('tracker') && !structured.text.includes('bad'),
      '图片保留 alt 与解析后的地址，data: 与脚本图片不输出'
    )
    check(structured.text.includes('```\nraw <block>\n  indented\n```'), '没有 code 子元素的 pre 仍输出代码围栏')
    check(structured.text.includes('````\na ``` b\n````'), '代码自带三反引号时围栏加长')
    let now = 1000
    const store = new mod.PageStore(() => now)
    const text = `${'intro line\n'.repeat(3000)}exception clause at the end\n`
    const snapshot = store.put({ url: 'https://example.com/a', finalUrl: 'https://example.com/final', title: 'Long page', text, totalChars: text.length, truncated: false, links: extracted.links }, 'local')
    const remote = store.put({ url: snapshot.url, finalUrl: snapshot.finalUrl, title: 'Remote Markdown', text: '[Related](https://example.com/a_(b)) [Angle](<https://example.com/next>)', totalChars: 80, truncated: false }, 'deepseek')
    check(remote.links[0].url === 'https://example.com/a_(b)' && remote.links[1].url === 'https://example.com/next', '远端 Markdown 链接保持括号与绝对地址')
    const first = mod.pageRange(snapshot, 0, 500)
    check(first.nextOffset === 500 && first.truncated && !first.sourceTruncated, '响应截断与原始抓取截断分开')
    const found = mod.findInPage(snapshot, 'exception')
    check(found.matches[0].offset > 12000 && found.matches[0].line === 3001, '查找可定位默认输出上限之外的原文')
    const tail = mod.pageRange(store.get(snapshot.pageRef), found.matches[0].offset, 500)
    check(tail.text.includes('exception clause') && tail.nextOffset === undefined, '同一快照可续读末尾，无重复抓取')
    assert.throws(() => mod.pageRange(snapshot, -1), /offset/); checks++
    assert.throws(() => new mod.PageStore().get(snapshot.pageRef), /当前会话/); checks++
    now += 30 * 60000
    assert.throws(() => store.get(snapshot.pageRef), /过期/); checks++
    const truncated = mod.pageRange({ ...snapshot, truncated: true }, text.length - 50, 500)
    check(truncated.sourceTruncated && truncated.nextOffset === undefined, '来源上限之外不伪造续读游标')
    const many = mod.findInPage({ ...snapshot, text: 'needle '.repeat(40) }, 'needle')
    check(many.matches.length === 20 && many.nextOffset > 0, '命中列表分页并给下一起点')
    check(mod.findInPage({ ...snapshot, text: 'İ before literal [a+b] end' }, '[a+b]').matches[0].offset === 17, '字面量匹配不执行正则，Unicode 大小写不改变位置')
    const controller = new AbortController()
    const seen = []
    const publicDeps = { resolve: async () => [{ address: '203.0.113.10', family: 4 }], open: async (url, addresses) => { seen.push([url.href, addresses]); return { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('public text') } } }
    const publicPage = await mod.fetchPublicPage('https://example.com/a', controller.signal, publicDeps)
    check(publicPage.finalUrl === 'https://example.com/a' && seen[0][1][0].address === '203.0.113.10', 'HTTP 使用已核对的解析地址')
    await assert.rejects(mod.fetchPublicPage('https://example.com/a', controller.signal, { ...publicDeps, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /内网/); checks++
    await assert.rejects(mod.fetchPublicPage('https://example.com/a', controller.signal, { ...publicDeps, open: async () => ({ status: 302, headers: { location: 'http://169.254.169.254/' }, body: new Uint8Array() }) }), /内网/); checks++
    await assert.rejects(mod.fetchPublicPage('https://user:password@example.com/', controller.signal, publicDeps), /用户名/); checks++
    const dnsStop = new AbortController()
    const waiting = mod.fetchPublicPage('https://example.com/', dnsStop.signal, { ...publicDeps, resolve: () => new Promise(() => {}) })
    dnsStop.abort(new Error('DNS cancelled'))
    await assert.rejects(waiting, /DNS cancelled/); checks++
    const cache = new mod.TtlCache(1000, 4)
    const a = new AbortController(), b = new AbortController()
    let finish, sharedSignal, loads = 0
    const load = (signal) => { loads++; sharedSignal = signal; return new Promise((done) => { finish = done }) }
    const one = cache.getOrLoad('same', load, { signal: a.signal })
    const two = cache.getOrLoad('same', load, { signal: b.signal })
    await Promise.resolve()
    a.abort(new Error('one stopped'))
    await assert.rejects(one, /one stopped/); checks++
    check(!sharedSignal.aborted && loads === 1, '单一订阅取消不会中断其他订阅')
    finish('done')
    check((await two).value === 'done' && cache.get('same') === 'done', '其他订阅正常完成并缓存')
    const all = new AbortController()
    const pending = cache.getOrLoad('cancel', (signal) => { sharedSignal = signal; return new Promise(() => {}) }, { signal: all.signal })
    await Promise.resolve(); all.abort(new Error('all stopped'))
    await assert.rejects(pending, /all stopped/); checks++
    check(sharedSignal.aborted && cache.get('cancel') === undefined, '全部订阅取消后终止底层请求且不缓存')
    const filters = mod.searchModifiers({ language: 'EN', country: 'au', after: '2026-10-01', before: '2026-10-29', excludeSites: ['spam.example'], coverage: 'broad' })
    check(filters.ok && filters.modifiers.country === 'AU' && filters.modifiers.language === 'en', '查询条件归一化')
    check(!mod.searchModifiers({ after: '2026-02-30' }).ok && !mod.searchModifiers({ after: '2026-10-29', before: '2026-10-01' }).ok, '无效和颠倒日期拒绝')
    const broad = mod.defaultSearchPlan('query', { tavily: true, brave: true, deepseek: true }, filters.modifiers)
    check(broad.sources.length === 4 && broad.policy === undefined, '广覆盖模式使用已配置来源，不按条数提前停止')
    let calls = []
    const run = await mod.runSearch({ text: 'query', sources: ['brave', 'tavily'], excludeSites: ['spam.example'], country: 'AU' }, { now: Date.now, runner: async (source) => { calls.push(source.id); return { source: source.id, elapsedMs: 1, rows: [{ title: 'Shared', url: 'https://example.com/same', snippet: 'same excerpt '.repeat(20) }, { title: 'Excluded', url: 'https://spam.example/a' }] } } })
    check(run.items.length === 1 && run.items[0].sources.length === 2 && run.fetchedAt, '去重保留所有命中来源，排除站点硬过滤')
    check(calls.length === 2, '独立来源均执行')
    const grouped = mod.aggregate([{ source: 'ddg', elapsedMs: 1, rows: [{ title: 'Original', url: 'https://example.com/original', snippet: 'same long excerpt '.repeat(20) }, { title: 'Copy', url: 'https://copy.example.net/a', snippet: 'same long excerpt '.repeat(20) }] }], { limitPerSource: 6, limitTotal: 12 })
    check(grouped.items[0].groupId === grouped.items[1].groupId && grouped.items[0].groupId.startsWith('excerpt-'), '相同长摘要分组，不当作独立证据')
    const stop = new AbortController()
    let providerSignal
    const cancelledSearch = mod.runSearch({ text: 'query', sources: ['brave'] }, { now: Date.now, signal: stop.signal, runner: async (_source, _query, options) => { providerSignal = options.signal; return new Promise(() => {}) } })
    await Promise.resolve(); stop.abort(new Error('search stopped'))
    await assert.rejects(cancelledSearch, /search stopped/); checks++
    check(providerSignal.aborted, '搜索取消传播到来源')
    const timedOut = await mod.runSearch({ text: 'query', sources: ['brave'], timeoutMs: 1000 }, { now: Date.now, runner: () => new Promise(() => {}) })
    check(timedOut.sources[0].status === 'timeout', '不响应的来源受查询总时限约束')
    const pdf = await mod.extractPdf(pdfFixture(), new AbortController().signal, 2000000)
    check(pdf.pageCount === 2 && pdf.pages.length === 2 && pdf.text.includes('exception clause'), '真实 PDF.js 可提取两页并保留页码')
    const pdfSnap = { ...snapshot, ...pdf }
    check(mod.findInPage(pdfSnap, 'exception').matches[0].page === 2, 'PDF 页内查找带准确页号')
    const searchBody = searchText({ query: 'fixture', fetchedAt: '2026-10-29T00:00:00Z', cached: true, cacheAgeMs: 100, sources: [{ source: 'ddg', status: 'error', code: 'captcha', elapsedMs: 20 }], items: [{ title: 'A', url: 'https://example.com/', source: 'tavily', snippet: 'candidate' }] })
    check(searchBody.includes('captcha') && searchBody.includes('not verified') && searchBody.includes('cache: hit'), '模型读到来源失败、证据级别与缓存状态')
    check(pageText({ ...first, action: 'read' }).includes(`offset=500`) && pageText({ ...truncated, action: 'read' }).includes('does not contain the complete source'), '正文工具明确续读与来源截断')
    const server = new mod.CapabilityServer({ opsDir: join(dir, 'ops'), onlyCommands: ['search.query', 'search.fetch', 'search.docs'], handlers: { run: async (command, params) => ({ data: command === 'search.fetch' ? { ...first, action: 'read' } : command === 'search.docs' ? { library: { id: '/fixture/lib' }, text: 'documented API', alternatives: [], totalChars: 14 } : { query: params.query, sources: [], items: [{ title: 'Result', url: 'https://example.com/', source: 'ddg' }] }, summary: { kind: 'search' } }) } })
    const endpoint = await server.start({ sessionId: 'fixture-session', projectId: 'fixture-project' })
    try {
      const env = { YAN_RUNNER_ID: 'primary', YAN_SESSION_ID: 'fixture-session', YAN_PROJECT_ID: 'fixture-project', YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token }
      const tools = createWebTools((request) => callHostTool({ ...request, env }))
      const result = await tools[0].execute('search-1', { query: 'fixture' }, undefined, undefined, { cwd: dir })
      check(result.details.search.items[0].readState === 'discovered', '真实本机宿主调用返回候选来源状态')
      const fetched = await tools[1].execute('fetch-1', { pageRef: snapshot.pageRef })
      check(fetched.content[0].text.includes(snapshot.pageRef) && fetched.details.search.readState === 'partial', '原生工具跨宿主保留快照与截断状态')
      const docs = await tools[2].execute('docs-1', { library: 'fixture', query: 'API' })
      check(docs.content[0].text.includes('documented API'), '开发文档原生入口复用宿主')
    } finally { server.stop() }
    console.log(`web-research: ${checks} assertions passed (offline; real HTML/PDF parsers and loopback host)`)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runWebResearchTests()
