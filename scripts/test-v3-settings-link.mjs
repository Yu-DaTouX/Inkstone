#!/usr/bin/env node
/**
 * v3 设置深链接回归（重复请求被吞）。
 *
 * 目的：不用源码字符串断言，而是把**真实渲染端 store** + **真实生产
 * `deep-link.ts` 订阅**现场 esbuild 出来，用真实 `openSettings` 动作驱动，
 * 钉住「同一页重复打开也能导航」这一族缺陷：
 *
 *   · auth 打开 → 返回聊天 → 同页 auth 再次能打开；
 *   · 设置内手动选外观后，同一 auth 请求仍重选模型页；
 *   · 同一毫秒两次请求都通知（靠 revision 区分）；
 *   · 无关 store / 流事件不触发、不重置当前页；
 *   · closeSettings 不导航；
 *   · 动作 revision 单调递增，且保留 v2 其余状态。
 *
 * 用法：node scripts/test-v3-settings-link.mjs
 * 不启动 Electron、不连 pi、不读用户数据、不调用真实模型。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

/* ------------------------------------------------------------------ 断言 */

const report = { pass: 0, fail: 0 }
let groupName = ''

function group(name) {
  groupName = name
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const mark = pass ? '  ✓' : '  ✗'
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${mark} ${label}${extra}\n`)
  return pass
}

/* -------------------------------------------------------------- 全局桩 */

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  globalThis.requestAnimationFrame = (fn) => {
    try {
      fn(0)
    } catch {
      /* 无真实帧 */
    }
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { hash: '', href: 'http://localhost/' },
    history: { replaceState: () => {} },
    /* openSettings 会经 applyBrowserVisibility 调它；测试里只是空实现 */
    yan: { browser: { setVisible: () => {} } }
  }
}

/* ------------------------------------------------------------ bundle 入口 */

/** zustand 5 只用到 `useSyncExternalStore`；ui-v3 用到 `useEffect`。 */
const REACT_SHIM = `export function useState(init) { return [typeof init === 'function' ? init() : init, () => {}] }
export function useEffect() {}
export function useLayoutEffect() {}
export function useRef(init) { return { current: init } }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() }
export function useContext() { return null }
export function createContext(value) { return { __value: value, Provider: (p) => (p ? p.children : null) } }
export default { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useContext, createContext }
`

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  const entry = join(outdir, 'settings-link-entry.ts')
  await writeFile(
    entry,
    `export { useStore } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'
export { useUiV3 } from '${posix(resolve(ROOT, 'src/renderer/src/state/ui-v3'))}'
export { installSettingsDeepLink, resetSettingsDeepLinkForTest, subscribeSettingsRequest, getSettingsRequest } from '${posix(resolve(ROOT, 'src/renderer/src/features/settings/root/deep-link'))}'
export { resolveLegacyView } from '${posix(resolve(ROOT, 'src/renderer/src/features/settings/types'))}'
`
  )
  const out = join(outdir, 'settings-link-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    alias: { react: reactShim },
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'process.env.NODE_ENV': '"production"',
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    },
    loader: { '.css': 'empty' }
  })
  return out
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  installGlobals()

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-settings-link-'))
  let bundle
  try {
    bundle = await import(pathToFileURL(await buildBundle(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { useStore, useUiV3, installSettingsDeepLink, resetSettingsDeepLinkForTest, subscribeSettingsRequest, getSettingsRequest, resolveLegacyView } = bundle

  /* 基线 v2 状态，用来验证「无关推送不触发」和「保留其余状态」。 */
  const baseline = () => ({
    settings: { cwd: 'C:/proj', projects: [] },
    settingsOpen: false,
    settingsTab: 'appearance',
    settingsRequestRevision: 0,
    messages: [{ id: 'm1', role: 'user', text: 'hi' }],
    sessions: [{ path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' }],
    notices: [],
    browserNativeVisible: false
  })

  function reset() {
    resetSettingsDeepLinkForTest()
    useStore.setState(baseline())
    useUiV3.setState({ route: { name: 'chat' }, back: [] })
    installSettingsDeepLink()
  }

  function collect() {
    const seen = []
    const unsub = subscribeSettingsRequest(() => seen.push(getSettingsRequest()))
    return { seen, unsub }
  }

  const openSettings = (tab) => useStore.getState().openSettings(tab)
  const closeSettings = () => useStore.getState().closeSettings()
  const route = () => useUiV3.getState().route.name

  /* ============================================================ 组 1 */
  group('auth 打开 → 返聊天 → 同页 auth 再次打开')
  {
    reset()
    const { seen } = collect()
    openSettings('auth')
    ok(seen.length === 1 && seen[0].view === 'auth', '第一次 auth 请求被记录', seen)
    ok(route() === 'settings', '第一次请求把路由切到设置')
    ok(seen[0].revision === 1, '第一次请求 revision = 1', seen[0])

    useUiV3.getState().navigate({ name: 'chat' })
    ok(route() === 'chat', '返回聊天（settingsOpen 仍为 true）')
    ok(useStore.getState().settingsOpen === true, 'v3 返聊天不 closeSettings，字段保持 true')

    openSettings('auth')
    ok(seen.length === 2, '同一页 auth 再次请求仍然通知（不是被吞）', seen.length)
    ok(seen[1] !== seen[0], '第二次是一个新请求对象')
    ok(seen[1].view === 'auth' && seen[1].revision === 2, '第二次 auth revision = 2', seen[1])
    ok(route() === 'settings', '第二次请求把路由重新切回设置')
  }

  /* ============================================================ 组 2 */
  group('设置内手动选外观后，同一 auth 请求重选模型页')
  {
    reset()
    const { seen } = collect()
    openSettings('appearance')
    openSettings('auth')
    ok(seen[1].view === 'auth', 'auth 请求映射到模型页', seen[1])
    /* 用户在设置内手动点「外观」：只改面板本地状态，不动 store.settingsTab */
    ok(useStore.getState().settingsTab === 'auth', '手动选外观不改 store.settingsTab', useStore.getState().settingsTab)

    openSettings('auth')
    ok(seen.length === 3, '手动切页后同一 auth 再次调用仍产生新请求', seen.length)
    ok(seen[2].revision === 3 && seen[2] !== seen[1], '新请求 revision = 3 且对象不同', seen[2])
    ok(
      resolveLegacyView(seen[2].view).kind === 'section' && resolveLegacyView(seen[2].view).section === 'models',
      '消费该请求会重新解析到模型分区 models',
      resolveLegacyView(seen[2].view)
    )
    ok(
      resolveLegacyView(seen[0].view).section === 'appearance',
      '此前的外观请求映射到 appearance（不是把每次请求都当成 models）'
    )
  }

  /* ============================================================ 组 3 */
  group('同一毫秒的两次请求都通知，靠 revision 区分')
  {
    reset()
    const { seen } = collect()
    const at = Date.now
    /* 固定时钟：两次记录拿到同一个毫秒，只有 revision 能把它们区分开 */
    Date.now = () => at.call(Date)
    try {
      openSettings('auth')
      openSettings('auth')
    } finally {
      Date.now = at
    }
    ok(seen.length === 2, '同毫秒两次请求各通知一次', seen.length)
    ok(seen[0].at === seen[1].at, '两次的 at 确实相同（同毫秒）', [seen[0].at, seen[1].at])
    ok(seen[0].revision !== seen[1].revision, '两次 revision 不同', [seen[0].revision, seen[1].revision])
    ok(seen[0] !== seen[1], '快照对象不同，useSyncExternalStore 能感知变化')
  }

  /* ============================================================ 组 4 */
  group('无关 store / 流事件不触发、不重置当前页')
  {
    reset()
    const { seen } = collect()
    openSettings('auth')
    const recorded = getSettingsRequest()
    ok(seen.length === 1, '基线：auth 请求记录一次', seen.length)

    useStore.setState({ messages: [{ id: 'm2', role: 'assistant', text: '流式输出' }] })
    useStore.setState({ notices: [{ id: 'n1', text: '无关提示' }] })
    useStore.setState({ settings: { cwd: 'C:/other', projects: [] } })
    useStore.setState({ browserNativeVisible: true })
    ok(seen.length === 1, '无关 store / 设置推送都不产生新请求', seen.length)
    ok(getSettingsRequest() === recorded, '当前请求对象未被无关推送重置')
    ok(route() === 'settings', '当前页仍是设置，没有被弹回聊天')

    /* 冗余写同一个 revision（模拟同步重入 / 幂等 set）：不重复记录 */
    useStore.setState({ settingsRequestRevision: useStore.getState().settingsRequestRevision })
    ok(seen.length === 1, '重复写同一 revision 不重复记录（订阅重入去重）', seen.length)
  }

  /* ============================================================ 组 5 */
  group('closeSettings 不导航；直接写字段的旧调用兼容')
  {
    reset()
    const { seen } = collect()
    openSettings('appearance')
    ok(route() === 'settings', '打开后位于设置路由')
    useUiV3.getState().navigate({ name: 'chat' })
    closeSettings()
    ok(route() === 'chat', '关闭设置不把路由拉回设置', route())
    ok(seen.length === 1, '关闭本身不产生新请求', seen.length)

    /* 历史直接写 settingsOpen / settingsTab（不经过 openSettings）也响应 */
    useStore.setState({ settingsOpen: true, settingsTab: 'capabilities' })
    ok(seen.length === 2 && seen[1].view === 'capabilities', '直接写字段打开时按当前页名补记', seen)
    ok(route() === 'settings', '兼容路径同样导航到设置')
    /* 已开且字段没变的无关 set：不重复记录 */
    useStore.setState({ settingsOpen: true, settingsTab: 'capabilities' })
    ok(seen.length === 2, '字段没变的直接 set 不重复记录', seen.length)
    /* 直接关闭：不导航 */
    useUiV3.getState().navigate({ name: 'chat' })
    closeSettings()
    ok(route() === 'chat' && seen.length === 2, '直接写字段的关闭同样不导航不记录', { route: route(), seen: seen.length })
  }

  /* ============================================================ 组 6 */
  group('openSettings 动作 revision 递增且保留 v2 其余状态')
  {
    reset()
    const before = useStore.getState()
    openSettings('usage')
    const after = useStore.getState()
    ok(before.settingsRequestRevision === 0, '基线 revision = 0', before.settingsRequestRevision)
    ok(after.settingsRequestRevision === 1, '调用一次后 revision = 1', after.settingsRequestRevision)
    ok(after.settingsOpen === true && after.settingsTab === 'usage', '写入 settingsOpen / settingsTab')
    ok(after.settings === before.settings, '未改动的 settings 状态保持同一引用')
    ok(after.messages === before.messages && after.sessions === before.sessions, '消息与会话等 v2 状态原样保留')
    openSettings('usage')
    ok(useStore.getState().settingsRequestRevision === 2, '再次调用 revision = 2（同页也递增）', useStore.getState().settingsRequestRevision)
    openSettings()
    ok(useStore.getState().settingsRequestRevision === 3, '无页名调用 revision = 3')
    ok(useStore.getState().settingsTab === 'appearance', '无页名落到外观')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
