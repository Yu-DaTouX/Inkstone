#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = resolve(ROOT, '.tmp/websearch')
const posix = (path) => path.replace(/\\/g, '/')

async function load() {
  await mkdir(OUT, { recursive: true })
  const entry = resolve(OUT, 'entry.ts')
  const renderer = posix(resolve(ROOT, 'src/renderer/src/features/session/web-search'))
  const mainIpc = posix(resolve(ROOT, 'src/main/ipc'))
  await writeFile(entry, [
    `export * from '${renderer}/model.ts'`,
    `export * from '${mainIpc}/search-ops-ipc.ts'`
  ].join('\n'))
  const outfile = resolve(OUT, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    external: ['electron']
  })
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

async function loadView() {
  await mkdir(OUT, { recursive: true })
  const entry = resolve(OUT, 'entry-view.tsx')
  const session = posix(resolve(ROOT, 'src/renderer/src/features/session'))
  const i18n = posix(resolve(ROOT, 'src/renderer/src/i18n/index.tsx'))
  await writeFile(entry, [
    `export { SearchStepView } from '${session}/web-search/SearchStep.tsx'`,
    `export { CitationLink } from '${session}/web-search/citations.tsx'`,
    `export { I18nProvider } from '${i18n}'`
  ].join('\n'))
  const outfile = resolve(OUT, 'bundle-view.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.json': 'json', '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    external: ['react', 'react-dom', 'react-dom/server', 'react-aria-components', 'react-aria', 'react-stately', '@react-aria/*', '@react-stately/*', '@react-types/*', 'lucide-react']
  })
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

function installDomStubs() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.window = globalThis
  globalThis.HTMLElement = class HTMLElementStub {
    focus() {}
  }
  globalThis.screen = { width: 1440, height: 900, angle: 0, orientation: { angle: 0, addEventListener() {}, removeEventListener() {} } }
  globalThis.window.screen = globalThis.screen
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window.addEventListener = () => undefined
  globalThis.window.removeEventListener = () => undefined
  globalThis.document = {
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
    activeElement: null
  }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', clipboard: {} }, configurable: true })
}

let pass = 0
let fail = 0
const failures = []

function ok(condition, label, detail) {
  if (condition) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
    return
  }
  fail += 1
  failures.push(label)
  process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
}

function group(name) {
  process.stdout.write(`\n▌${name}\n`)
  assert.ok(name)
}

const OPERATION = '3f0c1e6a-9b7d-4b3e-8f61-2ad4c5b7e910'

function searchFile(items) {
  return { query: 'electron', items, sources: [{ source: 'ddg', status: 'ok', count: items.length }], truncated: false, durationMs: 42 }
}

function item(index, extra = {}) {
  return {
    title: `结果 ${index}`,
    url: `https://site${index}.example.com/post-${index}?utm_source=ddg`,
    snippet: `摘要 ${index}`,
    source: 'ddg',
    ...extra
  }
}

async function run() {
  const m = await load()

  group('命令行解析：yan search query / fetch 的各种写法')
  {
    const single = m.parseSearchCommand('yan search query --query-text "electron webcontentsview"')
    ok(single?.action === 'query', '基本 query 形式认出动作', single)
    ok(JSON.stringify(single?.queries) === JSON.stringify(['electron webcontentsview']), '引号内的查询词完整保留', single?.queries)

    const multi = m.parseSearchCommand('yan search query --query-text "bun 基准" --query-text "deno 基准" --recent month')
    ok(JSON.stringify(multi?.queries) === JSON.stringify(['bun 基准', 'deno 基准']), '多个 --query-text 都拿到', multi?.queries)

    const equals = m.parseSearchCommand("yan search query --query-text='单引号 查询'")
    ok(JSON.stringify(equals?.queries) === JSON.stringify(['单引号 查询']), '--query-text=值 也可以', equals?.queries)

    const fetch = m.parseSearchCommand('yan search fetch --url https://example.com/post?a=1&b=2')
    ok(fetch?.action === 'fetch' && fetch.url === 'https://example.com/post?a=1&b=2', 'fetch 取出网址', fetch)

    const chained = m.parseSearchCommand('cd /tmp && yan search query --site github.com --query-text "electron WebContentsView" | head -5')
    ok(JSON.stringify(chained?.queries) === JSON.stringify(['electron WebContentsView']), '管道与 && 链式命令里仍能定位搜索段', chained)

    const windows = m.parseSearchCommand('C:\\Users\\me\\yan.cmd search query --query-text "electron 窗口"')
    ok(JSON.stringify(windows?.queries) === JSON.stringify(['electron 窗口']), 'Windows 路径反斜杠不被当转义吃掉', windows)

    const nodeCli = m.parseSearchCommand('node /e/pi-desktop/resources/yan-cli/yan.mjs search query --query-text "flash attention"')
    ok(JSON.stringify(nodeCli?.queries) === JSON.stringify(['flash attention']), 'node 跑 yan.mjs 的形式也识别', nodeCli)

    const quotedBin = m.parseSearchCommand('"/opt/yan/yan" search fetch --url "https://example.com/x"')
    ok(quotedBin?.url === 'https://example.com/x', '带引号的可执行文件路径也识别', quotedBin)

    ok(m.parseSearchCommand('yan operations status --id abc') === null, '非搜索命令不识别')
    ok(m.parseSearchCommand('echo yan search query') === null, '只是文本里出现搜索字样不算')
    ok(m.parseSearchCommand('yan search query') === null, '没有查询词就不算可展示的搜索步骤')
    ok(m.parseSearchCommand('yan search fetch') === null, 'fetch 缺 --url 不算')
    ok(m.parseSearchCommand('') === null, '空命令返回 null')
    ok(m.parseSearchCommand(null) === null, 'null 命令返回 null')
    ok(m.parseSearchCommand('yan search docs --library react --query-text "useEffect"') === null, 'search docs 不当作联网搜索')
  }

  group('命令行解析：分词与引号')
  {
    const tokens = m.tokenizeCommand('yan search query --query-text "a \\"b\\" c" --timeout 5000')
    ok(tokens[0] === 'yan' && tokens[4] === 'a "b" c', '双引号内的转义引号还原', tokens)
    const windowsPath = m.tokenizeCommand('C:\\Users\\me\\yan.cmd search query')
    ok(windowsPath[0] === 'C:\\Users\\me\\yan.cmd', '反斜杠路径原样保留', windowsPath)
    const empty = m.tokenizeCommand('   ')
    ok(empty.length === 0, '空白命令没有 token', empty)
  }

  group('operationId 提取：从工具输出里找 resultFile 对应的 ID')
  {
    const clean = JSON.stringify({ ok: true, operationId: OPERATION, summary: { kind: 'search', action: 'query', count: 3 }, resultFile: 'C:\\x\\ops\\' + OPERATION + '.json', resultBytes: 900 })
    ok(m.extractOperationId(clean) === OPERATION, '单行 JSON 直接提取', m.extractOperationId(clean))

    const noisy = `warning: something\n${clean}\n`
    ok(m.extractOperationId(noisy) === OPERATION, '前后有噪声行也能提取', m.extractOperationId(noisy))

    const pretty = `{\n  "ok": true,\n  "operationId": "${OPERATION}",\n  "summary": {}\n}`
    ok(m.extractOperationId(pretty) === OPERATION, '多行 JSON 用兜底正则提取', m.extractOperationId(pretty))

    const grepped = `"resultFile":"C:\\\\Users\\\\me\\\\.pi\\\\agent\\\\yan\\\\ops\\\\${OPERATION}.json"\n`
    ok(m.extractOperationId(grepped) === OPERATION, '输出被 grep 只剩 resultFile 时从文件名提取', m.extractOperationId(grepped))

    ok(m.extractOperationId(JSON.stringify({ ok: false, operationId: OPERATION, error: 'boom' })) === null, '失败的调用不提取（退回普通步骤）')
    ok(m.extractOperationId('{"ok":true,"operationId":"not-a-uuid"}') === null, '非 UUID 不认')
    ok(m.extractOperationId('') === null, '空输出返回 null')
    ok(m.extractOperationId(undefined) === null, 'undefined 返回 null')
  }

  group('URL 规范化：去 hash、末尾斜杠与 utm 参数')
  {
    ok(m.normalizeUrl('https://Example.com/Post/#section') === 'https://example.com/Post', 'host 归一、去 hash 与末尾斜杠', m.normalizeUrl('https://Example.com/Post/#section'))
    ok(m.normalizeUrl('https://example.com/a?utm_source=x&id=7') === 'https://example.com/a?id=7', 'utm_ 参数被去掉，其余保留', m.normalizeUrl('https://example.com/a?utm_source=x&id=7'))
    ok(m.normalizeUrl('https://example.com/a?b=2&a=1') === m.normalizeUrl('https://example.com/a?a=1&b=2'), '参数顺序不影响比较')
    ok(m.normalizeUrl('   https://example.com/  ') === 'https://example.com', '去空白与根路径斜杠', m.normalizeUrl('   https://example.com/  '))
    ok(m.normalizeUrl('ftp://example.com/x') === null, '非 http(s) 返回 null')
    ok(m.normalizeUrl('/relative/path') === null, '相对路径返回 null')
    ok(m.normalizeUrl(undefined) === null, 'undefined 返回 null')
    ok(m.domainOf('https://www.Milvus.io/docs/x') === 'milvus.io', '域名去掉 www 并小写', m.domainOf('https://www.Milvus.io/docs/x'))
    ok(m.domainOf('not a url') === '', '非法网址域名返回空串')
    ok(m.siteLabel('milvus.io') === 'milvus', '站点名取主域', m.siteLabel('milvus.io'))
    ok(m.siteLabel('en.wikipedia.org') === 'wikipedia', '多级域名取主站名', m.siteLabel('en.wikipedia.org'))
    ok(m.siteLabel('www.bbc.co.uk') === 'bbc', 'ccTLD 组合也识别', m.siteLabel('www.bbc.co.uk'))
    ok(m.siteLabel('127.0.0.1') === '127.0.0.1', 'IP 直接返回', m.siteLabel('127.0.0.1'))
    const tones = ['github.com', 'arxiv.org', 'example.com'].map((seed) => m.siteTone(seed))
    ok(tones.every((tone) => tone >= 0 && tone <= 5), '站点配色索引落在 0..5', tones)
    ok(m.siteTone('github.com') === m.siteTone('github.com'), '同域名配色稳定')
  }

  group('引用匹配：本轮来源编号与 Markdown 链接对齐')
  {
    const sources = [
      { title: 'A', url: 'https://github.com/a/b', domain: 'github.com', snippet: 'A 摘要', source: 'ddg' },
      { title: 'B', url: 'https://arxiv.org/abs/123#top', domain: 'arxiv.org', snippet: 'B 摘要', source: 'brave' },
      { title: 'A 重复', url: 'https://github.com/a/b?utm_medium=x', domain: 'github.com', snippet: '', source: 'bing' }
    ]
    const index = m.buildCitationIndex(sources)
    ok(index.size === 2, '同 URL（含 utm）只保留一条', index.size)
    ok(index.get(m.normalizeUrl('https://github.com/a/b'))?.n === 1, '首个来源编号为 1')
    ok(index.get(m.normalizeUrl('https://arxiv.org/abs/123'))?.n === 2, '第二个来源编号为 2')
    const viaVariation = m.citationFor(index, 'https://github.com/a/b/?utm_source=x#readme')
    ok(viaVariation?.n === 1 && viaVariation.title === 'A', '带 utm/hash/斜杠的回答链接仍匹配到来源', viaVariation)
    ok(m.citationFor(index, 'https://other.example.com/x') === null, '不在本轮来源里的链接不变')
    ok(m.citationFor(null, 'https://github.com/a/b') === null, '没有 provider 时不替换链接')
    ok(m.citationFor(index, undefined) === null, '没有 href 时不替换')
    ok(m.citationFor(index, 'https://github.com/a/b')?.site === 'github', '引用标签用站点名', m.citationFor(index, 'https://github.com/a/b'))
  }

  group('搜索结果清洗：多查询 / 单查询 / 去重 / 上限 / 摘要长度')
  {
    const single = m.cleanSearchSources(searchFile([item(1), item(2)]))
    ok(single.length === 2, '单查询结构 items 全部保留', single.length)
    ok(single[0].domain === 'site1.example.com', '域名从 url 推出', single[0].domain)
    ok(single[0].title === '结果 1' && single[0].source === 'ddg', '标题与来源保留', single[0])

    const multi = m.cleanSearchSources({ queries: [searchFile([item(1)]), { ...searchFile([item(1), item(3)]), query: 'second' }] })
    ok(multi.length === 2, '多查询结构按 data.queries 展开并去重', multi.length)
    ok(multi[1].title === '结果 3', '第二个查询的新结果排在后面', multi[1])

    const bad = m.cleanSearchSources(searchFile([
      item(1, { url: 'javascript:alert(1)' }),
      item(2, { url: 'ftp://example.com/x' }),
      item(3, { title: '' }),
      null,
      42
    ]))
    ok(bad.length === 1 && bad[0].domain === 'site3.example.com', '非 http(s) 与坏条目被丢弃，标题回落到域名', bad)

    const many = m.cleanSearchSources(searchFile(Array.from({ length: 45 }, (_, i) => item(i))))
    ok(many.length === 30, '最多 30 条', many.length)

    const long = m.cleanSearchSources(searchFile([item(1, { snippet: 'x'.repeat(900) })]))
    ok(long[0].snippet.length <= 300, '摘要不超过 300 字', long[0].snippet.length)
    ok(long[0].snippet.endsWith('…'), '截断的摘要带省略号')

    const noSnippet = m.cleanSearchSources(searchFile([item(1, { snippet: undefined })]))
    ok(noSnippet[0].snippet === '', '没有摘要时是空串而不是 undefined', noSnippet[0].snippet)

    ok(m.cleanSearchSources(null).length === 0, 'null 数据返回空数组')
    ok(m.cleanSearchSources({ items: 'nope' }).length === 0, 'items 不是数组时返回空数组')
  }

  group('网页读取结果清洗与整体判定')
  {
    const page = m.cleanFetchPage({ url: 'https://example.com/a', finalUrl: 'https://www.example.com/a/', title: '示例标题', text: 'y'.repeat(800), truncated: true, totalChars: 800, via: 'local' })
    ok(page?.url === 'https://www.example.com/a/' && page.domain === 'example.com', '网页地址与域名正确', page)
    ok(page?.title === '示例标题', '标题保留')
    ok(page?.excerpt.length <= 300, '正文摘要不超过 300 字', page?.excerpt.length)
    ok(m.cleanFetchPage({ url: 'file:///etc/passwd' }) === null, '非 http(s) 网页不返回')
    ok(m.cleanFetchPage({}) === null, '没有网址不返回')

    const searchOp = m.cleanSearchOp(searchFile([item(1)]))
    ok(searchOp.ok === true && searchOp.kind === 'search' && searchOp.sources.length === 1, '查询结果判定为 search', searchOp)
    const emptyOp = m.cleanSearchOp(searchFile([]))
    ok(emptyOp.ok === true && emptyOp.kind === 'search' && emptyOp.sources.length === 0, '零结果仍判定为 search', emptyOp)
    const fetchOp = m.cleanSearchOp({ finalUrl: 'https://example.com/x', title: 't', text: 'body' })
    ok(fetchOp.ok === true && fetchOp.kind === 'fetch' && fetchOp.page.excerpt === 'body', '网页结果判定为 fetch', fetchOp)
    const truncated = m.cleanSearchOp({ truncated: true, bytes: 999, shape: { type: 'object' }, head: '{"items":[' })
    ok(truncated.ok === false && truncated.error === 'truncated', '被截断的结果文件判为失败（退回普通步骤）', truncated)
    const unknown = m.cleanSearchOp({ hello: 1 })
    ok(unknown.ok === false, '无法识别的数据结构判为失败', unknown)
  }

  group('结果文件读取：按 operationId 拼路径，不接受渲染端传路径')
  {
    const opsDir = resolve(OUT, 'ops')
    await mkdir(opsDir, { recursive: true })
    await writeFile(resolve(opsDir, `${OPERATION}.json`), JSON.stringify({ queries: [searchFile([item(1), item(2)])] }))
    const read = m.readSearchOpFile(opsDir, OPERATION)
    ok(read.ok === true && read.kind === 'search' && read.sources.length === 2, '按 operationId 读到多查询结果', read.ok)
    const upper = m.readSearchOpFile(opsDir, OPERATION.toUpperCase())
    ok(upper.ok === true, '大小写不同的 operationId 也能读到', upper.ok)
    ok(m.readSearchOpFile(opsDir, '../../package.json').ok === false, '非 UUID 一律拒绝（不能传路径）')
    ok(m.readSearchOpFile(opsDir, '..\\..\\package.json').ok === false, 'Windows 路径也被拒绝')
    const missing = m.readSearchOpFile(opsDir, '00000000-0000-4000-8000-000000000000')
    ok(missing.ok === false, '文件不存在时返回失败而不是抛错', missing)
  }

  group('步骤识别：从 bash 调用到搜索胶囊')
  {
    const call = (args, extra = {}) => ({ id: 'c1', name: 'bash', args, status: 'ok', ...extra })
    const done = m.searchStepOf(call({ command: 'yan search query --query-text "electron"' }, { output: JSON.stringify({ ok: true, operationId: OPERATION }) }))
    ok(done?.command.action === 'query' && done.operationId === OPERATION, '完成的搜索步骤拿到 operationId', done)
    ok(m.searchStepOf(call({ command: 'yan search query --query-text "electron"' }, { status: 'error' })) === null, '失败调用退回普通步骤')
    ok(m.searchStepOf(call({ command: 'yan search query --query-text "electron"' }, { denied: true })) === null, '被拒绝的调用退回普通步骤')
    ok(m.searchStepOf({ id: 'r', name: 'read', args: { command: 'yan search query --query-text "x"' }, status: 'ok' }) === null, '非 shell 工具不当作搜索步骤')
    ok(m.searchStepOf(call({ command: 'ls -la' })) === null, '普通命令不当作搜索步骤')
    ok(m.searchStepOf(call({ command: 'cd /tmp && yan search query --query-text "x"' })) !== null, '链式命令仍识别')

    const running = m.searchStepOf(call({ command: 'yan search fetch --url https://example.com/a' }, { status: 'running' }))
    ok(running?.command.action === 'fetch' && running.operationId === null, '运行中的 fetch 步骤能被识别', running)

    const ids = m.collectSearchOperationIds([
      call({ command: 'yan search query --query-text "a"' }, { id: 'a', output: JSON.stringify({ ok: true, operationId: OPERATION }) }),
      call({ command: 'yan search fetch --url https://example.com/a' }, { id: 'b', output: JSON.stringify({ ok: true, operationId: OPERATION }) }),
      call({ command: 'echo hi' }, { id: 'c' })
    ])
    ok(ids.length === 1 && ids[0] === OPERATION, '同一轮里重复的 operationId 只取一次', ids)

    const label = m.searchStepLabel({ action: 'query', queries: ['a', 'b'], url: '' })
    ok(label === 'a · b', '多个查询合并成一个标签', label)
    ok(m.searchStepLabel({ action: 'fetch', queries: [], url: 'https://example.com/a' }) === 'https://example.com/a', 'fetch 用网址作为标签')
  }

  group('只读子代理工具：web_search / web_fetch 带来源细节')
  {
    const readonly = await import(pathToFileURL(resolve(ROOT, 'resources/pi-extensions/readonly-tools.js')).href)
    const hostDir = resolve(OUT, 'host')
    await mkdir(hostDir, { recursive: true })
    const searchResult = resolve(hostDir, 'search.json')
    const fetchResult = resolve(hostDir, 'fetch.json')
    await writeFile(searchResult, JSON.stringify(searchFile(Array.from({ length: 20 }, (_, i) => item(i + 1, { content: `正文 ${i + 1}`.repeat(200), snippet: 'x'.repeat(900) })))))
    await writeFile(fetchResult, JSON.stringify({ url: 'https://example.com/a', finalUrl: 'https://www.example.com/a/', title: '示例页面', text: 'y'.repeat(1200) }))
    const originalFetch = globalThis.fetch
    const hostEnv = ['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']
    const savedEnv = Object.fromEntries(hostEnv.map((key) => [key, process.env[key]]))
    let seenCommand = ''
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      seenCommand = String(body.command ?? '')
      return { json: async () => ({ ok: true, summary: { kind: 'search', action: 'query' }, resultFile: body.command === 'search.fetch' ? fetchResult : searchResult }) }
    }
    Object.assign(process.env, { YAN_CLI_URL: 'http://127.0.0.1:1/host', YAN_CLI_TOKEN: 'token', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' })
    try {
      const searched = await readonly.WEB_SEARCH_TOOL.execute('t1', { query: 'electron 窗口' })
      ok(seenCommand === 'search.query', 'web_search 通过宿主 search.query 取数', seenCommand)
      const detail = searched.details?.search
      ok(detail?.action === 'query' && detail.query === 'electron 窗口', 'details.search 带动作与查询词', detail)
      ok(detail?.items?.length === 12, '来源细节最多 12 条', detail?.items?.length)
      ok(detail?.items?.every((entry) => entry.title && /^https:\/\//.test(entry.url)), '每条来源带标题与网址', detail?.items?.[0])
      ok(detail?.items?.every((entry) => Object.keys(entry).sort().join(',') === 'snippet,title,url'), '来源细节不含正文 content', detail?.items?.[0])
      ok(detail?.items?.every((entry) => entry.snippet.length <= 240), '摘要截到约 240 字', detail?.items?.[0]?.snippet?.length)
      ok(detail?.items?.[0]?.snippet?.endsWith('…'), '被截断的摘要带省略号', detail?.items?.[0]?.snippet)
      ok(searched.content?.[0]?.text?.includes('正文 1'), '给模型的文本仍包含正文，未被细节裁剪')
      ok(searched.details?.summary?.kind === 'search', '原有 summary 细节保持不变', searched.details?.summary)

      const fetched = await readonly.WEB_FETCH_TOOL.execute('t2', { url: 'https://example.com/a' })
      ok(seenCommand === 'search.fetch', 'web_fetch 通过宿主 search.fetch 取数', seenCommand)
      const pageDetail = fetched.details?.search
      ok(pageDetail?.action === 'fetch' && pageDetail.url === 'https://www.example.com/a/' && pageDetail.title === '示例页面', 'details.search 带读取的最终网址与标题', pageDetail)
      ok(!('content' in (pageDetail ?? {})) && !('text' in (pageDetail ?? {})), '网页细节不放正文', pageDetail)
      ok(fetched.content?.[0]?.text?.startsWith('# 示例页面'), '给模型的文本仍是原样网页文本', fetched.content?.[0]?.text?.slice(0, 20))

      ok((await readonly.WEB_SEARCH_TOOL.execute('t3', { query: '' })).details?.search === undefined, '缺查询词的失败调用不附来源细节')
      ok((await readonly.WEB_FETCH_TOOL.execute('t4', { url: 'file:///etc/passwd' })).details?.search === undefined, '非 http(s) 的失败调用不附来源细节')
    } finally {
      globalThis.fetch = originalFetch
      for (const key of hostEnv) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
    }
  }

  group('步骤识别：只读子代理的 web_search / web_fetch 直接成胶囊')
  {
    const details = { search: { action: 'query', query: 'electron', items: [item(1), item(2)] } }
    const searchCall = { id: 's1', name: 'web_search', args: { query: 'electron' }, status: 'ok', details }
    const step = m.searchStepOf(searchCall)
    ok(step?.fromTool === true && step.operationId === null, 'web_search 不依赖 operationId', step)
    ok(step?.command.action === 'query' && step.command.queries[0] === 'electron', '查询词来自 args.query', step?.command)
    ok(step?.sources?.length === 2, '来源直接取 call.details.search', step?.sources?.length)
    ok(step?.sources?.[0]?.domain === 'site1.example.com' && step.sources[0].title === '结果 1', '来源补上域名与标题', step?.sources?.[0])

    const fetchStep = m.searchStepOf({ id: 'f1', name: 'web_fetch', args: { url: 'https://example.com/a' }, status: 'ok', details: { search: { action: 'fetch', url: 'https://www.example.com/a/', title: '示例' } } })
    ok(fetchStep?.command.action === 'fetch' && fetchStep.command.url === 'https://example.com/a', 'web_fetch 目标是 args.url', fetchStep?.command)
    ok(fetchStep?.sources?.length === 1 && fetchStep.sources[0].domain === 'example.com', '网页来源带上域名', fetchStep?.sources)
    ok(fetchStep?.sources?.[0]?.title === '示例', '网页来源用细节里的标题', fetchStep?.sources?.[0])

    const legacy = m.searchStepOf({ id: 's2', name: 'web_search', args: { query: '旧记录' }, status: 'ok' })
    ok(legacy?.fromTool === true && legacy.sources === undefined, '旧记录没有 details 时仍识别为胶囊步骤', legacy)

    ok(m.searchStepOf({ id: 's3', name: 'web_search', args: {}, status: 'ok' }) === null, '没有查询词不算搜索步骤')
    ok(m.searchStepOf({ id: 'f2', name: 'web_fetch', args: { url: 'ftp://example.com/x' }, status: 'ok' }) === null, '非 http(s) 网址不算搜索步骤')
    ok(m.searchStepOf({ id: 's4', name: 'web_search', args: { query: 'x' }, status: 'error' }) === null, '失败的 web_search 退回普通步骤')
    ok(m.searchStepOf({ id: 's5', name: 'web_search', args: { query: 'x' }, status: 'ok', denied: true }) === null, '被拒绝的 web_search 退回普通步骤')

    const collected = m.collectSearchDetailSources([
      { id: 'a', name: 'web_search', args: { query: 'electron' }, status: 'ok', details },
      { id: 'b', name: 'bash', args: { command: 'echo hi' }, status: 'ok' }
    ])
    ok(collected.length === 2, '引用索引能收到 details 里的来源', collected.length)
  }

  group('细节来源解析：去重、过滤与上限')
  {
    const many = m.searchSourcesFromDetails({ search: { action: 'query', items: Array.from({ length: 40 }, (_, i) => item(i)) } })
    ok(many?.length === 12, '最多 12 条', many?.length)

    const deduped = m.searchSourcesFromDetails({ search: { action: 'query', items: [item(1), item(1, { url: item(1).url + '&utm_source=x' }), item(2)] } })
    ok(deduped?.length === 2, '同一网址（含 utm）只保留一条', deduped?.length)

    const filtered = m.searchSourcesFromDetails({ search: { action: 'query', items: [item(1, { url: 'javascript:alert(1)' }), { url: 'https://ok.example.com/x', title: '  ' }, null, 7] } })
    ok(filtered?.length === 1, '非 http(s) 与坏条目被丢弃', filtered)
    ok(filtered?.[0]?.title === 'ok.example.com', '标题为空时回落到域名', filtered?.[0])
    ok(filtered?.[0]?.snippet === '', '没有摘要时是空串', filtered?.[0]?.snippet)

    ok(m.searchSourcesFromDetails(null) === undefined, '没有 details 返回 undefined')
    ok(m.searchSourcesFromDetails({ summary: {} }) === undefined, 'details 里没有 search 返回 undefined')
    ok(m.searchSourcesFromDetails({ search: { action: 'docs', items: [item(1)] } }) === undefined, '非 query/fetch 动作返回 undefined')
    ok(m.searchSourcesFromDetails({ search: { action: 'fetch', url: 'file:///x' } }) === undefined, '网页细节网址非法返回 undefined')
    ok(m.searchSourcesFromDetails({ search: { action: 'fetch', url: 'https://example.com/a', title: '' } })?.[0]?.title === 'example.com', '网页标题为空时回落到域名')
  }

  group('组件渲染烟测：胶囊与引用标签能从真实组件输出')
  {
    installDomStubs()
    const view = await loadView()
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const renderWith = (node) => renderToStaticMarkup(createElement(view.I18nProvider, { lang: 'zh-CN' }, node))
    const call = (extra = {}) => ({ id: 'call-1', name: 'bash', args: { command: 'yan search query --query-text "electron WebContentsView"' }, status: 'running', ...extra })
    const step = { command: { action: 'query', queries: ['electron WebContentsView'], url: '' }, operationId: null }

    const runningHtml = renderWith(createElement(view.SearchStepView, { call: call(), step }, createElement('span', { id: 'plain' }, 'plain')))
    ok(runningHtml.includes('data-testid="ws-capsule"'), '运行中的搜索步骤渲染搜索胶囊', runningHtml.slice(0, 120))
    ok(runningHtml.includes('data-state="running"'), '胶囊标记为搜索中状态')
    ok(runningHtml.includes('ui-shimmer'), '搜索中标签带闪烁效果')
    ok(runningHtml.includes('electron WebContentsView'), '胶囊显示查询词')
    ok(runningHtml.includes('ws-ring-arc'), '运行中地球图标外圈有进度环')
    ok(!runningHtml.includes('id="plain"'), '有胶囊时不再渲染普通步骤')

    const fallbackHtml = renderWith(createElement(view.SearchStepView, { call: call({ status: 'ok', output: 'no json here' }), step }, createElement('span', { id: 'plain' }, 'plain')))
    ok(fallbackHtml.includes('id="plain"') && !fallbackHtml.includes('data-testid="ws-capsule"'), '拿不到 operationId 时退回普通步骤')

    const plain = createElement('span', { id: 'plain' }, 'plain')
    const searchCall = { id: 'w1', name: 'web_search', args: { query: 'electron 窗口' }, status: 'ok', details: { search: { action: 'query', query: 'electron 窗口', items: [item(1), item(2)] } } }
    const directHtml = renderWith(createElement(view.SearchStepView, { call: searchCall, step: m.searchStepOf(searchCall) }, plain))
    ok(directHtml.includes('data-testid="ws-capsule"') && !directHtml.includes('id="plain"'), 'web_search 完成后仍渲染胶囊', directHtml.slice(0, 120))
    ok(directHtml.includes('data-state="done"'), '完成的子代理搜索胶囊标记为完成')
    ok(directHtml.includes('已搜索 2 个网站'), '胶囊标签带来源数量', directHtml.slice(0, 400))
    ok(directHtml.includes('electron 窗口'), '胶囊显示查询词')
    ok(directHtml.includes('ws-cap-sites'), '胶囊显示来源站点头像')

    const legacyCall = { id: 'w2', name: 'web_search', args: { query: '旧记录' }, status: 'ok' }
    const legacyHtml = renderWith(createElement(view.SearchStepView, { call: legacyCall, step: m.searchStepOf(legacyCall) }, plain))
    ok(legacyHtml.includes('data-testid="ws-capsule"') && legacyHtml.includes('旧记录'), '没 details 的旧记录只留胶囊与查询词', legacyHtml.slice(0, 200))
    ok(legacyHtml.includes('已搜索') && !legacyHtml.includes('个网站'), '没 details 时不谎报来源数量', legacyHtml.slice(0, 400))
    ok(!legacyHtml.includes('ws-cap-sites') && !legacyHtml.includes('ui-shimmer'), '没 details 时不显示站点与闪烁')

    const fetchCall = { id: 'w3', name: 'web_fetch', args: { url: 'https://example.com/a' }, status: 'ok', details: { search: { action: 'fetch', url: 'https://example.com/a', title: '示例' } } }
    const fetchHtml = renderWith(createElement(view.SearchStepView, { call: fetchCall, step: m.searchStepOf(fetchCall) }, plain))
    ok(fetchHtml.includes('已读取网页') && fetchHtml.includes('https://example.com/a'), 'web_fetch 胶囊显示已读取与网址', fetchHtml.slice(0, 300))

    const citation = { n: 2, title: 'Milvus 3.0 发布', url: 'https://milvus.io/blog/announcing-milvus-3', domain: 'milvus.io', site: 'milvus', snippet: '向量检索引擎的新版本' }
    const citeHtml = renderWith(createElement(view.CitationLink, { citation }))
    ok(citeHtml.includes('ws-cite'), '引用渲染成行内引用标签', citeHtml.slice(0, 160))
    ok(citeHtml.includes('>milvus<'), '引用标签显示站点名')
    ok(citeHtml.includes('>2<'), '引用标签显示本轮编号')
    ok(citeHtml.includes('url=https://milvus.io/blog/announcing-milvus-3') || citeHtml.includes('href="https://milvus.io/blog/announcing-milvus-3"'), '引用保留可打开的链接')
  }

  process.stdout.write(`\n${fail === 0 ? '✓' : '✗'} web-search 视图纯函数：${pass} 通过 / ${fail} 失败\n`)
  if (fail) {
    process.stdout.write(`失败项：${failures.join('；')}\n`)
    process.exitCode = 1
  }
}

await rm(resolve(OUT, 'bundle.mjs'), { force: true })
await rm(resolve(OUT, 'bundle-view.mjs'), { force: true })
await run()
