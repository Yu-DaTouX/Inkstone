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
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${pass ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  return pass
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function flush() {
  await sleep(0)
  await sleep(0)
  await sleep(0)
}

function installGlobals() {
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
}

function defer() {
  let resolveFn
  const promise = new Promise((r) => {
    resolveFn = r
  })
  return { promise, resolve: resolveFn }
}

const baseName = (p) => String(p).split(/[\\/]/).pop()
const okPreview = (p) => ({
  ok: true,
  path: p,
  abs: `C:/abs/${baseName(p)}`,
  name: baseName(p),
  size: 5,
  kind: 'text',
  text: `content:${p}`
})

function makeYan() {
  const calls = { readPreview: [], office: [], reveal: [], open: [] }
  const deferreds = new Map()
  const failures = new Map()
  const presets = new Map()
  const yan = {
    readPreview: async (p, line, cwd) => {
      calls.readPreview.push({ path: p, cwd })
      const d = deferreds.get(p)
      if (d) {
        deferreds.delete(p)
        return await d.promise
      }
      const bad = failures.get(p)
      if (bad) {
        failures.delete(p)
        return bad
      }
      const preset = presets.get(p)
      if (preset) return preset
      return okPreview(p)
    },
    office: {
      preview: async (abs, cwd) => {
        calls.office.push({ abs, cwd })
        return { ok: true, sections: [{ title: 'sheet', lines: [`office:${baseName(abs)}`] }], note: '' }
      }
    },
    revealPath: async (p) => {
      calls.reveal.push(p)
    },
    openPath: async (p) => {
      calls.open.push(p)
    }
  }
  return { yan, calls, deferreds, failures, presets }
}

function installWindow(yan) {
  globalThis.window = {
    yan,
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    location: { href: 'http://localhost/' }
  }
  globalThis.document = globalThis.document ?? {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}

const REACT_SHIM = `/* v3 预览归属回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
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

const LUCIDE_STUB = `function icon(){ return null }
export const Copy = icon
export const FileText = icon
export const FolderOpen = icon
export const Image = icon
export const ExternalLink = icon
export const RefreshCw = icon
export const TriangleAlert = icon
export const Pencil = icon
export const X = icon
export const BookOpen = icon
export const Code2 = icon
export const Database = icon
export const File = icon
export const FileArchive = icon
export const FileAudio = icon
export const FileCode = icon
export const FileImage = icon
export const FileJson = icon
export const FileSpreadsheet = icon
export const FileVideo = icon
`

const UI_STUB = `export function IconButton(props){ return { type: 'button', props: { ...props, 'data-testid': 'icon:' + String(props['aria-label']) } } }
export function Skeleton(){ return null }
export function Button(){ return null }
export function Notice(props){ return { type: 'div', props: { ...props, role: props.tone === 'fail' ? 'alert' : 'status' } } }
export function EmptyState(props){ return { type: 'div', props: { ...props, children: [props.title, props.description, props.action] } } }
export function PaneHeader(props){ return { type: 'div', props: { ...props, children: [props.title, props.actions] } } }
export function cx(...a){ return a.filter(Boolean).join(' ') }
`

const I18N_STUB = `export function useI18n(){ return { lang: 'zh-CN', t: (k) => String(k) } }
export function useT(){ return (k) => String(k) }
export function translate(_l, k){ return String(k) }
`

const STORE_STUB = `export function useStore(selector){ return selector(globalThis.__V3_PREVIEW_STORE) }
export function getState(){ return globalThis.__V3_PREVIEW_STORE }
`

function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/state/store.ts': STORE_STUB,
      'src/renderer/src/features/session/Markdown.tsx': 'export function Markdown(p){ return { type: "div", props: { children: p.text } } }',
      'src/renderer/src/features/editor/CodeEditor.tsx': 'export function CodeEditor(){ return null }'
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)

  const entry = join(outdir, 'preview-entry.ts')
  await writeFile(
    entry,
    `export { PreviewPane } from '${posix(resolve(ROOT, 'src/renderer/src/features/preview/PreviewPane'))}'
export * as sel from '${posix(resolve(ROOT, 'src/renderer/src/features/preview/preview-selection'))}'
`
  )

  const stubMap = makeStubMap()
  const define = {
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'process.env.NODE_ENV': '"production"'
  }
  const stubPlugin = {
    name: 'v3-preview-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'react') return { path: reactShim }
        if (args.path === 'react/jsx-runtime') return { path: jsxShim }
        if (args.path === 'react/jsx-dev-runtime') return { path: jsxShim }
        if (args.path === 'lucide-react') return { path: 'v3stub:lucide', namespace: 'v3stub' }
        if (args.path === 'react-dom') return { path: 'v3stub:react-dom', namespace: 'v3stub' }
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (stubMap.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        if (args.path === 'v3stub:lucide') return { contents: LUCIDE_STUB, loader: 'js' }
        if (args.path === 'v3stub:react-dom') return { contents: 'export function createPortal(){ return null }', loader: 'js' }
        const key = args.path.slice('v3stub:'.length)
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
      })
    }
  }

  const out = join(outdir, 'preview-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
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
  return out
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
      if (guard >= 100) throw new Error('浅渲染未收敛（疑似 render 里无限 setState）')
      return tree
    }
  }
  return rt
}

function expand(node) {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props || {}))
  const props = node.props || {}
  if (props.children !== undefined) return { ...node, props: { ...props, children: expand(props.children) } }
  return node
}

function collect(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  const kids = node.props && node.props.children
  if (kids !== undefined) collect(kids, pred, out)
  return out
}

const treeText = (tree) => JSON.stringify(tree)
const firstButton = (tree) => collect(tree, (n) => n.type === 'button' && typeof n.props.onClick === 'function')[0]
const retryButton = (tree) => collect(tree, (n) => n.props && n.props['data-testid'] === 'icon:重试')[0]

const ARTIFACT_A = {
  id: 'art-a',
  sourceId: 'src-a',
  filename: 'a.md',
  path: 'C:/proj/a/a.md',
  mediaType: 'text/markdown',
  kind: 'document'
}
const ARTIFACT_B = {
  id: 'art-b',
  sourceId: 'src-b',
  filename: 'b.md',
  path: 'C:/proj/b/b.md',
  mediaType: 'text/markdown',
  kind: 'document'
}

const OWNER_A = { key: 'A-key', sessionId: 'sess-a', cwd: 'C:/proj/a', active: true }
const OWNER_B = { key: 'B-key', sessionId: 'sess-b', cwd: 'C:/proj/b', active: true }

function setStore({ sessionId, messages }) {
  globalThis.__V3_PREVIEW_STORE = {
    session: sessionId ? { sessionId } : null,
    messages: messages ?? []
  }
}

async function main() {
  installGlobals()
  const { yan, calls, deferreds, failures, presets } = makeYan()
  installWindow(yan)

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-preview-owner-'))
  let mod
  try {
    const bundle = await buildBundle(outdir)
    mod = await import(pathToFileURL(bundle).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }
  const { PreviewPane, sel } = mod

  let rt = null
  const newRuntime = () => {
    rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
  }
  const render = (props) => expand(rt.render(PreviewPane, props))
  const settle = async (props) => {
    render(props)
    await flush()
    return render(props)
  }
  const clickAndSettle = async (tree, props) => {
    firstButton(tree).props.onClick()
    return settle(props)
  }

  group('纯函数：作用域 / 点选 / 外部接管优先级')
  {
    const scopeA = sel.previewScopeKey({ key: 'A', cwd: 'C:/a' })
    const scopeA2 = sel.previewScopeKey({ key: 'A', cwd: 'C:/a2' })
    ok(scopeA !== scopeA2, 'cwd 不同视为不同作用域')
    ok(sel.previewScopeKey({ key: 'A', cwd: 'C:/a' }) === scopeA, '同一 owner+cwd 作用域键稳定')

    let table = new Map()
    table = sel.recordPreviewSelection(table, scopeA, 'C:/a/x.md', null)
    ok(sel.resolvePreviewPath(table.get(scopeA), null).path === 'C:/a/x.md', '没有外部 path 时用面板内点选')

    const changed = sel.resolvePreviewPath(table.get(scopeA), 'C:/a/y.md')
    ok(changed.externalChanged === true && changed.path === 'C:/a/y.md', '外部 path 变了就由外部接管')

    const same = sel.resolvePreviewPath(table.get(scopeA), null)
    ok(same.externalChanged === false && same.path === 'C:/a/x.md', '外部 path 未变时点选仍然有效')

    table = sel.dropPreviewSelection(table, scopeA)
    ok(table.get(scopeA) === undefined, '接管时能丢掉该作用域的点选')
    ok(sel.resolvePreviewPath(table.get(scopeA), 'C:/a/y.md').path === 'C:/a/y.md', '丢点选后只看外部 path')

    let evict = new Map()
    for (let i = 0; i < sel.MAX_PREVIEW_SCOPES + 2; i += 1) {
      evict = sel.recordPreviewSelection(evict, `S${i}`, `C:/p/${i}.md`, null)
    }
    ok(evict.size === sel.MAX_PREVIEW_SCOPES, `绑定表上限为 ${sel.MAX_PREVIEW_SCOPES}`, evict.size)
    ok(!evict.has('S0') && evict.has(`S${sel.MAX_PREVIEW_SCOPES + 1}`), '淘汰最久未用的作用域')

    ok(sel.previewBaseName('C:\\proj\\a\\a.md') === 'a.md', '文件名解析跨平台')
  }

  group('A 选 manifest → 切 B（path 同为 undefined）：不读 A、不显示 A')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    calls.readPreview.length = 0
    let tree = await settle({ owner: OWNER_A, path: undefined })
    ok(!!firstButton(tree), 'A 显示成果 manifest（空视图）')
    tree = await clickAndSettle(tree, { owner: OWNER_A, path: undefined })
    ok(treeText(tree).includes('content:C:/proj/a/a.md'), 'A 点选后显示 A 的内容')
    ok(calls.readPreview.length === 1 && calls.readPreview[0].path === 'C:/proj/a/a.md', 'A 的读取带上 A 的路径')
    ok(calls.readPreview[0].cwd === 'C:/proj/a', 'A 的读取用 A 的 cwd')
    const readsAfterA = calls.readPreview.length

    setStore({ sessionId: 'sess-b', messages: [{ id: 'm-b', artifacts: [ARTIFACT_B] }] })
    tree = await settle({ owner: OWNER_B, path: undefined })
    ok(!treeText(tree).includes('content:C:/proj/a/a.md'), 'B 首帧不显示 A 的内容')
    ok(calls.readPreview.length === readsAfterA, '切到 B 没有发起任何新读取（尤其没有 A 的路径）', calls.readPreview.slice(readsAfterA))
    ok(treeText(tree).includes('b.md'), 'B 显示自己的 manifest')
  }

  group('迟到的 A 回包不覆盖 B')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    calls.readPreview.length = 0
    let tree = render({ owner: OWNER_A, path: undefined })
    const d = defer()
    deferreds.set('C:/proj/a/a.md', d)
    firstButton(tree).props.onClick()
    render({ owner: OWNER_A, path: undefined })
    await flush()
    ok(calls.readPreview.length === 1, 'A 的读取已在途', calls.readPreview)

    setStore({ sessionId: 'sess-b', messages: [] })
    tree = await settle({ owner: OWNER_B, path: undefined })
    d.resolve(okPreview('C:/proj/a/a.md'))
    await flush()
    tree = render({ owner: OWNER_B, path: undefined })
    ok(!treeText(tree).includes('content:C:/proj/a/a.md'), '迟到 A 回包后 B 仍不显示 A 内容')
    ok(treeText(tree).includes('没有打开的预览'), 'B 保持空视图')
  }

  group('B 点自己的成果：走 B 的路径与 cwd')
  {
    newRuntime()
    setStore({ sessionId: 'sess-b', messages: [{ id: 'm-b', artifacts: [ARTIFACT_B] }] })
    calls.readPreview.length = 0
    let tree = await settle({ owner: OWNER_B, path: undefined })
    ok(!!firstButton(tree), 'B 显示自己的 manifest')
    tree = await clickAndSettle(tree, { owner: OWNER_B, path: undefined })
    ok(calls.readPreview.length === 1 && calls.readPreview[0].path === 'C:/proj/b/b.md', 'B 的读取用 B 的路径', calls.readPreview)
    ok(calls.readPreview[0].cwd === 'C:/proj/b', 'B 的读取用 B 的 cwd')
    ok(treeText(tree).includes('content:C:/proj/b/b.md'), 'B 显示自己的内容')
    ok(!treeText(tree).includes('content:C:/proj/a/a.md'), 'B 不显示 A 的内容')
  }

  group('同一个 owner 内外部 path 变了：外部接管，优先级清晰')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    calls.readPreview.length = 0
    let tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/one.md' })
    ok(calls.readPreview.length === 1 && calls.readPreview[0].path === 'C:/proj/a/one.md', '外部 path one 先读', calls.readPreview)
    ok(treeText(tree).includes('content:C:/proj/a/one.md'), '显示外部 path 的内容')

    tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/two.md' })
    ok(
      calls.readPreview.length === 2 && calls.readPreview[1].path === 'C:/proj/a/two.md',
      '同一 owner 内 path 变化会读新路径',
      calls.readPreview
    )
    ok(treeText(tree).includes('content:C:/proj/a/two.md'), '显示新路径内容')

    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    calls.readPreview.length = 0
    tree = await settle({ owner: OWNER_A, path: undefined })
    tree = await clickAndSettle(tree, { owner: OWNER_A, path: undefined })
    ok(treeText(tree).includes('content:C:/proj/a/a.md'), '先有面板内点选内容')
    tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/three.md' })
    ok(
      calls.readPreview[calls.readPreview.length - 1].path === 'C:/proj/a/three.md',
      '外部 path 换值后读的是外部路径',
      calls.readPreview
    )
    ok(treeText(tree).includes('content:C:/proj/a/three.md'), '外部 path 接管显示')
    ok(!treeText(tree).includes('content:C:/proj/a/a.md'), '旧点选内容不再显示')
  }

  group('读取失败后重试能恢复')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [] })
    calls.readPreview.length = 0
    failures.set('C:/proj/a/bad.md', { ok: false, path: 'C:/proj/a/bad.md', abs: '', name: 'bad.md', size: 0, kind: 'text', error: '越界' })
    let tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/bad.md' })
    ok(treeText(tree).includes('v3-preview-error'), '失败时显示错误')
    const retry = retryButton(tree)
    ok(!!retry && typeof retry.props.onPress === 'function', '重试按钮存在')
    retry.props.onPress()
    tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/bad.md' })
    ok(calls.readPreview.length === 2, '重试重新读取', calls.readPreview)
    ok(treeText(tree).includes('content:C:/proj/a/bad.md'), '重试后显示内容')
    ok(!treeText(tree).includes('v3-preview-error'), '重试后错误消失')
  }

  group('切回 A：A 自己的点选恢复，B 内容不残留')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    calls.readPreview.length = 0
    let tree = await settle({ owner: OWNER_A, path: undefined })
    tree = await clickAndSettle(tree, { owner: OWNER_A, path: undefined })
    ok(treeText(tree).includes('content:C:/proj/a/a.md'), 'A 点选并加载')

    setStore({ sessionId: 'sess-b', messages: [{ id: 'm-b', artifacts: [ARTIFACT_B] }] })
    tree = await settle({ owner: OWNER_B, path: undefined })
    tree = await clickAndSettle(tree, { owner: OWNER_B, path: undefined })
    ok(treeText(tree).includes('content:C:/proj/b/b.md'), 'B 点选并加载')

    setStore({ sessionId: 'sess-a', messages: [{ id: 'm-a', artifacts: [ARTIFACT_A] }] })
    tree = await settle({ owner: OWNER_A, path: undefined })
    ok(
      calls.readPreview[calls.readPreview.length - 1].path === 'C:/proj/a/a.md',
      '切回 A 恢复 A 的点选（重新按 A 的路径读取）',
      calls.readPreview
    )
    ok(treeText(tree).includes('content:C:/proj/a/a.md'), '切回 A 显示 A 的内容')
    ok(!treeText(tree).includes('content:C:/proj/b/b.md'), '不残留 B 的内容')
  }

  group('图片 abs 与 office 结果也按 owner 隔离')
  {
    newRuntime()
    setStore({ sessionId: 'sess-a', messages: [] })
    calls.readPreview.length = 0
    calls.office.length = 0
    presets.set('C:/proj/a/pic.png', {
      ok: true,
      path: 'C:/proj/a/pic.png',
      abs: 'C:/abs/pic.png',
      name: 'pic.png',
      size: 9,
      kind: 'image'
    })
    presets.set('C:/proj/a/doc.docx', {
      ok: true,
      path: 'C:/proj/a/doc.docx',
      abs: 'C:/abs/doc.docx',
      name: 'doc.docx',
      size: 20,
      kind: 'binary'
    })

    let tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/pic.png' })
    ok(treeText(tree).includes('file:///C:/abs/pic.png'), '图片显示主进程校验后的 abs 地址')
    setStore({ sessionId: 'sess-b', messages: [] })
    tree = await settle({ owner: OWNER_B, path: undefined })
    ok(!treeText(tree).includes('file:///C:/abs/pic.png'), '切 B 后不显示 A 的图片地址')

    setStore({ sessionId: 'sess-a', messages: [] })
    tree = await settle({ owner: OWNER_A, path: 'C:/proj/a/doc.docx' })
    ok(calls.office.length === 1 && calls.office[0].abs === 'C:/abs/doc.docx', 'office 走宿主提取', calls.office)
    ok(calls.office[0].cwd === 'C:/proj/a', 'office 用 A 的 cwd')
    ok(treeText(tree).includes('office:doc.docx'), 'A 显示 office 结果')
    setStore({ sessionId: 'sess-b', messages: [] })
    tree = await settle({ owner: OWNER_B, path: undefined })
    ok(!treeText(tree).includes('office:doc.docx'), '切 B 后不显示 A 的 office 结果')
    ok(!treeText(tree).includes('C:/abs/doc.docx'), '切 B 后不显示 A 的 office abs')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
