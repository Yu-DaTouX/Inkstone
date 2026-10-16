#!/usr/bin/env node
/**
 * v3 内置浏览器「明确打开 + 异步归属守卫」回归。
 *
 * 用纯逻辑 + 内存桥（deferred 的 mock 正式桥）验证：
 *   · 用户点一次「打开浏览器」只调用一次宿主打开，成功后写状态并 reveal；
 *   · 打开失败保留可重试：释放本次认领，再点一次能成功；
 *   · A 打开途中切到 B 时，B 明确安全失败，不会并发导航同一个浏览器；
 *   · 旧回包不盖新的打开意图（同会话连点也算新意图）；
 *   · A 打开途中切走后，旧回包只记录全局状态，不把旧 view 重新 show 出来；
 *   · 资源已归 A 时，B 不能控制（复用既有 browserControlAllowed）。
 *
 * 不启动 Electron、不创建 WebContentsView、不访问网络、不读用户凭证。
 * 用法：node scripts/test-v3-browser-open.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const entry = [
  "export * from './src/renderer/src/features/browser/browser-open.ts'",
  "export * from './src/renderer/src/features/browser/ownership.ts'",
  "export * from './src/renderer/src/features/browser/browser-text.ts'"
].join('\n')

const built = await build({
  stdin: {
    contents: entry,
    resolveDir: ROOT,
    sourcefile: 'v3-browser-open-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)
const { BrowserOpener, browserControlAllowed, browserText } = mod

/* ------------------------------------------------------------------ 断言 */

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

/** 一个未决的宿主打开调用，模拟跨 IPC 的异步回包。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const browserState = (over = {}) => ({
  open: true,
  url: 'https://example.test/',
  title: 'Example',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over
})

/**
 * 内存桥：语义对齐 `resource-owners`（已有主人不覆盖）与正式 `window.yan.browser`。
 * `open` 返回未决 Promise，由测试自己决定何时 resolve / reject。
 */
function makeHarness() {
  const state = { resourceOwner: undefined, browserOpen: false, currentKey: 'A', browserState: null }
  const calls = { open: [], setBrowserState: [], reveal: 0, blocked: [], failed: [], released: 0 }
  const inflight = []
  const ports = {
    open: (url) => {
      calls.open.push(url)
      const d = deferred()
      inflight.push(d)
      return d.promise
    },
    currentOwnerKey: () => state.currentKey,
    resourceOwner: () => state.resourceOwner,
    claimResource: (owner) => {
      if (state.resourceOwner === undefined || state.resourceOwner === owner) state.resourceOwner = owner
      return state.resourceOwner
    },
    releaseResource: () => {
      state.resourceOwner = undefined
      calls.released += 1
    },
    isBrowserOpen: () => state.browserOpen,
    setBrowserState: (next) => {
      calls.setBrowserState.push(next)
      state.browserState = next
      state.browserOpen = next.open
    },
    reveal: () => {
      calls.reveal += 1
    },
    blocked: (reason) => calls.blocked.push(reason),
    failed: (message) => calls.failed.push(message)
  }
  return { state, calls, inflight, opener: new BrowserOpener(ports) }
}

/* ------------------------------------------------------ 明确打开 + 代次 */

group('用户点击：点一次只调用一次宿主打开，成功后写状态并 reveal')
{
  const h = makeHarness()
  const pending = h.opener.open({ owner: 'A', url: 'https://a.test/', guard: true })
  ok(h.calls.open.length === 1, '宿主 open 只被调用一次', h.calls.open)
  ok(h.calls.open[0] === 'https://a.test/', 'URL 原样交给宿主桥', h.calls.open[0])
  ok(h.state.resourceOwner === 'A', '打开前先认领到本会话')
  ok(h.calls.reveal === 0, '回包前不提前 reveal')

  h.inflight[0].resolve(browserState())
  await pending
  ok(h.calls.setBrowserState.length === 1, '成功后写回浏览器状态')
  ok(h.calls.reveal === 1, '成功后 reveal 一次')
  ok(h.calls.blocked.length === 0 && h.calls.failed.length === 0, '没有安全失败或报错')
}

group('打开失败保留可重试：释放本次认领，再点一次能成功')
{
  const h = makeHarness()
  const first = h.opener.open({ owner: 'A', guard: true })
  h.inflight[0].reject(new Error('Error invoking remote method: 只允许打开 http(s) 网页'))
  await first
  ok(h.calls.failed.length === 1, '失败上报一次')
  ok(h.calls.setBrowserState.length === 0 && h.calls.reveal === 0, '失败不写状态、不 reveal')
  ok(h.state.resourceOwner === undefined && h.calls.released === 1, '释放本次认领，不占着资源')

  const second = h.opener.open({ owner: 'A', guard: true })
  ok(h.calls.open.length === 2, '再次点击仍会调用宿主')
  h.inflight[1].resolve(browserState())
  await second
  ok(h.calls.setBrowserState.length === 1 && h.calls.reveal === 1, '重试成功后正常写状态并显示')
}

group('打开中的 owner 占用：A 在打开，B 明确安全失败，不并发导航')
{
  const h = makeHarness()
  const a = h.opener.open({ owner: 'A', guard: true })
  ok(h.state.resourceOwner === 'A' && h.calls.open.length === 1, 'A 已认领且正在打开（state.open 仍是 false）')

  h.state.currentKey = 'B'
  await h.opener.open({ owner: 'B', guard: true })
  ok(h.calls.open.length === 1, 'B 没有并发调用宿主 open', h.calls.open)
  ok(h.calls.blocked.length === 1 && h.calls.blocked[0] === 'opening-elsewhere', 'B 得到 opening-elsewhere 安全失败', h.calls.blocked)
  ok(h.state.resourceOwner === 'A', '资源仍归 A，B 没有抢走')

  h.inflight[0].resolve(browserState({ open: true }))
  await a
  ok(h.calls.setBrowserState.length === 1, 'A 的真实回包仍被记录为全局状态')
  ok(h.calls.reveal === 0, 'A 的回包不把旧 view 重新 show 出来（当前视图已是 B）')
  ok(h.state.resourceOwner === 'A', '资源仍在 A 名下，没有被误领给 B')
}

group('旧回包不盖新意图：同会话连点时只让最后一次说话')
{
  const h = makeHarness()
  const first = h.opener.open({ owner: 'A', url: 'https://first.test/', guard: true })
  const second = h.opener.open({ owner: 'A', url: 'https://second.test/', guard: true })
  ok(h.calls.open.length === 2, '两次点击各调用一次宿主')

  h.inflight[0].resolve(browserState({ url: 'https://first.test/' }))
  await first
  ok(h.calls.setBrowserState.length === 0, '过期的第一个回包不写状态', h.calls.setBrowserState)

  h.inflight[1].resolve(browserState({ url: 'https://second.test/' }))
  await second
  ok(h.calls.setBrowserState.length === 1, '最后一次回包写状态一次')
  ok(h.calls.setBrowserState[0].url === 'https://second.test/', '写入的是最后一次的 URL')
  ok(h.calls.reveal === 1, '只在最后意图上 reveal 一次')
}

group('已有 A 的资源：B 不能控制（复用既有归属判定）')
{
  const h = makeHarness()
  h.state.resourceOwner = 'A'
  h.state.browserOpen = true
  h.state.currentKey = 'B'
  await h.opener.open({ owner: 'B', guard: true })
  ok(h.calls.open.length === 0, 'B 不抢占已打开的 A 资源')
  ok(h.calls.blocked.length === 1 && h.calls.blocked[0] === 'foreign-owner', 'B 得到 foreign-owner 安全失败', h.calls.blocked)
  ok(h.state.resourceOwner === 'A', '资源主人没有被改写')

  const denied = browserControlAllowed({
    owner: { key: 'B', sessionId: 'b', cwd: '/w', active: true },
    visible: true,
    browserOpen: true,
    browserOwnerKey: 'A'
  })
  const allowed = browserControlAllowed({
    owner: { key: 'A', sessionId: 'a', cwd: '/w', active: true },
    visible: true,
    browserOpen: true,
    browserOwnerKey: 'A'
  })
  ok(denied === false, 'browserControlAllowed：资源归 A 时 B 不能控制')
  ok(allowed === true, 'browserControlAllowed：资源归 A 且 A 活动时可控制')
}

group('v2 向后兼容：不传 guard 时保持原路径')
{
  const h = makeHarness()
  h.state.resourceOwner = 'A'
  h.state.browserOpen = true
  const pending = h.opener.open({ owner: 'B', guard: false })
  ok(h.calls.blocked.length === 0, 'v2 不因资源归属而安全失败')
  ok(h.calls.open.length === 1, 'v2 仍会调用宿主打开')
  h.inflight[0].resolve(browserState())
  await pending
  ok(h.calls.setBrowserState.length === 1 && h.calls.reveal === 1, 'v2 成功后照旧写状态并 reveal')
}

group('文案：打开入口在两种语言都有')
{
  const zh = browserText('zh-CN')
  const en = browserText('en-US')
  ok(typeof zh.open === 'string' && zh.open.length > 0, '中文有「打开」按钮文案')
  ok(typeof zh.opening === 'string' && zh.opening.length > 0, '中文有「正在打开」文案')
  ok(typeof en.open === 'string' && en.open.length > 0, '英文有「打开」按钮文案')
  ok(en.open !== zh.open, '两种语言文案不同')
}

/* ---------------------------------------------------------------- 收尾 */

process.stdout.write(`\n${fail === 0 ? '✓' : '✗'} ${pass} 项通过，${fail} 项失败\n`)
assert.equal(fail, 0, '存在失败断言')
