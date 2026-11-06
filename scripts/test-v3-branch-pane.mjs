#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { fillMissingExports } from './lib/stub-exports.mjs'

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
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${extra}\n`)
  return pass
}

const REACT_SHIM = `const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useId() { return rt().useId() }
export function useContext(ctx) { return ctx && '__value' in ctx ? ctx.__value : null }
export function createContext(value) { return { __isContext: true, __value: value, Provider: (p) => (p ? p.children : null) } }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out, key: out.key === undefined ? null : out.key } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useId, useContext, createContext, createElement, forwardRef, memo }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
`

const UI_STUB = `export function Button() { return null }
export function IconButton() { return null }
export function Spinner() { return null }
export function Badge() { return null }
export function Dialog() { return null }
export function DialogTrigger() { return null }
export function Popover() { return null }
export function TextField() { return null }
export function Switch() { return null }
export function DialogFooter() { return null }
export function ListBox() { return null }
export function ListBoxItem() { return null }`

const TREE_STUB = `export function Tree() { return null }
export function TreeItem() { return null }
export function TreeItemContent() { return null }
export function TreeChevron() { return null }
export function TreeItemLabel() { return null }
export function TreeEmptyState() { return null }`

const I18N_STUB = `export function useI18n() { return { lang: 'zh-CN', setLang() {}, toggleLang() {}, t: (k) => String(k) } }`

const LUCIDE_NAMES = [
  'Activity', 'Archive', 'ChevronDown', 'ChevronRight', 'CornerDownRight', 'File', 'GitBranch',
  'Layers', 'Package', 'RefreshCw', 'Shield', 'Sparkles', 'Tag', 'Terminal', 'User'
]
const LUCIDE_STUB = LUCIDE_NAMES.map((name) => `export function ${name}() { return null }`).join('\n')

const UI_INDEX_PATH = normalize(resolve(ROOT, 'src/renderer/src/ui/index.ts'))
const UI_TREE_PATH = normalize(resolve(ROOT, 'src/renderer/src/ui/Tree.tsx'))
const UI_LISTBOX_PATH = normalize(resolve(ROOT, 'src/renderer/src/ui/ListBox.tsx'))
const I18N_PATH = normalize(resolve(ROOT, 'src/renderer/src/i18n/index.tsx'))

function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/ui/Tree.tsx': TREE_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

function stubPlugin(stubMap, reactShimPath, jsxShimPath) {
  return {
    name: 'v3-branch-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'react') return { path: reactShimPath }
        if (args.path === 'react/jsx-runtime') return { path: jsxShimPath }
        if (args.path === 'react/jsx-dev-runtime') return { path: jsxShimPath }
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
        if (args.path === 'v3stub:lucide') return { contents: LUCIDE_STUB, loader: 'js' }
        const key = args.path.slice('v3stub:'.length)
        return { contents: fillMissingExports(key, stubMap.get(key) ?? 'export {}'), loader: 'js' }
      })
    }
  }
}

async function buildBehaviorBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entryFile = join(outdir, 'branch-entry.ts')
  await writeFile(
    entryFile,
    `export { parseTreePayload } from '${posix(resolve(ROOT, 'src/shared/native-session'))}'
export { BranchTree, BranchGraph, loadBranchTree, navigateBranch, branchText } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/BranchTree'))}'
export { Badge, Button, IconButton, Spinner } from '${posix(UI_INDEX_PATH)}'
`
  )
  const outfile = join(outdir, 'branch-bundle.mjs')
  await build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    plugins: [stubPlugin(makeStubMap(), reactShim, jsxShim)]
  })
  return outfile
}

async function buildRacBundle(outdir) {
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import { BranchGraph, branchText } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/BranchTree'))}'`,
    `import { buildBranchLanes } from '${posix(resolve(ROOT, 'src/shared/branch-lanes'))}'`,
    'export { React, renderToStaticMarkup, BranchGraph, branchText, buildBranchLanes }'
  ].join('\n')
  const outfile = join(outdir, 'branch-rac.bundle.cjs')
  const plugin = {
    name: 'v3-branch-rac-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'lucide-react') return { path: 'v3stub:lucide', namespace: 'v3stub' }
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (key === UI_INDEX_PATH) return { path: 'v3stub:ui', namespace: 'v3stub' }
          if (key === I18N_PATH) return { path: 'v3stub:i18n', namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        if (args.path === 'v3stub:lucide') return { contents: LUCIDE_STUB, loader: 'js' }
        if (args.path === 'v3stub:ui') return { contents: `${UI_STUB.replace(/export function ListBox(Item)?\(\) \{ return null \}\n?/g, '')}\nexport { ListBox, ListBoxItem } from '${posix(UI_LISTBOX_PATH)}'`, loader: 'js', resolveDir: ROOT }
        if (args.path === 'v3stub:i18n') return { contents: I18N_STUB, loader: 'js' }
        return { contents: 'export {}', loader: 'js' }
      })
    }
  }
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    plugins: [plugin]
  })
  return outfile
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

async function flush(rt, Component, props, rounds = 6) {
  let tree = null
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await Promise.resolve()
    tree = rt.render(Component, props)
  }
  return tree
}

function childrenArray(kids) {
  if (kids === undefined || kids === null || kids === false || kids === true) return []
  if (Array.isArray(kids)) return kids.flatMap(childrenArray)
  return [kids]
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const k of childrenArray(node.props?.children)) walk(k, visit)
}
function findByTestId(node, id) {
  let hit = null
  walk(node, (el) => {
    if (!hit && el?.props?.['data-testid'] === id) hit = el
  })
  return hit
}
function findAllByTestId(node, id) {
  const hits = []
  walk(node, (el) => {
    if (el?.props?.['data-testid'] === id) hits.push(el)
  })
  return hits
}
function findByType(node, type) {
  let hit = null
  walk(node, (el) => {
    if (!hit && el?.type === type) hit = el
  })
  return hit
}
function findAllByType(node, type) {
  const hits = []
  walk(node, (el) => {
    if (el?.type === type) hits.push(el)
  })
  return hits
}

const ownerA = { key: 'sess-a', sessionId: 'sess-a', sessionFile: 'C:/data/a.jsonl', cwd: 'C:/proj/a', active: true }
const ownerB = { key: 'sess-b', sessionId: 'sess-b', sessionFile: 'C:/data/b.jsonl', cwd: 'C:/proj/b', active: true }

function controlledTransport() {
  const pending = []
  return {
    calls: [],
    pending,
    request(request) {
      return new Promise((res) => {
        this.calls.push(request)
        pending.push({ request, resolve: res })
      })
    }
  }
}

function treeFixture() {
  return {
    tree: [
      {
        entry: { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'hello' }, timestamp: 't1' },
        children: [
          {
            entry: { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'hi' } },
            children: [
              { entry: { id: 't1', parentId: 'a1', type: 'message', message: { role: 'toolResult', toolName: 'read' } }, children: [] },
              { entry: { id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'side' } }, children: [{ entry: { id: 'b1', parentId: 'u2', type: 'message', message: { role: 'assistant', content: 'side answer' } }, children: [] }] },
              { entry: { id: 'a2', parentId: 'a1', type: 'message', message: { role: 'assistant', content: 'again' } }, children: [] }
            ]
          }
        ]
      }
    ],
    leafId: 'a2'
  }
}

function installSsrGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible'
  }
}

async function main() {
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-branch-'))
  let mod
  try {
    const outfile = await buildBehaviorBundle(outdir)
    mod = await import(pathToFileURL(outfile).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const {
    parseTreePayload,
    BranchTree,
    BranchGraph,
    loadBranchTree,
    navigateBranch
  } = mod
  const laneRows = (node) => findByType(node, BranchGraph)?.props.lanes.rows.map((row) => row.entryId) ?? []

  group('shared/native-session 树载荷解析')
  {
    const { tree, leafId } = treeFixture()
    const parsed = parseTreePayload({ tree, leafId, extra: 1 })
    ok(parsed.tree.length === 1 && parsed.leafId === 'a2', 'parseTreePayload 取树与 leaf')
    ok(parseTreePayload(null).tree.length === 0 && parseTreePayload(null).leafId === null, '缺字段退回空树')
  }

  group('请求绑定 expectedSessionId；navigate 只发 entryId，不带 summarize')
  {
    const t = controlledTransport()
    const load = loadBranchTree(t, 'sess-a', '加载失败')
    assert.deepEqual(t.calls[0], { action: 'tree', expectedSessionId: 'sess-a' }, 'tree 请求只带 action + expectedSessionId')
    t.pending[0].resolve({ ok: true, tree: treeFixture().tree, leafId: 'a2', requiresReload: true })
    const loaded = await load
    ok(loaded.ok && loaded.tree.length === 1 && loaded.leafId === 'a2', '成功时解析出树与 leaf')

    const t2 = controlledTransport()
    const nav = navigateBranch(t2, 'sess-a', 'a1', '失败')
    assert.deepEqual(t2.calls[0], { action: 'navigate', expectedSessionId: 'sess-a', entryId: 'a1' }, 'navigate 只带 action / expectedSessionId / entryId')
    ok(!('summarize' in t2.calls[0]) && !('args' in t2.calls[0]), '未携带 summarize 或其它参数')

    t2.pending[0].resolve({ ok: true })
    ok((await nav).ok === true, 'navigate 成功')

    const t3 = controlledTransport()
    const failed = navigateBranch(t3, 'sess-b', 'x', '动作失败')
    t3.pending[0].resolve({ ok: false, error: '会话已切换' })
    const failedRes = await failed
    ok(failedRes.ok === false && failedRes.error === '会话已切换', '失败原样带回宿主错误')

    const t4 = controlledTransport()
    const missing = loadBranchTree(t4, 'sess-a', '读取失败')
    t4.pending[0].resolve({ ok: false })
    ok((await missing).error === '读取失败', '宿主错误为空时用兜底文案')
  }

  group('BranchTree：加载、泳道图接线、切换到分支末尾、忙禁用、错误重试')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const t = controlledTransport()
    let navigated = 0
    const props = { owner: ownerA, transport: t, busy: false, onNavigated: () => { navigated += 1 } }

    let tree = rt.render(BranchTree, props)
    ok(findByTestId(tree, 'branch-tree-loading'), '首帧显示加载态')
    ok(t.calls.length === 1 && t.calls[0].expectedSessionId === 'sess-a', '加载请求绑定 owner.sessionId')

    t.pending[0].resolve({ ok: true, ...treeFixture() })
    tree = await flush(rt, BranchTree, props)

    const graph = findByType(tree, BranchGraph)
    ok(graph, '树载入后渲染泳道图')
    assert.deepEqual(laneRows(tree), ['u1', 't1', 'u2', 'a2'], '行 = 用户消息、分叉后的分支起点与当前位置，当前分支在最后')
    const byId = Object.fromEntries(graph.props.lanes.rows.map((row) => [row.entryId, row]))
    ok(byId.u1.targetId === 'a1' && byId.u2.targetId === 'b1', '每行的切换目标是这一段的末尾')
    ok(byId.a2.lane === 0 && byId.u1.lane === 0 && byId.u2.lane > 0, '当前分支在第 0 列，旁支向右')
    ok(graph.props.selected === 'a2', '默认选中当前位置所在行')

    const navButton = findByTestId(tree, 'branch-navigate')
    ok(navButton && navButton.props.isDisabled === true, '选中行就是当前位置时禁用切换（不是假按钮）')

    graph.props.onSelect('u2')
    tree = await flush(rt, BranchTree, props)
    ok(findByType(tree, BranchGraph).props.selected === 'u2', '选中交给泳道图回调')
    const navButton2 = findByTestId(tree, 'branch-navigate')
    ok(navButton2.props.isDisabled === false, '选到旁支后切换可用')
    ok(typeof findByType(tree, BranchGraph).props.onAction === 'function', '行带显式激活回调（Enter / 双击才导航）')
    navButton2.props.onPress()
    tree = await flush(rt, BranchTree, props)
    ok(t.calls.some((c) => c.action === 'navigate' && c.entryId === 'b1'), '切换到旁支末尾 b1，而不是旁支开头')

    const navCall = t.calls.find((c) => c.action === 'navigate')
    t.pending.find((p) => p.request === navCall).resolve({ ok: true })
    tree = await flush(rt, BranchTree, props)
    ok(navigated === 1, '切换成功后回调宿主 sync（refreshSessions）')
    ok(t.calls.filter((c) => c.action === 'tree').length >= 2, '切换后就地重取树')

    const before = t.calls.filter((c) => c.action === 'navigate').length
    const rtBusy = makeHookRuntime()
    globalThis.__V3_HOOKS = rtBusy
    const tBusy = controlledTransport()
    let busyTree = rtBusy.render(BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    tBusy.pending[0].resolve({ ok: true, ...treeFixture() })
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    findByType(busyTree, BranchGraph).props.onSelect('u2')
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    const busyNav = findByTestId(busyTree, 'branch-navigate')
    ok(busyNav.props.isDisabled === true, 'busy 时禁用切换')
    busyNav.props.onPress()
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    ok(tBusy.calls.filter((c) => c.action === 'navigate').length === 0, 'busy 时不发 navigate 请求')
    ok(before === 1, '忙情形的对照计数未被污染')
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: false })
    ok(tBusy.calls.filter((c) => c.action === 'tree').length === 2, '一轮结束（busy 变回 false）后原地重取树')

    const rtErr = makeHookRuntime()
    globalThis.__V3_HOOKS = rtErr
    const tErr = controlledTransport()
    let errTree = rtErr.render(BranchTree, { owner: ownerA, transport: tErr })
    tErr.pending[0].resolve({ ok: false, error: 'boo' })
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(!findByTestId(errTree, 'branch-tree-error'), '宿主短暂失败先自动重试，不立刻报错')
    for (let i = 1; i <= 3; i += 1) {
      for (let waited = 0; !tErr.pending[i] && waited < 3000; waited += 50) await new Promise((r) => setTimeout(r, 50))
      ok(!!tErr.pending[i], `第 ${i} 次自动重试已发出`)
      tErr.pending[i]?.resolve({ ok: false, error: 'boo' })
      errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    }
    ok(findByTestId(errTree, 'branch-tree-error'), '重试用尽后显示错误态')
    ok(findByTestId(errTree, 'branch-retry'), '错误态提供重试')
    findByTestId(errTree, 'branch-retry').props.onPress()
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(tErr.calls.filter((c) => c.action === 'tree').length >= 2, '重试再次发请求')
    tErr.pending[4].resolve({ ok: true, ...treeFixture() })
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(findByType(errTree, BranchGraph), '重试成功后回到泳道图')

    const rtRaw = makeHookRuntime()
    globalThis.__V3_HOOKS = rtRaw
    const tRaw = { calls: [], request(request) { this.calls.push(request); return Promise.reject(new TypeError('Electron contextBridge recursion depth exceeded.')) } }
    rtRaw.render(BranchTree, { owner: ownerA, transport: tRaw })
    const rawTree = await flush(rtRaw, BranchTree, { owner: ownerA, transport: tRaw })
    const rawError = findByTestId(rawTree, 'branch-tree-error')
    ok(rawError && !JSON.stringify(rawError, (key, value) => (key === 'title' ? undefined : value)).includes('contextBridge'), '异常原文不直接显示在面板里')
    ok(JSON.stringify(rawError).includes('contextBridge'), '异常原文放在悬停提示里')
    ok(tRaw.calls.length === 1, '异常不自动重试')
  }

  group('BranchTree：owner 切换使在途响应失效，旧树不覆盖新会话')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const t = controlledTransport()
    let tree = rt.render(BranchTree, { owner: ownerA, transport: t })
    ok(t.calls.length === 1 && t.calls[0].expectedSessionId === 'sess-a', '先为 A 发起请求')

    tree = rt.render(BranchTree, { owner: ownerB, transport: t })
    ok(t.calls.length === 2 && t.calls[1].expectedSessionId === 'sess-b', '切到 B 后为新会话重新取树')

    const treeB = {
      tree: [{ entry: { id: 'b-root', parentId: null, type: 'message', message: { role: 'user', content: 'B only' } }, children: [] }],
      leafId: 'b-root'
    }
    t.pending[1].resolve({ ok: true, ...treeB })
    tree = await flush(rt, BranchTree, { owner: ownerB, transport: t })
    ok(laneRows(tree).includes('b-root'), 'B 的树渲染出来')
    ok(!laneRows(tree).includes('a2'), '此时还没有 A 的行')

    t.pending[0].resolve({ ok: true, ...treeFixture() })
    tree = await flush(rt, BranchTree, { owner: ownerB, transport: t })
    ok(laneRows(tree).includes('b-root'), '迟到 A 响应后仍显示 B 的树')
    ok(!laneRows(tree).includes('a2') && !laneRows(tree).includes('u1'), '旧 A 的树未覆盖新会话')

    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    const t2 = controlledTransport()
    let synced = 0
    const onNav = () => { synced += 1 }
    const propsA = { owner: ownerA, transport: t2, onNavigated: onNav }
    let late = rt2.render(BranchTree, propsA)
    t2.pending[0].resolve({ ok: true, ...treeFixture() })
    late = await flush(rt2, BranchTree, propsA)
    findByType(late, BranchGraph).props.onSelect('u2')
    late = await flush(rt2, BranchTree, propsA)
    findByTestId(late, 'branch-navigate').props.onPress()
    late = await flush(rt2, BranchTree, propsA)
    const navCall2 = t2.calls.find((c) => c.action === 'navigate')
    ok(navCall2 && navCall2.expectedSessionId === 'sess-a', '切换先发给 A')

    late = rt2.render(BranchTree, { owner: ownerB, transport: t2, onNavigated: onNav })
    t2.pending.find((p) => p.request === navCall2).resolve({ ok: true })
    late = await flush(rt2, BranchTree, { owner: ownerB, transport: t2, onNavigated: onNav })
    ok(synced === 0, '切走后迟到的 navigate 不回调 sync')
    ok(!!findByTestId(late, 'branch-tree-loading') || !!findByType(late, BranchGraph), '迟到 navigate 不把面板改回旧状态')
    ok(t2.calls.filter((c) => c.action === 'navigate').length === 1, '切走后未再发 navigate')
  }

  group('BranchPane：归属透传、忙状态、无桥明确失败、导航后 refreshSessions')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt

    const storeState = { session: { sessionId: 'sess-a', isAgentRunning: false, isStreaming: false, isCompacting: false } }
    let refreshed = 0
    storeState.refreshSessions = async () => {
      refreshed += 1
    }
    globalThis.__STORE_STATE = storeState

    const stub = makeStubMap()
    const outdir2 = await mkdtemp(join(tmpdir(), 'yan-v3-branch-pane-'))
    const reactShim = join(outdir2, 'react-shim.mjs')
    const jsxShim = join(outdir2, 'jsx-shim.mjs')
    await writeFile(reactShim, REACT_SHIM)
    await writeFile(jsxShim, JSX_SHIM)
    const paneEntry = join(outdir2, 'pane-entry.ts')
    await writeFile(
      paneEntry,
      `export { BranchPane } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/BranchPane'))}'\nexport { BranchTree } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/BranchTree'))}'`
    )
    const storePath = normalize(resolve(ROOT, 'src/renderer/src/state/store.ts'))
    await build({
      entryPoints: [paneEntry],
      outfile: join(outdir2, 'pane.mjs'),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      jsx: 'automatic',
      resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
      loader: { '.css': 'empty' },
      plugins: [
        {
          name: 'pane-stubs',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.path === 'react') return { path: reactShim }
              if (args.path === 'react/jsx-runtime') return { path: jsxShim }
              if (args.path === 'react/jsx-dev-runtime') return { path: jsxShim }
              if (args.path === 'lucide-react') return { path: 'v3stub:lucide', namespace: 'v3stub' }
              if (/(^|\/)state\/store$/.test(args.path.replace(/\\/g, '/'))) return { path: 'v3stub:store', namespace: 'v3stub' }
              if (!args.importer || !args.resolveDir) return undefined
              const base = resolve(args.resolveDir, args.path)
              for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
                const key = normalize(base + e)
                if (key === storePath) return { path: 'v3stub:store', namespace: 'v3stub' }
                if (stub.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
              }
              return undefined
            })
            b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
              if (args.path === 'v3stub:lucide') return { contents: LUCIDE_STUB, loader: 'js' }
              if (args.path === 'v3stub:store') {
                return {
                  contents:
                    'export function useStore(selector) { return selector(globalThis.__STORE_STATE) }\nuseStore.getState = () => globalThis.__STORE_STATE',
                  loader: 'js'
                }
              }
              const key = args.path.slice('v3stub:'.length)
              return { contents: fillMissingExports(key, stub.get(key) ?? 'export {}'), loader: 'js' }
            })
          }
        }
      ]
    })
    const paneMod = await import(`${pathToFileURL(join(outdir2, 'pane.mjs')).href}?v=${Date.now()}`)

    globalThis.window = {}
    let paneTree = rt.render(paneMod.BranchPane, { owner: ownerA })
    ok(findByTestId(paneTree, 'v3-wb-branch'), 'BranchPane 渲染出页签容器')
    const treeEl = findByType(paneTree, paneMod.BranchTree)
    ok(treeEl && treeEl.props.owner === ownerA, 'BranchTree 收到当前 owner')
    ok(treeEl.props.busy === false, '会话不忙时 busy=false')
    const noBridge = await treeEl.props.transport.request({ action: 'tree', expectedSessionId: 'sess-a' })
    ok(noBridge.ok === false && /native|\u6865/i.test(noBridge.error), '无宿主桥时明确失败而非伪造空树')

    storeState.session.isStreaming = true
    paneTree = rt.render(paneMod.BranchPane, { owner: ownerA })
    ok(findByType(paneTree, paneMod.BranchTree).props.busy === true, '会话流式中 busy=true')

    paneTree = rt.render(paneMod.BranchPane, { owner: ownerB })
    ok(findByType(paneTree, paneMod.BranchTree).props.busy === false, 'owner 与运行会话不一致时不误判忙')

    findByType(paneTree, paneMod.BranchTree).props.onNavigated()
    ok(refreshed === 1, '导航成功后调用 refreshSessions')

    await rm(outdir2, { recursive: true, force: true })
  }

  group('泳道图落到真实 DOM：listbox / option / 选中 / 连线（SSR）')
  {
    installSsrGlobals()
    const require = createRequire(import.meta.url)
    const outdirRac = await mkdtemp(join(tmpdir(), 'yan-v3-branch-rac-'))
    let rac
    try {
      rac = require(await buildRacBundle(outdirRac))
    } catch (err) {
      process.stderr.write(`\n[RAC bundle 失败] ${err && err.stack ? err.stack : err}\n`)
      report.fail += 1
      await rm(outdirRac, { recursive: true, force: true })
      await rm(outdir, { recursive: true, force: true })
      process.exitCode = 1
      return
    }
    const { React, renderToStaticMarkup, BranchGraph: RacGraph, branchText, buildBranchLanes } = rac

    const { tree, leafId } = treeFixture()
    const lanes = buildBranchLanes(tree, leafId)
    const html = renderToStaticMarkup(
      React.createElement(RacGraph, { lanes, text: branchText('zh-CN'), selected: 'a2', pending: null, onSelect: () => {}, onAction: () => {} })
    )

    ok(html.includes('role="listbox"') && html.includes('aria-label="分支图"'), '行列表是带名称的 listbox')
    ok((html.match(/role="option"/g) ?? []).length === 4, '每个关键节点一个 option')
    const leafTag = html.match(/<[^>]*data-key="a2"[^>]*>/)?.[0] ?? ''
    ok(leafTag.includes('aria-selected="true"'), '当前位置所在行是选中行')
    ok((html.match(/class="branch-graph__edge"/g) ?? []).length === 3, '每个分支起点一条连线')
    ok((html.match(/data-active="1"/g) ?? []).length >= 2, '当前分支上的行与连线带活动标记')
    ok(html.includes('aria-hidden="true"') && html.includes('<svg'), '连线图对读屏隐藏')
    ok(html.includes('>hello<') && html.includes('>side<'), '真实条目文字进入 DOM')

    await rm(outdirRac, { recursive: true, force: true })
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
