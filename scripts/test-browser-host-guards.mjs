import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const buildDir = join('.tmp', 'full-audit-1022', 'F6')
await mkdir(buildDir, { recursive: true })
const dir = await mkdtemp(join(buildDir, 'browser-guards-'))
try {
  const outfile = join(dir, 'guards.mjs')
  await build({
    stdin: {
      contents: [
        "export { ownedViewVisible, createStateFlush } from './src/main/browser/host-state'",
        "export { decideExternalRequest } from './src/main/browser/external-boundary'",
        "export { decideNavigationGuard } from './src/main/browser/navigation-guard'"
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const { ownedViewVisible, createStateFlush, decideExternalRequest, decideNavigationGuard } = await import(pathToFileURL(outfile).href)

  assert.equal(decideNavigationGuard(false, () => 'ask'), 'ask', '页面自己发起的跳转仍要问')
  assert.equal(decideNavigationGuard(false, () => 'deny'), 'block', '页面自己发起的跳转被拒时拦下')
  assert.equal(decideNavigationGuard(false, () => 'forbidden'), 'block', '不允许的地址直接拦下')
  assert.equal(decideNavigationGuard(false, () => 'allow'), 'pass', '已放行的站点直接过')
  let consulted = 0
  const counted = () => {
    consulted += 1
    return 'ask'
  }
  assert.equal(decideNavigationGuard(true, counted), 'pass', 'agent 发起的导航及其重定向不再过闸门')
  assert.equal(consulted, 0, 'agent 导航进行中不查闸门')
  assert.equal(decideNavigationGuard(false, counted), 'ask', '非 agent 导航仍查闸门')
  assert.equal(consulted, 1, '非 agent 导航查一次闸门')

  assert.equal(ownedViewVisible('tab-a', 'tab-a', true), true, '渲染端要求可见时只显示当前页签')
  assert.equal(ownedViewVisible('tab-a', 'tab-b', true), false, '非当前页签不显示')
  assert.equal(ownedViewVisible('tab-a', 'tab-a', false), false, '渲染端没要求可见时不抢显示')
  assert.equal(ownedViewVisible(null, 'tab-a', true), false, '没有当前页签时谁都不显示')

  let runs = 0
  const flush = createStateFlush(() => {
    runs += 1
  }, 20)
  flush.schedule()
  flush.schedule()
  flush.schedule()
  assert.equal(runs, 0, '合并窗口内不立即播发')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runs, 1, '连续多次 schedule 只播发一次')
  flush.schedule()
  flush.cancel()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(runs, 1, 'cancel 之后不再播发')

  const request = (overrides) =>
    decideExternalRequest({ url: 'https://example.com/a', resourceType: 'Script', pageUrl: 'https://example.com/', requestedByUs: false, ...overrides })
  assert.equal(request({}), 'check-dns', '公网目标仍需 DNS 复核')
  assert.equal(request({ url: 'http://127.0.0.1:8080/x' }), 'block-private', '页面发起的私网请求一律拦下')
  assert.equal(request({ url: 'http://169.254.169.254/latest' }), 'block-private', '链路本地（云元数据）一律拦下')
  assert.equal(
    request({ url: 'http://127.0.0.1:8080/x', resourceType: 'Document', requestedByUs: true }),
    'allow',
    '宿主自己要求打开的主文档放行'
  )
  assert.equal(
    request({ url: 'http://127.0.0.1:8080/x', pageUrl: 'http://localhost:5173/' }),
    'allow',
    '页面本身在回环地址时（本地开发）不拦子资源'
  )
  assert.equal(request({ url: 'chrome-extension://abc/x.js' }), 'allow', '非 http(s) 请求交回浏览器')

  console.log('test-browser-host-guards: 全部通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
