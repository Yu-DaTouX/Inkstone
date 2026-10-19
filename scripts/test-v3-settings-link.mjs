#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

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
    yan: { browser: { setVisible: () => {} } }
  }
}

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
export { installSettingsDeepLink, resetSettingsDeepLinkForTest, subscribeSettingsRequest, getSettingsRequest, openSettingsDialog, rememberSettingsSection, consumeSettingsHash } from '${posix(resolve(ROOT, 'src/renderer/src/features/settings/root/deep-link'))}'
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

  const { useStore, useUiV3, installSettingsDeepLink, resetSettingsDeepLinkForTest, subscribeSettingsRequest, getSettingsRequest, resolveLegacyView, openSettingsDialog, rememberSettingsSection, consumeSettingsHash } = bundle

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

  group('auth 打开 → 返聊天 → 同页 auth 再次打开')
  {
    reset()
    const { seen } = collect()
    openSettings('auth')
    ok(seen.length === 1 && seen[0].view === 'auth', '第一次 auth 请求被记录', seen)
    ok(route() === 'chat' && useStore.getState().settingsOpen === true, '第一次请求打开设置弹层，路由不变', route())
    ok(seen[0].revision === 1, '第一次请求 revision = 1', seen[0])

    useUiV3.getState().navigate({ name: 'chat' })
    ok(route() === 'chat', '返回聊天（settingsOpen 仍为 true）')
    ok(useStore.getState().settingsOpen === true, 'v3 返聊天不 closeSettings，字段保持 true')

    openSettings('auth')
    ok(seen.length === 2, '同一页 auth 再次请求仍然通知（不是被吞）', seen.length)
    ok(seen[1] !== seen[0], '第二次是一个新请求对象')
    ok(seen[1].view === 'auth' && seen[1].revision === 2, '第二次 auth revision = 2', seen[1])
    ok(route() === 'chat' && useStore.getState().settingsOpen === true, '第二次请求仍只打开弹层', route())
  }

  group('设置内手动选外观后，同一 auth 请求重选模型页')
  {
    reset()
    const { seen } = collect()
    openSettings('appearance')
    openSettings('auth')
    ok(seen[1].view === 'auth', 'auth 请求映射到模型页', seen[1])
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

  group('同一毫秒的两次请求都通知，靠 revision 区分')
  {
    reset()
    const { seen } = collect()
    const at = Date.now
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
    ok(useStore.getState().settingsOpen === true && route() === 'chat', '弹层保持打开，路由没被改动')

    useStore.setState({ settingsRequestRevision: useStore.getState().settingsRequestRevision })
    ok(seen.length === 1, '重复写同一 revision 不重复记录（订阅重入去重）', seen.length)
  }

  group('closeSettings 不导航；直接写字段的旧调用兼容')
  {
    reset()
    const { seen } = collect()
    openSettings('appearance')
    ok(route() === 'chat' && useStore.getState().settingsOpen === true, '打开后弹层打开、路由不变')
    useUiV3.getState().navigate({ name: 'chat' })
    closeSettings()
    ok(route() === 'chat', '关闭设置不把路由拉回设置', route())
    ok(seen.length === 1, '关闭本身不产生新请求', seen.length)

    useStore.setState({ settingsOpen: true, settingsTab: 'capabilities' })
    ok(seen.length === 2 && seen[1].view === 'capabilities', '直接写字段打开时按当前页名补记', seen)
    ok(route() === 'chat', '兼容路径同样不切路由')
    useStore.setState({ settingsOpen: true, settingsTab: 'capabilities' })
    ok(seen.length === 2, '字段没变的直接 set 不重复记录', seen.length)
    useUiV3.getState().navigate({ name: 'chat' })
    closeSettings()
    ok(route() === 'chat' && seen.length === 2, '直接写字段的关闭同样不导航不记录', { route: route(), seen: seen.length })
  }

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

  group('入口打开弹层：沿用上次分区，显式分区优先')
  {
    reset()
    const { seen } = collect()
    openSettingsDialog()
    ok(seen.at(-1).view === 'models', '首次无分区打开落到默认模型页', seen.at(-1))
    rememberSettingsSection('usage')
    closeSettings()
    openSettingsDialog()
    ok(seen.at(-1).view === 'usage' && useStore.getState().settingsOpen === true, '再次打开回到上次分区', seen.at(-1))
    openSettingsDialog('devices')
    ok(seen.at(-1).view === 'devices', '显式分区优先', seen.at(-1))
    ok(route() === 'chat', '入口都不切路由')
  }

  group('#/settings 哈希深链改为打开弹层')
  {
    reset()
    const { seen } = collect()
    const replaced = []
    window.history.replaceState = (_s, _t, url) => replaced.push(url)
    window.location.hash = '#/settings/context'
    ok(consumeSettingsHash() === true, '识别 #/settings/<分区>')
    ok(seen.at(-1).view === 'context' && useStore.getState().settingsOpen === true, '打开弹层并定位分区', seen.at(-1))
    ok(replaced.at(-1) === '#/', '哈希改回会话，避免刷新后重复打开', replaced)
    window.location.hash = '#/schedule'
    ok(consumeSettingsHash() === false && seen.length === 1, '其他哈希不处理', seen.length)
    window.history.replaceState = () => {}
    window.location.hash = ''
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
