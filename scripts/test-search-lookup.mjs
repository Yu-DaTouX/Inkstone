import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export async function runSearchLookupTests(ok) {
  const temp = await mkdtemp(join(tmpdir(), 'inkstone-lookup-'))
  const state = { calls: [], keys: false, localCost: 0, remoteCost: 0, text: 'Real article. '.repeat(30), title: 'Article', empty: false }
  globalThis.__lookupFixture = state
  const stubs = {
    './capability-server': `export class CapabilityCommandError extends Error { constructor(code, message) { super(message); this.code = code } }`,
    './personal-memory': `export const memoryStoreOf = () => { throw Error('unexpected memory access') }`,
    './project-memory-store': `export const commitKnowledge = fail, listKnowledge = fail, readKnowledge = fail; function fail() { throw Error('unexpected memory access') }`,
    './search/config': `export const resolveSearchKey = async () => globalThis.__lookupFixture.keys ? 'fixture-key' : ''; export const searchApiConfig = async () => ({ hintDismissed: true })`,
    './search/opencli': `export const createOpencliRunner = () => () => { throw Error('unexpected adapter') }; export const searchDoctor = () => { throw Error('unexpected doctor') }; export const searchSummary = () => 'fixture'; export async function runSearch(input) { const s = globalThis.__lookupFixture; s.calls.push(['query', input]); await Promise.resolve(); return { query: input.text, items: s.empty ? [] : [{ title: 'Article', url: 'https://example.com/a' }], sources: [{ source: 'ddg', status: s.empty ? 'empty' : 'ok', count: s.empty ? 0 : 1 }], truncated: false, durationMs: 0 } }`,
    './search/firecrawl': `export async function firecrawlReadPage(url, opts) { const s = globalThis.__lookupFixture; s.calls.push(['firecrawl', opts]); s.advance(s.remoteCost); return { url, finalUrl: url, title: s.remoteTitle ?? 'Article', text: s.remoteText ?? '', totalChars: 0, truncated: false } }`,
    './search/deepseek': `export const resolveDeepseekSearchKey = async () => globalThis.__lookupFixture.keys ? 'fixture-key' : ''; export const deepseekHasBalance = async () => true; export const runFundedDeepseekSearch = () => { throw Error('unexpected search') }; export async function fundedDeepseekReadPage(url, opts) { const s = globalThis.__lookupFixture; s.calls.push(['deepseek', opts]); return { url, finalUrl: url, title: 'Article', text: 'Fallback real article', totalChars: 21, truncated: false } }`,
    './search/context7': `export class DocsError extends Error {}; export const queryDocs = () => { throw Error('unexpected docs') }`
  }
  for (const [module, name] of [['brave', 'Brave'], ['tavily', 'Tavily'], ['ddg', 'Ddg']]) stubs[`./search/${module}`] = `export const run${name}Search = () => { throw Error('unexpected provider') }`
  const electron = `export class BrowserWindow { constructor() { this.dead = false; this.listeners = {}; this.webContents = { on: (name, cb) => { this.listeners[name] = cb }, setWindowOpenHandler() {}, executeJavaScript: async () => { const s = globalThis.__lookupFixture; return { title: s.title, finalUrl: 'https://example.com/a', text: s.text, state: 'complete' } } } } loadURL(url) { const s = globalThis.__lookupFixture; s.calls.push(['local', url]); s.advance(s.localCost); this.listeners['did-navigate']?.({}, url, 200); return Promise.resolve() } isDestroyed() { return this.dead } destroy() { this.dead = true } }; export const session = { fromPartition: () => ({ webRequest: { onBeforeRequest() {} } }) }`
  const originalNow = Date.now
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  state.timers = []
  globalThis.setTimeout = (fn, ms, ...args) => { state.timers.push(ms); return originalSetTimeout(fn, ms, ...args) }
  let now = 1000
  Date.now = () => now
  state.advance = ms => { now += ms }
  globalThis.fetch = () => { throw Error('real network forbidden') }
  try {
    const outfile = join(temp, 'fixture.mjs')
    await build({ stdin: { contents: `export { LookupCommands } from './src/main/lookup-commands'; export { TtlCache } from './src/main/search/plan'`, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'offline', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (args.path === 'electron') return { path: 'electron', namespace: 'fixture' }
        if (args.path === 'node:dns/promises') return { path: 'dns', namespace: 'fixture' }
        if (args.importer.endsWith('lookup-commands.ts') && Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'fixture' }
      })
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'electron' ? electron : args.path === 'dns' ? `export const lookup = async () => { throw Error('real DNS forbidden') }` : stubs[args.path], loader: 'js' }))
    } }] })
    const { LookupCommands, TtlCache } = await import(pathToFileURL(outfile).href)
    const eq = (actual, expected, label) => ok(JSON.stringify(actual) === JSON.stringify(expected), label, JSON.stringify({ actual, expected }))
    let loads = 0
    const cache = new TtlCache(100, 2, () => now)
    const load = async () => ++loads
    const concurrent = await Promise.all([cache.getOrLoad('a', load), cache.getOrLoad('a', load)])
    eq(concurrent.map(r => r.value), [1, 1], 'TtlCache 同键并发合并')
    eq(loads, 1, 'TtlCache loader 只执行一次')
    eq((await cache.getOrLoad('a', load)).cached, true, 'TTL 内命中')
    now += 101
    eq((await cache.getOrLoad('a', load)).value, 2, 'TTL 到期重载')
    eq((await cache.getOrLoad('a', load, { refresh: true })).value, 3, 'refresh 跳过缓存')
    const failures = await Promise.allSettled([cache.getOrLoad('bad', async () => { throw Error('fixture') }), cache.getOrLoad('bad', load)])
    eq(failures.map(r => r.status), ['rejected', 'rejected'], '并发失败共享同一拒绝结果')
    eq((await cache.getOrLoad('bad', load)).value, 4, '失败清理 pending 并可重试')
    await cache.getOrLoad('reject', load, { accept: () => false })
    eq(cache.get('reject'), undefined, 'accept=false 不缓存')
    const fresh = () => new LookupCommands({ cwd: () => temp, capabilityOpts: () => undefined })
    const query = { query: 'fixture', sources: 'ddg' }
    let lookup = fresh()
    state.calls = []
    await Promise.all([lookup.runSearchCommand('query', query), lookup.runSearchCommand('query', query)])
    eq(state.calls.length, 1, 'query 同键并发合并')
    eq((await lookup.runSearchCommand('query', query)).summary.cached, true, 'query 缓存命中')
    await lookup.runSearchCommand('query', { ...query, refresh: 'true' })
    eq(state.calls.length, 2, 'query refresh 透传缓存层')
    now += 600001
    await lookup.runSearchCommand('query', query)
    eq(state.calls.length, 3, 'query 10 分钟后失效')
    state.empty = true
    lookup = fresh(); state.calls = []
    await lookup.runSearchCommand('query', query); await lookup.runSearchCommand('query', query)
    eq(state.calls.length, 2, '空搜索结果不缓存')
    state.empty = false
    const fetch = { url: 'https://example.com/a', via: 'local' }
    lookup = fresh(); state.calls = []
    await Promise.all([lookup.runSearchCommand('fetch', fetch), lookup.runSearchCommand('fetch', fetch)])
    eq(state.calls.length, 1, 'fetch 同键并发合并')
    eq((await lookup.runSearchCommand('fetch', fetch)).data.cached, true, 'fetch 缓存命中')
    await lookup.runSearchCommand('fetch', { ...fetch, refresh: true })
    eq(state.calls.length, 2, 'fetch refresh 透传缓存层')
    now += 600001
    await lookup.runSearchCommand('fetch', fetch)
    eq(state.calls.length, 3, 'fetch 10 分钟后失效')
    for (const [title, text, code] of [['Just a moment...', 'Cloudflare captcha verification', 'search_fetch_access_blocked'], ['Article', ' ', 'search_fetch_empty_content']]) {
      state.remoteTitle = title; state.remoteText = text; state.calls = []; lookup = fresh()
      for (let i = 0; i < 2; i++) {
        const error = await lookup.runSearchCommand('fetch', { url: fetch.url, via: 'firecrawl' }).catch(e => e)
        eq(error.code, code, '远端空/验证页被真实 assertReadablePage 拒绝')
      }
      eq(state.calls.length, 2, '失败正文不缓存')
    }
    state.title = 'Article'; state.text = 'Short real article'; state.keys = true; state.remoteTitle = 'Article'; state.remoteText = ''; state.remoteCost = 4000; state.localCost = 7000
    for (const budget of [undefined, 18000]) {
      lookup = fresh(); state.calls = []; state.timers = []
      const result = await lookup.runSearchCommand('fetch', { url: fetch.url, ...(budget ? { 'timeout-ms': budget } : {}) })
      eq(state.timers[0], Math.min(20000, budget ?? 30000), '本地阶段受总预算约束且至多 20 秒')
      eq(result.data.via, 'deepseek', '远端空正文继续下一兜底')
      eq(state.calls.map(c => c[0]), ['local', 'firecrawl', 'deepseek'], '真实本地 reader 与两级远端按序执行')
      eq(state.calls[1][1].timeoutMs, (budget ?? 30000) - 7000, '首个远端只得总预算剩余时间')
      eq(state.calls[2][1].timeoutMs, (budget ?? 30000) - 11000, '下个远端共用同一 deadline')
    }
    state.localCost = 26000; lookup = fresh(); state.calls = []
    const result = await lookup.runSearchCommand('fetch', { url: fetch.url })
    eq(result.data.via, 'local', '预算不足保留短真实文章')
    eq(state.calls.map(c => c[0]), ['local'], '剩余不足 5 秒不再请求远端')
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    delete globalThis.__lookupFixture
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let count = 0
  await runSearchLookupTests((condition, label, detail) => { assert.ok(condition, `${label}: ${detail ?? ''}`); count++ })
  console.log(`search-lookup: ${count} assertions passed (offline)`)
}
