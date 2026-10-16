#!/usr/bin/env node
/**
 * v3 提交归属现场回归（D1 / D2 / D3 / D4 / D5 / D6）。
 *
 * 目的：不用源码字符串断言，而是把**真实渲染端 store** 和**真实 Composer**
 * 现场 esbuild 出来，用可控 deferred 的 `window.yan` 桩驱动，钉住「消息/命令/
 * 附件/草稿到底归属哪条会话」这一族缺陷。
 *
 * 两份 bundle：
 *   · store 入口：真实 store + session-activation + v3-submit-ownership + composer-submit。
 *     验证 switchSession 代次闸门、ensureActivated 在途拒绝、失败清 pending、
 *     setSessionDraft 显式键、send 在 await 后重新核对视图身份。
 *   · Composer 入口：真实 Composer.tsx（react 用最小浅渲染替身，UI/pattern 子组件
 *     打桩）。验证 Composer 是否**真的接上**了这些机制：切换在途保留草稿、
 *     在途新增附件不被吞、草稿按 peek 身份读写、本地命令激活失败不执行不清字。
 *
 * 用法：node scripts/test-v3-composer-ownership.mjs
 * 不启动 Electron、不连 pi、不读用户数据、不调用真实模型。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

/* ------------------------------------------------------------------ 断言 */

const report = { pass: 0, fail: 0, groups: [] }
let currentGroup = null

function group(name) {
  currentGroup = { name, lines: [] }
  report.groups.push(currentGroup)
  process.stdout.write(`\n▌${name}\n`)
}

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  const mark = pass ? '  ✓' : '  ✗'
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${mark} ${label}${extra}\n`)
  currentGroup?.lines.push({ pass, label })
  return pass
}

/* -------------------------------------------------------- 定时/全局桩 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function flush() {
  await sleep(0)
  await sleep(0)
}
async function waitFor(fn, timeout = 1000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) return false
    await sleep(1)
  }
  return true
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
      /* 浅渲染里没有真实帧，忽略 */
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
}

function defer() {
  let resolveFn
  const promise = new Promise((r) => {
    resolveFn = r
  })
  return { promise, resolve: resolveFn }
}

const SESSIONS = [
  { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' },
  { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' },
  { path: 'C', id: 'sess-c', cwd: 'C:/proj', scope: 'global', title: 'C' }
]

/** 可控的 `window.yan`：明确方法的返回值/延迟，其余返回空实现。 */
function makeYan() {
  const calls = { send: [], runBash: [], selectSession: [], peekSession: [], verifyFiles: [] }
  const pending = { send: null, verifyFiles: null, select: null, peek: null }
  const real = {
    send: async (text, images, mode) => {
      calls.send.push({ text, images, mode })
      if (pending.send) return await pending.send.promise
      return { ok: true }
    },
    runBash: async (command) => {
      calls.runBash.push(command)
      return { ok: true }
    },
    peekSession: async (path) => {
      calls.peekSession.push(path)
      if (pending.peek) await pending.peek.promise
      return { messages: [{ id: `msg-${path}`, role: 'user', text: path }], sessionId: `sess-${String(path).toLowerCase()}`, truncated: 0, total: 1 }
    },
    selectSession: async (target) => {
      calls.selectSession.push(target)
      if (pending.select) return await pending.select.promise
      return { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
    },
    sources: {
      verifyFiles: async (args) => {
        calls.verifyFiles.push(args)
        if (pending.verifyFiles) return await pending.verifyFiles.promise
        return []
      },
      addImage: async () => undefined
    },
    listRunners: async () => [],
    agentStatus: async () => ({ state: 'idle', detail: '' })
  }
  const yan = new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return async () => undefined
    }
  })
  return { yan, calls, pending }
}

function installWindow(yan) {
  globalThis.window = {
    yan,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }
}

/* ------------------------------------------------------------ bundle 构建 */

const REACT_SHIM = `/* v3 归属回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useInsertionEffect() {}
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() }
export function useDebugValue() {}
export function useId() { return rt().useId() }
export function useContext(ctx) { return ctx && '__value' in ctx ? ctx.__value : null }
export function createContext(value) { return { __isContext: true, __value: value, Provider: (p) => (p ? p.children : null), Consumer: (p) => (p && typeof p.children === 'function' ? p.children(value) : null) } }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out, key: out.key === undefined ? null : out.key } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export function isValidElement(el) { return !!el && typeof el === 'object' && 'type' in el && 'props' in el }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, useId, useContext, createContext, createElement, forwardRef, memo, isValidElement }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

/** Composer 依赖的界面/文案子模块打桩：只留下被回归覆盖的真实逻辑。 */
const STUBS = {
  ui: `export function Button(){ return null }
export const cx = (...a) => a.filter(Boolean).join(' ')
export function IconButton(){ return null }
export function TextField(){ return null }
export function Dialog(){ return null }
export function Popover(){ return null }
export function Menu(){ return null }
export function MenuItem(){ return null }
export function Tabs(){ return null }
export function TabList(){ return null }
export function Tab(){ return null }
export function TabPanel(){ return null }
export function Tooltip(){ return null }
export function Select(){ return null }
export function Switch(){ return null }
export function Progress(){ return null }
export function Badge(){ return null }
export function Checkbox(){ return null }
export function Radio(){ return null }
export function ComboBox(){ return null }
export function ListBox(){ return null }
export function Separator(){ return null }
export function Skeleton(){ return null }
export function Toast(){ return null }`,
  i18n: `export function useT(){ return (k) => String(k) }
export function useI18n(){ return { lang: 'zh-CN', setLang(){}, toggleLang(){}, t: (k) => String(k) } }
export function translate(_lang, k){ return String(k) }`,
  attachmentFiles: `export async function readFiles(){ return [] }`,
  lucide: `export function ArrowUp(){ return null }
export function Square(){ return null }`
}

/** 需要打桩的界面/文案子模块：只保留被回归覆盖的真实业务逻辑。 */
function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': STUBS.ui,
      'src/renderer/src/i18n/index.tsx': STUBS.i18n,
      'src/renderer/src/components/chat/attachment-files.ts': STUBS.attachmentFiles,
      'src/renderer/src/patterns/ModelPicker.tsx': 'export function ModelPicker(){ return null }',
      'src/renderer/src/patterns/ModelThinkingPicker.tsx': 'export function ModelThinkingPicker(){ return null }',
      'src/renderer/src/patterns/ContextRing.tsx': 'export function ContextRing(){ return null }',
      'src/renderer/src/features/composer/AttachmentStrip.tsx': 'export function AttachmentStrip(){ return null }',
      'src/renderer/src/features/composer/CompletionMenu.tsx': 'export function CompletionMenu(){ return null }',
      'src/renderer/src/features/composer/useCompletion.ts': 'export function useCompletion(){ return { open: false, index: 0, slashMatches: [], atMatches: [], handleKey(){ return false } } }',
      'src/renderer/src/features/composer/ComposerBorder.tsx': 'export function ComposerBorder(){ return null }',
      'src/renderer/src/features/composer/ComposerUsage.tsx': 'export function ComposerUsage(){ return null }',
      'src/renderer/src/features/composer/RunSlot.tsx': 'export function RunSlot(){ return null }',
      'src/renderer/src/features/composer/VoiceButton.tsx': 'export function VoiceButton(){ return null }',
      'src/renderer/src/features/composer/PermissionToggle.tsx': 'export function PermissionToggle(){ return null }',
      'src/renderer/src/features/composer/PlusMenu.tsx': 'export function PlusMenu(){ return null }',
      'src/renderer/src/features/composer/QueueStack.tsx': 'export function QueueStack(){ return null }',
      'src/renderer/src/features/composer/QueueEditor.tsx': 'export function QueueEditor(){ return null }'
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

async function buildBundles(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)

  const storeEntry = join(outdir, 'store-entry.ts')
  await writeFile(
    storeEntry,
    `export { useStore } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'
export * as activation from '${posix(resolve(ROOT, 'src/renderer/src/state/session-activation'))}'
export { viewingSubmitSessionId, attachmentsAfterSubmit, runLocalCommandGuarded, localCommandNeedsActivatedTarget } from '${posix(resolve(ROOT, 'src/renderer/src/lib/v3-submit-ownership'))}'
export { submitComposerInput } from '${posix(resolve(ROOT, 'src/renderer/src/lib/composer-submit'))}'
`
  )
  const composerEntry = join(outdir, 'composer-entry.ts')
  await writeFile(
    composerEntry,
    `export { Composer } from '${posix(resolve(ROOT, 'src/renderer/src/features/composer/Composer'))}'
export { useStore } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'
export * as activation from '${posix(resolve(ROOT, 'src/renderer/src/state/session-activation'))}'
`
  )

  const stubMap = makeStubMap()
  const define = {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'process.env.NODE_ENV': '"production"'
  }
  const stubPlugin = {
    name: 'v3-ownership-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'react') return { path: reactShim }
        if (args.path === 'react/jsx-runtime') return { path: jsxShim }
        if (args.path === 'react/jsx-dev-runtime') return { path: jsxShim }
        if (args.path === 'lucide-react') return { path: 'v3stub:lucide', namespace: 'v3stub' }
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (stubMap.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        if (args.path === 'v3stub:lucide') return { contents: STUBS.lucide, loader: 'js' }
        const key = args.path.slice('v3stub:'.length)
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
      })
    }
  }

  const storeOut = join(outdir, 'store-bundle.mjs')
  await build({
    entryPoints: [storeEntry],
    outfile: storeOut,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: {
      ...define,
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })

  const composerOut = join(outdir, 'composer-bundle.mjs')
  await build({
    entryPoints: [composerEntry],
    outfile: composerOut,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    define: {
      ...define,
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    },
    plugins: [stubPlugin]
  })

  return { storeOut, composerOut }
}

/* ------------------------------------------------------- 浅渲染 hook 运行时 */

function makeHookRuntime() {
  const rt = {
    cells: [],
    idx: 0,
    effects: [],
    dirty: false,
    seq: 0,
    slot(kind) {
      const i = rt.idx++
      let c = rt.cells[i]
      if (!c || c.kind !== kind) c = rt.cells[i] = { kind, has: false, value: undefined, deps: undefined }
      return c
    },
    useState(init) {
      const c = rt.slot('state')
      if (!c.has) {
        c.value = typeof init === 'function' ? init() : init
        c.has = true
      }
      const set = (v) => {
        const next = typeof v === 'function' ? v(c.value) : v
        if (!Object.is(next, c.value)) {
          c.value = next
          rt.dirty = true
        }
      }
      return [c.value, set]
    },
    useRef(init) {
      const c = rt.slot('ref')
      if (!c.has) {
        c.value = { current: init }
        c.has = true
      }
      return c.value
    },
    useEffect(fn, deps) {
      const c = rt.slot('effect')
      const prev = c.deps
      const changed = !c.has || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]))
      if (changed) {
        c.deps = deps ? [...deps] : undefined
        c.has = true
        rt.effects.push(fn)
      }
    },
    useId() {
      return `v3id-${rt.seq++}`
    },
    render(Component, props) {
      let tree
      let guard = 0
      do {
        rt.dirty = false
        rt.idx = 0
        rt.effects = []
        tree = Component(props || {})
        for (const fn of rt.effects) fn()
      } while (rt.dirty && ++guard < 100)
      if (guard >= 100) throw new Error('浅渲染未收敛（疑似 effect 里无限 setState）')
      return tree
    }
  }
  return rt
}

function findByTestId(node, id) {
  if (!node || typeof node !== 'object') return null
  const props = node.props || {}
  if (props['data-testid'] === id) return node
  const kids = props.children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const found = findByTestId(k, id)
    if (found) return found
  }
  return null
}

function enterEvent() {
  return {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault() {},
    nativeEvent: { isComposing: false, keyCode: 13 }
  }
}

/* ------------------------------------------------------------------ 主流程 */

function resetStore(store, activation, overrides = {}) {
  activation?.resetSessionActivationForTest?.()
  store.setState({
    sessions: SESSIONS,
    settings: { cwd: 'C:/proj', projects: [] },
    session: null,
    messages: [],
    attachments: [],
    peekedPath: null,
    peekedSessionId: null,
    pendingActivation: null,
    activeRunnerId: null,
    runners: [],
    sessionRuntimes: {},
    notices: [],
    pendingSourceLinks: [],
    editorInject: null,
    composerInsert: null,
    queueRestore: null,
    ...overrides
  })
}

const attachment = (id, name, size) => ({
  id,
  name,
  mimeType: 'image/png',
  size,
  data: '',
  preview: '',
  kind: 'image'
})

async function main() {
  installGlobals()
  const { yan } = makeYan()
  installWindow(yan)

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-ownership-'))
  let storeBundle
  let composerBundle
  try {
    const built = await buildBundles(outdir)
    storeBundle = await import(pathToFileURL(built.storeOut).href)
    composerBundle = await import(pathToFileURL(built.composerOut).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { useStore, activation } = storeBundle
  /* Composer 是另一份现场 bundle，它自带一份 store / activation —— 组件测试
   * 必须操作**它**的那份状态，否则测的就不是 Composer 真正读到的东西。 */
  const composerStore = composerBundle.useStore
  const composerActivation = composerBundle.activation

  /* ============================================================ 组 1 */
  group('D4 切换在途：ensureActivated 拒绝发送，Composer 保留草稿')
  {
    const { yan: y1, calls, pending } = makeYan()
    globalThis.window.yan = y1
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }]
    })
    pending.peek = defer()
    const switching = useStore.getState().switchSession('A')
    // 在第一个 await 返回之前，闸门必须已经登记
    ok(activation.isSessionSwitchInFlight(), 'switchSession 在首 await 前登记了「切换在途」')
    const allowed = await useStore.getState().ensureActivated()
    ok(allowed === false, '切换在途 ensureActivated 返回 false（不放行发送）')
    const sent = await useStore.getState().send('会落错会话吗', undefined)
    ok(sent === false, '切换在途 store.send 返回 false')
    ok(calls.send.length === 0, '切换在途 yan.send 未被调用', calls.send.length)
    ok(
      useStore.getState().notices.some((n) => String(n.text).includes('正在切换会话')),
      '给出了「正在切换会话」的提示'
    )
    pending.peek.resolve()
    await switching
    await flush()
    ok(!activation.isSessionSwitchInFlight(), '切换结束后闸门释放')
    ok((await useStore.getState().ensureActivated()) === true, '切换完成后正路径 ensureActivated 放行')
    pending.peek = null
  }

  /* ============================================================ 组 2 */
  group('D3 切换失败：不遗留 pendingActivation，下一次激活不落回旧目标')
  {
    const { yan: y2, calls, pending } = makeYan()
    globalThis.window.yan = y2
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }]
    })
    // ① 只读打开 B，留下待激活目标
    pending.select = defer()
    const openB = useStore.getState().switchSession('B')
    await flush()
    pending.select.resolve({ ok: true, deferred: true, sessionId: 'sess-b' })
    await openB
    await flush()
    ok(useStore.getState().pendingActivation?.sessionFile === 'B', 'B 只读打开后登记待激活目标', useStore.getState().pendingActivation)

    // ② 切 C 失败：pending 必须清掉
    calls.selectSession.length = 0
    pending.select = defer()
    const openC = useStore.getState().switchSession('C')
    await flush()
    pending.select.resolve({ ok: false, error: 'cwd 校验失败' })
    await openC
    await flush()
    ok(useStore.getState().pendingActivation === null, '切换失败后 pendingActivation 被清空', useStore.getState().pendingActivation)
    ok(useStore.getState().peekedSessionId === null, '切换失败后不再冒充新会话的视图身份', useStore.getState().peekedSessionId)

    // ③ 下一次激活不能被引到 B
    calls.selectSession.length = 0
    const allowed = await useStore.getState().ensureActivated()
    ok(allowed === true, '失败后无待激活目标，ensureActivated 放行')
    ok(
      !calls.selectSession.some((t) => t.sessionFile === 'B' || t.sessionId === 'sess-b'),
      '失败后的激活不会错误地落到 B',
      calls.selectSession
    )
    pending.select = null
  }

  /* ============================================================ 组 5 */
  group('D6 collectSourceIds 等待期间切会话：不发消息、不登记错误 sourceLink')
  {
    const { yan: y5, calls, pending } = makeYan()
    globalThis.window.yan = y5
    const fileAttachment = { id: 'f1', name: 'x.txt', mimeType: '', size: 1, data: '', preview: '', kind: 'file', path: 'C:/x.txt' }

    // 正对照：不切会话时，来源确实按「正在看的」会话登记
    resetStore(useStore, activation, {
      session: null,
      peekedSessionId: 'sess-b',
      activeRunnerId: null,
      attachments: [fileAttachment]
    })
    pending.verifyFiles = defer()
    const positive = useStore.getState().send('先发一条')
    await waitFor(() => calls.verifyFiles.length === 1)
    pending.verifyFiles.resolve([{ sourceId: 'file:C:/x.txt:1' }])
    const positiveOk = await positive
    await flush()
    ok(positiveOk === true, '正路径确实发出去了（不是「全都没发」）')
    ok(calls.send.length === 1, '正路径 yan.send 被真实调用一次', calls.send.length)
    ok(
      useStore.getState().pendingSourceLinks[0]?.sessionId === 'sess-b',
      '来源按「正在看的」会话 sess-b 登记，而不是旧 session',
      useStore.getState().pendingSourceLinks
    )
    ok(
      useStore.getState().pendingSourceLinks[0]?.sourceIds?.includes('file:C:/x.txt:1'),
      '来源 id 是本次附件复核出来的那个'
    )

    // 负对照：等待来源期间切走
    resetStore(useStore, activation, {
      session: null,
      peekedSessionId: 'sess-b',
      activeRunnerId: null,
      attachments: [fileAttachment]
    })
    calls.send.length = 0
    calls.verifyFiles.length = 0
    calls.selectSession.length = 0
    pending.verifyFiles = defer()
    const raced = useStore.getState().send('等待来源时切走')
    await waitFor(() => calls.verifyFiles.length === 1)
    useStore.setState({ peekedSessionId: 'sess-c' })
    pending.verifyFiles.resolve([{ sourceId: 'file:C:/x.txt:1' }])
    const racedOk = await raced
    await flush()
    ok(racedOk === false, '来源等待期间切走后 send 返回 false')
    ok(calls.send.length === 0, '切走后 yan.send 未被调用', calls.send.length)
    ok(useStore.getState().pendingSourceLinks.length === 0, '没有登记任何（错误会话的）sourceLink', useStore.getState().pendingSourceLinks)
    pending.verifyFiles = null
  }

  /* ============================================================ 组 4a */
  group('D5 setSessionDraft 显式键：读写的键由调用方指定，不再猜当前激活会话')
  {
    const { yan: y4 } = makeYan()
    globalThis.window.yan = y4
    resetStore(useStore, activation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }],
      sessionRuntimes: {
        'sess-a': { runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 }, messages: [] }
      }
    })
    useStore.getState().setSessionDraft('B 的草稿', 'sess-b')
    ok(useStore.getState().sessionRuntimes['sess-b']?.draft === 'B 的草稿', '显式键写入目标会话', useStore.getState().sessionRuntimes['sess-b'])
    ok(useStore.getState().sessionRuntimes['sess-a']?.draft === undefined, '不会误写到当前激活会话')
    useStore.getState().setSessionDraft('A 的草稿')
    ok(useStore.getState().sessionRuntimes['sess-a']?.draft === 'A 的草稿', '省略键时仍按 v2 语义写当前激活会话')
  }

  /* ============================================================ 组 6a */
  group('D2 runLocalCommandGuarded：激活失败不执行、不清文字；成功才执行')
  {
    const { yan: y6, calls } = makeYan()
    globalThis.window.yan = y6
    const { runLocalCommandGuarded, localCommandNeedsActivatedTarget } = storeBundle
    ok(localCommandNeedsActivatedTarget('!git status'), '`!` 被判定为需要先激活实例')
    ok(localCommandNeedsActivatedTarget('/model gpt'), '`/model` 被判定为需要先激活实例')
    ok(!localCommandNeedsActivatedTarget('/settings'), '`/settings` 不受切换状态阻塞')

    let ran = 0
    let blocked = 0
    const outcome = await runLocalCommandGuarded({
      raw: '!git status',
      ensureActivated: async () => false,
      run: async () => {
        ran += 1
      },
      notifyBlocked: () => {
        blocked += 1
      }
    })
    ok(outcome === 'blocked' && ran === 0 && blocked === 1, '激活失败：不调用 run，并给出阻断提示', { outcome, ran, blocked })

    const outcome2 = await runLocalCommandGuarded({
      raw: '/settings',
      ensureActivated: async () => false,
      run: async () => {
        ran += 1
      },
      notifyBlocked: () => {
        blocked += 1
      }
    })
    ok(outcome2 === 'ran' && ran === 1, '纯界面命令不受激活状态影响，照常执行', { outcome2, ran })
  }

  /* ============================================== Composer 接线（真实组件） */
  const { Composer } = composerBundle
  const hookRuntime = () => {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    return rt
  }

  /* ============================================================ 组 1b */
  group('D4 Composer 接线：切换在途发送被挡，输入框草稿原样保留')
  {
    const { yan: yc, calls, pending } = makeYan()
    globalThis.window.yan = yc
    resetStore(composerStore, composerActivation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }]
    })
    const rt = hookRuntime()
    let tree = rt.render(Composer, {})
    let ta = findByTestId(tree, 'composer-input')
    ok(!!ta, 'Composer 渲染出输入框（真实组件已接上 store）')
    ta.props.onChange({ target: { value: '保留这段草稿', selectionStart: 5 } })
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === '保留这段草稿', '输入框已持有草稿', ta.props.value)

    pending.peek = defer()
    const switching = composerStore.getState().switchSession('A')
    ok(composerActivation.isSessionSwitchInFlight(), 'Composer 场景下切换确实在途')
    ta.props.onKeyDown(enterEvent())
    await flush()
    ok(calls.send.length === 0, '切换在途时 Composer 没有调用 yan.send', calls.send.length)
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === '保留这段草稿', '被挡下后草稿原样保留', ta.props.value)
    pending.peek.resolve()
    await switching
    await flush()
    pending.peek = null
  }

  /* ============================================================ 组 3 */
  group('D1 Composer 接线：一次 send 在途时新添加的附件不被成功回调吞掉')
  {
    const { yan: yc, calls, pending } = makeYan()
    globalThis.window.yan = yc
    resetStore(composerStore, composerActivation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }],
      attachments: [attachment('a1', 'one.png', 1)]
    })
    const rt = hookRuntime()
    let tree = rt.render(Composer, {})
    let ta = findByTestId(tree, 'composer-input')
    ta.props.onChange({ target: { value: '带附件发送', selectionStart: 5 } })
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')

    pending.send = defer()
    ta.props.onKeyDown(enterEvent())
    ok(await waitFor(() => calls.send.length === 1), '发送请求已到达 yan.send（在途）')
    // 在途窗口内新增附件
    composerStore.getState().addAttachments([attachment('a2', 'two.png', 2)])
    ok(composerStore.getState().attachments.length === 2, '在途期间成功加入第二个附件', composerStore.getState().attachments.map((a) => a.id))
    pending.send.resolve({ ok: true })
    await flush()
    const ids = composerStore.getState().attachments.map((a) => a.id)
    ok(ids.length === 1 && ids[0] === 'a2', '成功后只移除本次提交的 a1，在途新增的 a2 保留', ids)
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === '', '成功提交后本次文字被清空', ta.props.value)
    pending.send = null
  }

  /* ============================================================ 组 4b */
  group('D5 Composer 接线：草稿跟着 peek 身份，而不是尚在旧会话的 session 投影')
  {
    const { yan: yc } = makeYan()
    globalThis.window.yan = yc
    resetStore(composerStore, composerActivation, {
      session: { sessionId: 'sess-a', conversationId: 'conv-a', cwd: 'C:/proj' },
      peekedSessionId: 'sess-b',
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }],
      sessionRuntimes: {
        'sess-a': { runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 }, messages: [], draft: 'A 的旧草稿' },
        'sess-b': { runtime: { sessionId: 'sess-b', runId: 'run-b', generation: 0 }, messages: [], draft: 'B 的草稿' }
      }
    })
    const rt = hookRuntime()
    let tree = rt.render(Composer, {})
    let ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === 'B 的草稿', '打开 B（未激活）时输入框显示 B 的草稿', ta.props.value)

    ta.props.onChange({ target: { value: 'B 的草稿 + 新字', selectionStart: 10 } })
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    await flush()
    tree = rt.render(Composer, {})
    ok(
      composerStore.getState().sessionRuntimes['sess-b']?.draft === 'B 的草稿 + 新字',
      '回写用 peek 身份 sess-b 的键',
      composerStore.getState().sessionRuntimes['sess-b']?.draft
    )
    ok(
      composerStore.getState().sessionRuntimes['sess-a']?.draft === 'A 的旧草稿',
      '没有覆盖尚未离开的 sess-a 草稿',
      composerStore.getState().sessionRuntimes['sess-a']?.draft
    )
  }

  /* ============================================================ 组 6b */
  group('D2 Composer 接线：本地命令激活失败不执行不清字；激活成功才执行')
  {
    const { yan: yc, calls, pending } = makeYan()
    globalThis.window.yan = yc
    resetStore(composerStore, composerActivation, {
      session: { sessionId: 'sess-a', cwd: 'C:/proj' },
      activeRunnerId: 'run-a',
      runners: [{ runId: 'run-a', sessionId: 'sess-a', generation: 0, cwd: 'C:/proj' }],
      pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj', scope: 'global' }
    })
    const rt = hookRuntime()
    let tree = rt.render(Composer, {})
    let ta = findByTestId(tree, 'composer-input')
    ta.props.onChange({ target: { value: '!echo hi', selectionStart: 8 } })
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')

    pending.select = defer()
    ta.props.onKeyDown(enterEvent())
    ok(await waitFor(() => calls.selectSession.some((t) => t.sessionId === 'sess-b')), '本地命令前先尝试激活 peek 目标')
    pending.select.resolve({ ok: false, error: '切换失败' })
    await flush()
    await flush()
    ok(calls.runBash.length === 0, '激活失败时没有执行本地命令', calls.runBash)
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === '!echo hi', '激活失败时命令原文保留在输入框', ta.props.value)
    pending.select = null

    // 正路径：清掉待激活目标后，同一条命令必须真的执行
    composerStore.setState({ pendingActivation: null, notices: [] })
    calls.runBash.length = 0
    ta.props.onKeyDown(enterEvent())
    await flush()
    await flush()
    ok(calls.runBash.length === 1 && calls.runBash[0] === 'echo hi', '激活就绪后本地命令按原文执行一次', calls.runBash)
    tree = rt.render(Composer, {})
    ta = findByTestId(tree, 'composer-input')
    ok(ta.props.value === '', '执行成功后输入框才被清空', ta.props.value)
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
