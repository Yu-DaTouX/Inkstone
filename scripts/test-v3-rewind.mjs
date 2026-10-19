#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }

function group(name) {
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
    querySelectorAll: () => [],
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

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function makeYan() {
  const calls = { preview: [], restore: [], undo: [] }
  const pending = { preview: null, restore: null, undo: null }
  const real = {
    checkpoints: {
      list: async () => [],
      preview: async (recordId) => {
        calls.preview.push(recordId)
        if (pending.preview) return await pending.preview.promise
        return { ok: true, changes: [], total: 0 }
      },
      restore: async (recordId) => {
        calls.restore.push(recordId)
        if (pending.restore) return await pending.restore.promise
        return { ok: true, restored: 0, undoId: undefined }
      },
      undo: async (undoId) => {
        calls.undo.push(undoId)
        if (pending.undo) return await pending.undo.promise
        return { ok: true, restored: 0 }
      }
    }
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

const REACT_SHIM = `/* v3 回退回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
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

const I18N_STUB = `export function useT(){ return (k) => String(k) }
export function useI18n(){ return { t:(k)=>String(k) } }
export function translate(_l,k){ return String(k) }`

const UI_STUB_FOR_DIALOG = `export function ModalOverlay(props){ return props.children }
export function Modal(props){ return props.children }
export function Dialog(props){ return props.children }
Dialog.__stub='dialog'
export function Button(props){ return null }
Button.__stub='button'
Button.__calls=[]
export function IconButton(){ return null }
export function Badge(){ return null }
export function Notice(props){ return props.children ?? null }`

function abs(rel) {
  return normalize(resolve(ROOT, rel))
}

function makeStubPlugin(rawMap) {
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
  return {
    name: 'v3-rewind-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (stubMap.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        const key = args.path.slice('v3stub:'.length)
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
      })
    }
  }
}

const DEFINE = {
  'import.meta.env.DEV': 'false',
  'import.meta.env.PROD': 'true',
  'process.env.NODE_ENV': '"production"',
  requestAnimationFrame: 'globalThis.requestAnimationFrame',
  cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
}

async function buildOne(outdir, name, entrySource, rawStubMap, shims) {
  const entry = join(outdir, `${name}-entry.ts`)
  await writeFile(entry, entrySource)
  const out = join(outdir, `${name}-bundle.mjs`)
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    loader: { '.css': 'empty' },
    define: DEFINE,
    alias: { react: shims.react, 'react/jsx-runtime': shims.jsx, 'react/jsx-dev-runtime': shims.jsx },
    plugins: [makeStubPlugin(rawStubMap)]
  })
  return out
}

async function buildAll(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const shims = { react: reactShim, jsx: jsxShim }

  const turnOut = await buildOne(
    outdir,
    'turn',
    `export { TurnView } from '${posix(abs('src/renderer/src/features/session/TurnView.tsx'))}'
export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'
export { createTurnProjector } from '${posix(abs('src/shared/turns.ts'))}'
export { textFingerprint } from '${posix(abs('src/shared/checkpoints.ts'))}'
`,
    {
      'src/renderer/src/features/session/Markdown.tsx': `export function Markdown(){ return null }\nexport function PlainText(){ return null }`,
      'src/renderer/src/features/session/MessageParts.tsx': `export function TurnArtifacts(){ return null }`,
      'src/renderer/src/features/session/Thinking.tsx': `export function ThinkingLine(){ return null }`,
      'src/renderer/src/features/session/ToolSteps.tsx': `export function ToolSteps(){ return null }`,
      'src/renderer/src/features/session/Image.tsx': `export function MessageImage(){ return null }`,
      'src/renderer/src/features/session/text.ts': `export function useSessionText(){ return (k)=>String(k) }\nexport function sessionText(_l,k){ return String(k) }`,
      'src/renderer/src/features/session/SubagentReview.tsx': `export function SubagentReview(){ return null }`,
      'src/renderer/src/features/session/BranchTree.tsx': `export function BranchTree(){ return null }`,
      'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }`,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/ui/index.ts': `export function IconButton(){ return null }\nexport function Button(){ return null }\nexport function Badge(){ return null }\nexport function ShimmerText(props){ return [props.lead ?? null, props.children] }\nexport function CompletionSweep(){ return null }\nexport function Notice(props){ return props.children ?? null }\nexport function ProgressBar(){ return null }\nexport function SegmentedControl(){ return null }`,
      'src/renderer/src/features/session/run-status.ts': `export function useRunProgress(){ return null }\nexport function runPhaseText(){ return '' }`,
      'src/renderer/src/lib/fork.ts': `export async function forkFromText(){ globalThis.__V3_FORK_CALLED = (globalThis.__V3_FORK_CALLED ?? 0) + 1 }`
    },
    shims
  )

  const rewindOut = await buildOne(
    outdir,
    'rewind',
    `export { RewindDialogV3 } from '${posix(abs('src/renderer/src/features/session/RewindDialogV3.tsx'))}'
export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'
`,
    {
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/ui/index.ts': UI_STUB_FOR_DIALOG
    },
    shims
  )

  return { turnOut, rewindOut }
}

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

function collect(node, pred, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, pred, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  const kids = node.props?.children
  if (kids !== undefined) collect(kids, pred, out)
  return out
}

const byTestId = (tree, id) => collect(tree, (el) => el.props?.['data-testid'] === id)
const buttonByTestId = (tree, id) => collect(tree, (el) => el.type?.__stub === 'button' && el.props?.['data-testid'] === id)
const buttons = (tree) => collect(tree, (el) => el.type?.__stub === 'button')
const domButtons = (tree) => collect(tree, (el) => el.type === 'button')

const USER_TEXT = '把登录改成 PKCE'
const USER_TS = 1_700_000_000_000

function checkpointRecord(over = {}) {
  return {
    id: 'cp-1',
    sessionKey: 'sess-a',
    at: USER_TS,
    textHash: '',
    preview: USER_TEXT,
    kind: 'turn',
    ...over
  }
}

async function main() {
  installGlobals()
  const { yan, calls, pending } = makeYan()
  installWindow(yan)

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-rewind-'))
  let turnBundle
  let rewindBundle
  try {
    const built = await buildAll(outdir)
    turnBundle = await import(pathToFileURL(built.turnOut).href)
    rewindBundle = await import(pathToFileURL(built.rewindOut).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const rt = makeHookRuntime()
  globalThis.__V3_HOOKS = rt

  const { TurnView, useStore: turnStore, createTurnProjector, textFingerprint } = turnBundle
  const project = createTurnProjector()
  const userTurn = project([{ id: 'u1', role: 'user', text: USER_TEXT, timestamp: USER_TS }]).find((t) => t.kind === 'user')

  const renderTurn = (props = {}) => {
    turnStore.setState({ session: null, messages: [], subagents: [], models: [], rewind: null })
    const el = TurnView({ turn: userTurn, ...props })
    rt.seq = 0
    return rt.render(el.type, el.props)
  }
  const rewindButton = (tree) => domButtons(tree).find((el) => el.props['data-testid'] === 'v3-msg-rewind')
  const forkButton = (tree) => domButtons(tree).find((el) => el.props.title === 'chat.forkHere')

  group('TurnView 回退入口：真实命中且归属当前活动会话才出现')
  {
    const record = checkpointRecord({ textHash: textFingerprint(USER_TEXT) })
    turnStore.setState({ checkpoints: [record] })
    const tree = renderTurn({ rewindOwner: 'sess-a' })
    ok(!!rewindButton(tree), '命中检查点 + 归属一致：可写用户回合出现「回退代码」')
    ok(!!forkButton(tree), '分叉入口仍在（代码回退与会话分支语义分离）')

    rewindButton(tree).props.onClick()
    ok(turnStore.getState().rewind?.recordId === 'cp-1', '点击回退把记录与预览交给 store.openRewind', turnStore.getState().rewind)
    ok(turnStore.getState().rewind?.preview === USER_TEXT, '预览取这条用户消息原文')
  }

  group('TurnView 回退入口：不命中 / 只读 / 归属不符一律不画')
  {
    turnStore.setState({ checkpoints: [checkpointRecord({ id: 'cp-other', textHash: textFingerprint('别的消息') })] })
    ok(!rewindButton(renderTurn({ rewindOwner: 'sess-a' })), '指纹不命中：不画')

    turnStore.setState({ checkpoints: [checkpointRecord({ textHash: textFingerprint(USER_TEXT) })] })
    ok(!rewindButton(renderTurn({ rewindOwner: 'sess-a', readOnly: true })), '只读回放：不画')

    ok(!rewindButton(renderTurn({ rewindOwner: null })), '视图失活（rewindOwner 为 null）：不画')

    turnStore.setState({ checkpoints: [checkpointRecord({ sessionKey: 'sess-b', textHash: textFingerprint(USER_TEXT) })] })
    ok(!rewindButton(renderTurn({ rewindOwner: 'sess-a' })), '记录属于别的会话（并排 owner 不符）：不画，不操作全局当前会话')
    ok(!!forkButton(renderTurn({ rewindOwner: 'sess-a' })), '即便如此，分叉入口不受影响')
  }

  const { RewindDialogV3, useStore: rewindStore } = rewindBundle
  const renderDialog = (ownerKey, active) => rt.render(RewindDialogV3, { ownerKey, active })

  group('RewindDialogV3：预览 → 确认 → 撤销走通，失败给文案')
  {
    rewindStore.setState({ rewind: { recordId: 'cp-1', preview: USER_TEXT } })
    pending.preview = defer()
    let tree = renderDialog('A', true)
    ok(calls.preview.includes('cp-1'), '打开时用记录 id 调 preview', calls.preview)
    pending.preview.resolve({ ok: true, changes: [{ path: 'src/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'A' }], total: 2 })
    await flush()
    tree = renderDialog('A', true)
    const files = byTestId(tree, 'rewind-files')
    ok(files.length === 1, '预览就绪：列出会改的文件', files.length)
    const confirm = buttonByTestId(tree, 'rewind-confirm')
    ok(confirm.length === 1, '有改动：出现「回退代码」确认按钮')

    pending.restore = defer()
    confirm[0].props.onPress()
    ok(calls.restore.includes('cp-1'), '确认后调 restore(recordId)', calls.restore)
    pending.restore.resolve({ ok: true, restored: 2, undoId: 'undo-1' })
    await flush()
    tree = renderDialog('A', true)
    ok(buttonByTestId(tree, 'rewind-undo').length === 1, '恢复成功：出现「撤销这次回退」')

    pending.undo = defer()
    buttonByTestId(tree, 'rewind-undo')[0].props.onPress()
    ok(calls.undo.includes('undo-1'), '撤销调 undo(undoId)', calls.undo)
    pending.undo.resolve({ ok: true, restored: 2 })
    await flush()
    tree = renderDialog('A', true)
    ok(buttonByTestId(tree, 'rewind-undo').length === 0, '撤销后不再显示撤销按钮')
    pending.preview = null
    pending.restore = null
    pending.undo = null
  }

  group('RewindDialogV3：预览失败给出错误、不显示确认')
  {
    rewindStore.setState({ rewind: { recordId: 'cp-err', preview: USER_TEXT } })
    pending.preview = defer()
    renderDialog('A', true)
    pending.preview.resolve({ ok: false, error: '没有活动会话', changes: [], total: 0 })
    await flush()
    const tree = renderDialog('A', true)
    ok(buttonByTestId(tree, 'rewind-confirm').length === 0, '预览失败：不出现确认按钮')
    const status = collect(tree, (el) => el.props?.['role'] === 'status')
    ok(status.length === 1, '预览失败：有可见的状态提示')
    pending.preview = null
  }

  group('RewindDialogV3：会话切换 / 视图失活立即关闭，迟到响应不覆盖新记录')
  {
    const previewCp1 = defer()
    pending.preview = previewCp1
    rewindStore.setState({ rewind: { recordId: 'cp-1', preview: USER_TEXT } })
    renderDialog('A', true)
    renderDialog('B', true)
    renderDialog('B', true)
    ok(rewindStore.getState().rewind === null, '视图键变化：关闭对话框、清空 rewind', rewindStore.getState().rewind)

    const previewCp2 = defer()
    pending.preview = previewCp2
    rewindStore.setState({ rewind: { recordId: 'cp-2', preview: USER_TEXT } })
    renderDialog('B', true)
    ok(calls.preview.includes('cp-2'), '重新打开对 cp-2 发起预览', calls.preview)

    previewCp1.resolve({ ok: true, changes: [{ path: 'old.ts', status: 'M' }], total: 1 })
    await flush()
    let tree = renderDialog('B', true)
    ok(byTestId(tree, 'rewind-files').length === 0, '迟到的旧记录响应不改状态（未显示旧文件）', byTestId(tree, 'rewind-files').length)

    previewCp2.resolve({ ok: true, changes: [{ path: 'new.ts', status: 'A' }], total: 1 })
    await flush()
    tree = renderDialog('B', true)
    const paths = collect(tree, (el) => el.props?.className === 'rewind-path')
    ok(byTestId(tree, 'rewind-files').length === 1, 'cp-2 的响应正常显示')
    ok(paths.length === 1 && paths[0].props.children === 'new.ts', '显示的是新记录的文件，不是迟到的旧文件', paths.map((e) => e.props.children))
    pending.preview = null

    rewindStore.setState({ rewind: { recordId: 'cp-3', preview: USER_TEXT } })
    pending.preview = defer()
    renderDialog('A', true)
    renderDialog('A', false)
    renderDialog('A', false)
    ok(rewindStore.getState().rewind === null, '视图失活（active=false）：关闭对话框', rewindStore.getState().rewind)
    pending.preview.resolve({ ok: true, changes: [], total: 0 })
    await flush()
    pending.preview = null
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '有失败项'}：${report.pass} 通过 / ${report.fail} 失败\n`)
  process.exit(report.fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
