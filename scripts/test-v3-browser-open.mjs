#!/usr/bin/env node
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const entry = [
  "export * from './src/renderer/src/features/browser/browser-open.ts'",
  "export * from './src/renderer/src/features/browser/ownership.ts'",
  "export * from './src/renderer/src/features/browser/browser-text.ts'",
  "export { useStore } from './src/renderer/src/state/store.ts'",
  "export { useUiV3 } from './src/renderer/src/state/ui-v3.ts'",
  "export { releaseResource, claimResource, resourceOwner } from './src/renderer/src/state/resource-owners.ts'"
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
  format: 'esm',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' }
})
globalThis.document = { documentElement: { lang: 'zh-CN' }, querySelector: () => null }
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)
const { BrowserOpener, browserControlAllowed, browserText, useStore, useUiV3, releaseResource, claimResource, resourceOwner } = mod

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

group('用户明确打开：旧归属可转交，进行中的打开不可抢占')
{
  const h = makeHarness()
  h.state.resourceOwner = 'old-session'
  h.state.browserOpen = true
  const pending = h.opener.open({ owner: 'A', guard: true, takeover: true })
  ok(h.calls.open.length === 1, '旧归属不再拦截用户的明确打开')
  ok(h.state.resourceOwner === 'old-session', '宿主确认前不改旧归属')
  h.state.currentKey = 'B'
  await h.opener.open({ owner: 'B', guard: true, takeover: true })
  ok(h.calls.open.length === 1 && h.calls.blocked[0] === 'opening-elsewhere', '另一个会话不能抢进行中的用户导航')
  h.state.currentKey = 'A'
  h.inflight[0].resolve(browserState({ agentSessionId: undefined }))
  await pending
  ok(h.state.resourceOwner === 'A' && h.calls.reveal === 1, '成功后归属转到点击者，面板可操作')

  h.state.resourceOwner = 'old-session'
  const failed = h.opener.open({ owner: 'A', guard: true, takeover: true })
  h.inflight[1].reject(new Error('浏览器正在执行操作'))
  await failed
  ok(h.state.resourceOwner === 'old-session', '宿主拒绝时保留原归属')
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

group('消息链接：成功加载后前台显示浏览器，拒绝及切换会话不抢焦点')
{
  const initial = useStore.getInitialState()
  const uiInitial = useUiV3.getInitialState()
  const calls = []
  let gate = async () => ({ decision: 'allow' })
  let pendingOpen = null
  window.yan = {
    browser: {
      siteAccess: (...args) => gate(...args),
      open: async (url) => {
        calls.push(url)
        return pendingOpen ? pendingOpen.promise : browserState({ url })
      },
      setVisible: async () => {}
    }
  }
  const reset = () => {
    releaseResource('browser')
    calls.length = 0
    pendingOpen = null
    gate = async () => ({ decision: 'allow' })
    useStore.setState({ ...initial, session: { sessionId: 'A', conversationId: 'A' }, settings: { rightPanelOpen: true } })
    useUiV3.setState({ ...uiInitial, workspaceOpen: false, workspaceTab: 'files', workspacePanes: [] })
  }
  reset()
  await useStore.getState().openLink('https://www.google.com/')
  ok(calls.length === 1, '消息链接确实加载网页')
  ok(useUiV3.getState().workspaceTab === 'browser', '自动选中浏览器而非留在其他面板')
  ok(useUiV3.getState().workspaceOpen, '收起的工作区自动展开')

  reset()
  claimResource('browser', 'expired-conversation')
  useStore.setState({ browserState: browserState({ agentSessionId: 'old-session' }) })
  await useStore.getState().openLink('https://new.test/')
  ok(calls.length === 1 && useUiV3.getState().workspaceOpen, '聊天链接能打开已被旧会话认领的浏览器')
  ok(resourceOwner('browser') === 'A', '链接打开后面板归属同步到当前会话')
  ok(useStore.getState().browserState.agentSessionId === undefined, '用户打开后的状态不残留旧 Agent 归属')

  reset()
  gate = async () => ({ decision: 'deny' })
  await useStore.getState().openLink('https://blocked.test/')
  ok(calls.length === 0 && !useUiV3.getState().workspaceOpen, '权限拒绝不加载、不显示面板')

  reset()
  const approval = deferred()
  gate = () => approval.promise
  const approving = useStore.getState().openLink('https://old.test/')
  useStore.setState({ session: { sessionId: 'B', conversationId: 'B' } })
  approval.resolve({ decision: 'allow' })
  await approving
  ok(calls.length === 0 && !useUiV3.getState().workspaceOpen, '等待权限期间切换会话不打开旧链接')

  reset()
  pendingOpen = deferred()
  const loading = useStore.getState().openLink('https://slow.test/')
  await Promise.resolve()
  ok(calls.length === 1, '切换前网页已开始加载')
  useStore.setState({ session: { sessionId: 'B', conversationId: 'B' } })
  pendingOpen.resolve(browserState())
  await loading
  ok(!useUiV3.getState().workspaceOpen, '加载期间切换会话后不抢新会话前台')
  releaseResource('browser')
  useStore.setState(initial)
  useUiV3.setState(uiInitial)
}

process.stdout.write(`\n${fail === 0 ? '✓' : '✗'} ${pass} 项通过，${fail} 项失败\n`)
assert.equal(fail, 0, '存在失败断言')
