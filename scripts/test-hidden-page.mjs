const ELECTRON_STUB = `
export class BrowserWindow {
  constructor() {
    this.destroyed = false
    this.webContents = {
      id: 1,
      setWindowOpenHandler() {},
      executeJavaScript: async () => {
        globalThis.__hiddenJsCalls = (globalThis.__hiddenJsCalls ?? 0) + 1
        return globalThis.__hiddenResult ?? { title: '', finalUrl: 'about:blank', text: '', state: 'loading' }
      }
    }
  }
  loadURL() { return Promise.resolve() }
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
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await mkdtemp(join(tmpdir(), 'yan-hidden-page-'))
  const { build } = await import('../node_modules/esbuild/lib/main.js')
  const plugins = [
    {
      name: 'hidden-page-stubs',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'hidden-stub' }))
        b.onResolve({ filter: /^node:dns\/promises$/ }, () => ({ path: 'dns', namespace: 'hidden-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'hidden-stub' }, (args) => ({
          contents: args.path === 'dns' ? DNS_STUB : ELECTRON_STUB,
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

  delete globalThis.__hiddenResult
  delete globalThis.__hiddenJsCalls
  delete globalThis.__hiddenBeforeRequest
  delete globalThis.__hiddenPartitions
}
