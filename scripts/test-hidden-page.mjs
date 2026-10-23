import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ELECTRON_STUB = `
export class BrowserWindow {
  constructor() {
    this.destroyed = false
    this.listeners = {}
    this.webContents = {
      id: 1,
      on: (event, listener) => { this.listeners[event] = listener },
      setWindowOpenHandler() {},
      executeJavaScript: async () => {
        globalThis.__hiddenJsCalls = (globalThis.__hiddenJsCalls ?? 0) + 1
        return globalThis.__hiddenResult ?? { title: '', finalUrl: 'about:blank', text: '', state: 'loading' }
      }
    }
  }
  loadURL(url) {
    this.listeners['did-navigate']?.({}, url, globalThis.__hiddenStatus ?? 200)
    return Promise.resolve()
  }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
export const session = {
  fromPartition(name) {
    globalThis.__hiddenPartitions = [...(globalThis.__hiddenPartitions ?? []), name]
    return { webRequest: { onBeforeRequest(callback) { globalThis.__hiddenBeforeRequest = callback } } }
  }
}
`
const DNS_STUB = `
export async function lookup() { return [{ address: '93.184.216.34', family: 4 }] }
`

export async function runHiddenPageTests(ok) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await mkdtemp(join(tmpdir(), 'yan-hidden-page-'))
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  try {
  const plugins = [
    {
      name: 'hidden-page-stubs',
      setup(b) {
        b.onResolve({ filter: /^fixture-real-boundary$/ }, () => ({ path: join(process.cwd(), 'src/main/browser/network-boundary.ts'), namespace: 'file' }))
        b.onResolve({ filter: /network-boundary$/ }, (args) => args.importer.endsWith('hidden-page.ts') ? { path: 'boundary', namespace: 'hidden-stub' } : undefined)
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'hidden-stub' }))
        b.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'hidden-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'hidden-stub' }, (args) => ({
          contents: args.path === 'boundary' ? `import { shouldBlockHiddenPageRequest as real } from 'fixture-real-boundary'; export async function shouldBlockHiddenPageRequest(...args) { if (globalThis.__hiddenBoundaryError) throw new Error('fixture boundary failure'); return real(...args) }` : args.path === 'dns' ? DNS_STUB : ELECTRON_STUB,
          loader: 'js'
        }))
      }
    }
  ]
  const bundle = async (entry, name) => {
    const outfile = join(temp, name)
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins })
    return import(pathToFileURL(outfile).href)
  }
  const hidden = await bundle('src/main/search/hidden-page.ts', 'hidden-page.mjs')
  const reader = await bundle('src/main/search/read-page.ts', 'read-page.mjs')

  {
    const controller = new AbortController()
    const started = Date.now()
    const waiting = hidden.sleepUnlessAborted(5_000, controller.signal)
    controller.abort()
    await waiting
    ok(Date.now() - started < 500, 'abort 后立即返回，不等满等待时长', `${Date.now() - started}ms`)

    const already = new AbortController()
    already.abort()
    const t2 = Date.now()
    await hidden.sleepUnlessAborted(5_000, already.signal)
    ok(Date.now() - t2 < 500, '已经取消的 signal 也立即返回（addEventListener 不会再触发）', `${Date.now() - t2}ms`)
  }

  {
    let aborted = false
    let thrown = null
    await hidden
      .withHiddenPage(300, async (_win, signal) => {
        for (;;) {
          if (signal.aborted) {
            aborted = true
            return 'stopped'
          }
          await hidden.sleepUnlessAborted(50, signal)
        }
      })
      .catch((error) => {
        thrown = error
      })
    ok(thrown instanceof hidden.HiddenPageTimeout, '超时以 HiddenPageTimeout 抛出', thrown?.message ?? '没有抛出')
    ok(aborted, '超时后把 signal 置为已取消：轮询才有机会退出')
  }

  {
    const external = new AbortController()
    let stopped = false
    const pending = hidden.withHiddenPage(5000, async (_win, signal) => {
      await hidden.sleepUnlessAborted(5000, signal)
      stopped = signal.aborted
    }, external.signal)
    external.abort()
    const error = await pending.catch(e => e)
    ok(error instanceof hidden.HiddenPageCancelled, '外部取消以 HiddenPageCancelled 抛出')
    ok(stopped, '外部取消同时结束任务中的等待')
    ok(globalThis.__hiddenBeforeRequest === null, '外部取消后注销拦截')
  }

  {
    globalThis.__hiddenJsCalls = 0
    globalThis.__hiddenResult = { title: '', finalUrl: 'https://example.com/a', text: '', state: 'loading' }
    const result = await reader.readPage('https://example.com/a', { timeoutMs: 3_000 }).catch((error) => error)
    ok(
      result instanceof reader.ReadPageError && result.code === 'timeout',
      '一直没有正文时按超时上报',
      result?.code ?? String(result)
    )
    const callsAtTimeout = globalThis.__hiddenJsCalls
    ok(callsAtTimeout > 0, '超时前确实在轮询', String(callsAtTimeout))
    await new Promise((r) => setTimeout(r, 700))
    ok(
      globalThis.__hiddenJsCalls === callsAtTimeout,
      '**超时后不再继续轮询**（旧实现会一直每 400ms 读一次已销毁的窗口）',
      `${callsAtTimeout} → ${globalThis.__hiddenJsCalls}`
    )
  }

  {
    const decide = (url) =>
      new Promise((resolve) => {
        const callback = globalThis.__hiddenBeforeRequest
        if (!callback) return resolve(null)
        callback({ url }, (result) => resolve(result.cancel === true))
      })
    await hidden.withHiddenPage(5_000, async () => {
      ok(typeof globalThis.__hiddenBeforeRequest === 'function', '隐藏页面注册了 webRequest 拦截')
      ok((await decide('https://example.com/article')) === false, '解析到公网的域名放行')
      ok((await decide('http://127.0.0.1:8080/x')) === true, '字面回环地址直接拦')
      ok((await decide('http://169.254.169.254/latest/meta-data/')) === true, '云 metadata 地址拦')
      ok((await decide('about:blank')) === false, 'about: 不当网络请求判')
      globalThis.__hiddenBoundaryError = true
      try {
        ok((await decide('https://example.com/error')) === true, '请求边界异常 fail closed')
      } finally {
        delete globalThis.__hiddenBoundaryError
      }
    })
    ok(globalThis.__hiddenBeforeRequest === null, '隐藏页结束后注销 webRequest 监听（不累积）')
  }

  {
    globalThis.__hiddenPartitions = []
    await hidden.withHiddenPage(5_000, async () => 'a')
    await hidden.withHiddenPage(5_000, async () => 'b')
    const partitions = globalThis.__hiddenPartitions ?? []
    ok(partitions.length > 0 && new Set(partitions).size === 1, '多次隐藏页搜索复用同一个 in-memory session（不按次新建 partition）', partitions.join(','))
  }

  {
    globalThis.__hiddenBeforeRequest = null
    let installedWhileSecondRunning = false
    const first = hidden.withHiddenPage(5_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    const second = hidden.withHiddenPage(5_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      installedWhileSecondRunning = typeof globalThis.__hiddenBeforeRequest === 'function'
    })
    await Promise.all([first, second])
    ok(installedWhileSecondRunning, '并发隐藏页共用 session 时，先结束的那个不会注销别人的拦截')
    ok(globalThis.__hiddenBeforeRequest === null, '并发隐藏页全部结束后才注销拦截')
  }

  {
    for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'https://user:pass@example.com/', 'https://user@example.com/', 'http://localhost/', 'http://10.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/']) {
      let error
      try { reader.normalizeReadUrl(url) } catch (e) { error = e }
      ok(error instanceof reader.ReadPageError, `拒绝不安全 URL: ${url}`)
    }
    ok(reader.normalizeReadUrl(' https://example.com/article ') === 'https://example.com/article', '公网 URL 规范化')
    const page = { url: 'https://example.com/a', finalUrl: 'https://example.com/a', title: 'Short news', text: 'A real short article.', totalChars: 21, truncated: false }
    ok(reader.assertReadablePage(page) === page, '短真实文章不因长度被拒绝')
    for (const [title, text, code] of [['Article', '  ', 'empty_content'], ['Just a moment...', 'Cloudflare checking your browser captcha', 'access_blocked'], ['安全验证', '请完成验证', 'access_blocked']]) {
      let error
      try { reader.assertReadablePage({ ...page, title, text }) } catch (e) { error = e }
      ok(error?.code === code, `正文校验 ${code}: ${title}`)
    }
    globalThis.__hiddenResult = { ...page, state: 'complete' }
    ok((await reader.readPage(page.url)).text === page.text, '实际 readPage 允许短文章')
    for (const status of [403, 429, 500]) {
      globalThis.__hiddenStatus = status
      const error = await reader.readPage(page.url).catch(e => e)
      ok(error.code === 'http_error', `HTTP ${status} 不返回正文`)
    }
    delete globalThis.__hiddenStatus
    globalThis.__hiddenResult = { ...page, title: 'Just a moment...', text: 'Cloudflare captcha verification', state: 'complete' }
    ok((await reader.readPage(page.url).catch(e => e)).code === 'access_blocked', '实际 readPage 拒绝验证页')
    globalThis.__hiddenResult = { ...page, finalUrl: 'https://user:pass@example.com/', state: 'complete' }
    ok((await reader.readPage(page.url).catch(e => e)).code === 'bad_url', '重定向后仍校验 URL')
  }

  } finally {
    for (const key of ['__hiddenResult', '__hiddenJsCalls', '__hiddenBeforeRequest', '__hiddenPartitions', '__hiddenStatus', '__hiddenBoundaryError']) delete globalThis[key]
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let count = 0
  await runHiddenPageTests((condition, label, detail) => { assert.ok(condition, `${label}: ${detail ?? ''}`); count++ })
  console.log(`hidden-page: ${count} assertions passed (offline)`)
}
