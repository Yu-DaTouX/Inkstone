#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
export function Switch() { return null }`

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
        return { contents: stubMap.get(key) ?? 'export {}', loader: 'js' }
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
    `export { buildTreeView, initialCollapsedForLeaf, parseTreePayload } from '${posix(resolve(ROOT, 'src/shared/native-session'))}'
export { BranchTree, loadBranchTree, navigateBranch, nestBranchRows, renderBranchNodes, branchText } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/BranchTree'))}'
export { Tree, TreeItem, TreeItemContent, TreeChevron, TreeItemLabel, TreeEmptyState } from '${posix(UI_TREE_PATH)}'
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
    `import { Tree } from '${posix(UI_TREE_PATH)}'`,
    `import { nestBranchRows, renderBranchNodes, branchText } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/BranchTree'))}'`,
    `import { buildTreeView, initialCollapsedForLeaf } from '${posix(resolve(ROOT, 'src/shared/native-session'))}'`,
    'export { React, renderToStaticMarkup, Tree, nestBranchRows, renderBranchNodes, branchText, buildTreeView, initialCollapsedForLeaf }'
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
        if (args.path === 'v3stub:ui') return { contents: UI_STUB, loader: 'js' }
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
function itemById(node, TreeItem, id) {
  return findAllByType(node, TreeItem).find((el) => el.props?.id === id) ?? null
}
function itemChildIds(node, TreeItem, id) {
  const el = itemById(node, TreeItem, id)
  if (!el) return null
  return childrenArray(el.props?.children)
    .filter((child) => child && child.type === TreeItem)
    .map((child) => child.props.id)
}
function rowIds(node, TreeItem) {
  return findAllByType(node, TreeItem)
    .map((el) => el.props?.id)
    .filter((id) => typeof id === 'string')
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
              { entry: { id: 'a2', parentId: 'a1', type: 'message', message: { role: 'assistant', content: 'again' } }, children: [] }
            ]
          }
        ]
      },
      {
        entry: { id: 'u2', parentId: null, type: 'message', message: { role: 'user', content: 'side' } },
        children: [{ entry: { id: 'b1', parentId: 'u2', type: 'message', message: { role: 'assistant', content: 'side answer' } }, children: [] }]
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
    buildTreeView,
    initialCollapsedForLeaf,
    parseTreePayload,
    BranchTree,
    loadBranchTree,
    navigateBranch,
    nestBranchRows,
    Tree,
    TreeItem
  } = mod

  group('shared/native-session 纯投影与 nestBranchRows 受限嵌套')
  {
    const { tree, leafId } = treeFixture()
    const collapsed = initialCollapsedForLeaf(tree, leafId)
    ok(collapsed.has('u2'), '非活动分支 u2 默认折叠')
    ok(!collapsed.has('u1') && !collapsed.has('a1'), '活动路径 u1 / a1 默认展开')

    const view = buildTreeView(tree, leafId, collapsed)
    ok(view.leafId === 'a2', 'leafId 原样带回')
    assert.deepEqual(view.activePath, ['u1', 'a1', 'a2'], '活动路径 = leaf→根')
    const ids = view.rows.map((r) => r.entryId)
    assert.deepEqual(ids, ['u1', 'a1', 't1', 'a2', 'u2'], '折叠后只渲染 u2 一行')
    const byId = new Map(view.rows.map((r) => [r.entryId, r]))
    ok(byId.get('a2').leaf === true, 'leaf 行标记 leaf')
    ok(byId.get('u1').onActiveBranch && byId.get('a1').onActiveBranch && byId.get('a2').onActiveBranch, '活动路径三行标 active')
    ok(!byId.get('t1').onActiveBranch && !byId.get('u2').onActiveBranch, '旁支不标 active')
    ok(byId.get('u2').folded === true && byId.get('u2').hiddenCount === 1, '折叠行记隐藏后代数')
    ok(byId.get('u1').kind === 'user' && byId.get('a1').kind === 'assistant' && byId.get('t1').kind === 'tool', '条目类型投影正确')

    const parsed = parseTreePayload({ tree, leafId, extra: 1 })
    ok(parsed.tree.length === 2 && parsed.leafId === 'a2', 'parseTreePayload 取树与 leaf')
    ok(parseTreePayload(null).tree.length === 0 && parseTreePayload(null).leafId === null, '缺字段退回空树')

    const nested = nestBranchRows(view.rows)
    assert.deepEqual(nested.map((n) => n.row.entryId), ['u1', 'u2'], '嵌套根 = 可见顶层行')
    const nById = new Map(nested.map((n) => [n.row.entryId, n]))
    assert.deepEqual(nById.get('u1').children.map((n) => n.row.entryId), ['a1'], 'u1 的子节点 = a1')
    assert.deepEqual(
      nById.get('u1').children[0].children.map((n) => n.row.entryId),
      ['t1', 'a2'],
      'a1 的子节点保持顺序 t1 / a2'
    )
    assert.deepEqual(nById.get('u2').children, [], '折叠的 u2 不产生子节点（保护仍生效）')
    const deep = nestBranchRows([
      { entryId: 'r', depth: 0 },
      { entryId: 'c', depth: 1 },
      { entryId: 'g', depth: 2 }
    ])
    ok(deep.length === 1 && deep[0].children[0].children[0].row.entryId === 'g', '连续 depth 还原为三层嵌套')
    assert.deepEqual(nestBranchRows([]), [], '空行还原为空嵌套')
  }

  group('请求绑定 expectedSessionId；navigate 只发 entryId，不带 summarize')
  {
    const t = controlledTransport()
    const load = loadBranchTree(t, 'sess-a', '加载失败')
    assert.deepEqual(t.calls[0], { action: 'tree', expectedSessionId: 'sess-a' }, 'tree 请求只带 action + expectedSessionId')
    t.pending[0].resolve({ ok: true, tree: treeFixture().tree, leafId: 'a2', requiresReload: true })
    const loaded = await load
    ok(loaded.ok && loaded.tree.length === 2 && loaded.leafId === 'a2', '成功时解析出树与 leaf')

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

  group('BranchTree：加载、RAC 树接线、切换、忙禁用、错误重试')
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

    const treeEl = findByType(tree, Tree)
    ok(treeEl && treeEl.props['aria-label'] === '会话树', '树容器带 aria-label（交给 RAC 原语）')
    ok(treeEl.props.selectionMode === 'single', '单选交给 RAC selectionMode')
    ok(treeEl.props.selectionBehavior === 'replace', '用 replace 让 Enter / 双击才触发显式激活（单击只选中）')
    ok(Array.isArray(treeEl.props.selectedKeys) && treeEl.props.selectedKeys.includes('a2'), '选中集合 = 当前叶子')
    ok(treeEl.props.expandedKeys.has('u1') && treeEl.props.expandedKeys.has('a1'), '展开集合包含活动路径父行')
    ok(!treeEl.props.expandedKeys.has('u2'), '折叠的非活动行不在展开集合')

    assert.deepEqual(itemChildIds(tree, TreeItem, 'u1'), ['a1'], 'u1 行内嵌 a1')
    assert.deepEqual(itemChildIds(tree, TreeItem, 'a1').slice().sort(), ['a2', 't1'], 'a1 行内嵌 t1 / a2')
    assert.deepEqual(itemChildIds(tree, TreeItem, 'u2'), [], 'u2 没有内嵌子行')
    ok(findAllByType(tree, TreeItem).find((el) => el.props.id === 'a2')?.props.className.includes('branch-node--leaf'), '当前叶子行带语义标记类')

    treeEl.props.onExpandedChange(new Set(['u1', 'a1', 'u2']))
    tree = await flush(rt, BranchTree, props)
    ok(rowIds(tree, TreeItem).includes('b1'), '展开 u2 后出现其子行 b1')
    ok(findByType(tree, Tree).props.expandedKeys.has('u2'), 'u2 进入 RAC 展开集合')
    findByType(tree, Tree).props.onExpandedChange(new Set(['u1']))
    tree = await flush(rt, BranchTree, props)
    ok(!rowIds(tree, TreeItem).includes('a2') && !rowIds(tree, TreeItem).includes('t1'), '收起 a1 后隐藏其子行')
    ok(!findByType(tree, Tree).props.expandedKeys.has('a1'), 'a1 退出 RAC 展开集合')
    findByType(tree, Tree).props.onExpandedChange(new Set(['u1', 'a1']))
    tree = await flush(rt, BranchTree, props)
    assert.deepEqual(itemChildIds(tree, TreeItem, 'a1').slice().sort(), ['a2', 't1'], '重新展开 a1 后子行恢复')

    const navButton = findByTestId(tree, 'branch-navigate')
    ok(navButton && navButton.props.isDisabled === true, '当前叶子就是选中行时禁用切换（不是假按钮）')

    treeEl.props.onSelectionChange(new Set(['a1']))
    tree = await flush(rt, BranchTree, props)
    const navButton2 = findByTestId(tree, 'branch-navigate')
    ok(navButton2.props.isDisabled === false, '选到非 leaf 行后切换可用')
    ok(!!itemById(tree, TreeItem, 'a1')?.props.onAction, '行带显式激活回调（Enter / 双击才导航）')
    navButton2.props.onPress()
    tree = await flush(rt, BranchTree, props)
    ok(t.calls.some((c) => c.action === 'navigate' && c.entryId === 'a1'), '点击切换发出 navigate(a1)')

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
    findByType(busyTree, Tree).props.onSelectionChange(new Set(['a1']))
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    const busyNav = findByTestId(busyTree, 'branch-navigate')
    ok(busyNav.props.isDisabled === true, 'busy 时禁用切换')
    busyNav.props.onPress()
    busyTree = await flush(rtBusy, BranchTree, { owner: ownerA, transport: tBusy, busy: true })
    ok(tBusy.calls.filter((c) => c.action === 'navigate').length === 0, 'busy 时不发 navigate 请求')
    ok(before === 1, '忙情形的对照计数未被污染')

    const rtErr = makeHookRuntime()
    globalThis.__V3_HOOKS = rtErr
    const tErr = controlledTransport()
    let errTree = rtErr.render(BranchTree, { owner: ownerA, transport: tErr })
    tErr.pending[0].resolve({ ok: false, error: 'boo' })
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(findByTestId(errTree, 'branch-tree-error'), '首次失败显示错误态')
    ok(findByTestId(errTree, 'branch-retry'), '错误态提供重试')
    findByTestId(errTree, 'branch-retry').props.onPress()
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(tErr.calls.filter((c) => c.action === 'tree').length >= 2, '重试再次发请求')
    tErr.pending[1].resolve({ ok: true, ...treeFixture() })
    errTree = await flush(rtErr, BranchTree, { owner: ownerA, transport: tErr })
    ok(findByType(errTree, Tree), '重试成功后回到树')
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
    ok(rowIds(tree, TreeItem).includes('b-root'), 'B 的树渲染出来')
    ok(!rowIds(tree, TreeItem).includes('a2'), '此时还没有 A 的行')

    t.pending[0].resolve({ ok: true, ...treeFixture() })
    tree = await flush(rt, BranchTree, { owner: ownerB, transport: t })
    ok(rowIds(tree, TreeItem).includes('b-root'), '迟到 A 响应后仍显示 B 的树')
    ok(!rowIds(tree, TreeItem).includes('a2') && !rowIds(tree, TreeItem).includes('u1'), '旧 A 的树未覆盖新会话')

    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    const t2 = controlledTransport()
    let synced = 0
    const onNav = () => { synced += 1 }
    const propsA = { owner: ownerA, transport: t2, onNavigated: onNav }
    let late = rt2.render(BranchTree, propsA)
    t2.pending[0].resolve({ ok: true, ...treeFixture() })
    late = await flush(rt2, BranchTree, propsA)
    findByType(late, Tree).props.onSelectionChange(new Set(['a1']))
    late = await flush(rt2, BranchTree, propsA)
    findByTestId(late, 'branch-navigate').props.onPress()
    late = await flush(rt2, BranchTree, propsA)
    const navCall2 = t2.calls.find((c) => c.action === 'navigate')
    ok(navCall2 && navCall2.expectedSessionId === 'sess-a', '切换先发给 A')

    late = rt2.render(BranchTree, { owner: ownerB, transport: t2, onNavigated: onNav })
    t2.pending.find((p) => p.request === navCall2).resolve({ ok: true })
    late = await flush(rt2, BranchTree, { owner: ownerB, transport: t2, onNavigated: onNav })
    ok(synced === 0, '切走后迟到的 navigate 不回调 sync')
    ok(!!findByTestId(late, 'branch-tree-loading') || !!findByType(late, Tree), '迟到 navigate 不把面板改回旧状态')
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
              return { contents: stub.get(key) ?? 'export {}', loader: 'js' }
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

  group('静态边界：BranchTree 只接原语，branch-tree.css 不自画控件外观')
  {
    const src = await readFile(join(ROOT, 'src/renderer/src/features/session/BranchTree.tsx'), 'utf8')
    ok(src.includes("from '../../ui/Tree'"), 'BranchTree 从 ui/Tree 引入正式原语')
    for (const name of ['Tree,', 'TreeItem,', 'TreeChevron,', 'TreeItemLabel']) {
      ok(src.includes(name), `BranchTree 使用 ${name.replace(',', '')}`)
    }
    ok(!src.includes('role="tree"'), '不再出现旧 role="tree" 字符串')
    ok(!/aria-level\s*=/.test(src), '不再手写 aria-level（层级交给 RAC）')
    ok(!src.includes('onKeyDown'), '不再自建键盘处理（键盘交给 RAC）')

    const rawCss = await readFile(join(ROOT, 'src/renderer/src/features/session/branch-tree.css'), 'utf8')
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
    ok(!/\.branch-row\b/.test(css), '不再保留旧私有行的样式')
    const rowRules = css
      .split('}')
      .map((rule) => rule.split('{')[0])
      .filter((selector) => !selector.split(',').every((part) => /\.branch-bookmark(\[[^\]]*\])*\s*$/.test(part.trim())))
      .join('}')
    ok(!/:hover|:focus-visible|\[data-selected\]|\[data-disabled\]/.test(rowRules), '不自画 hover / 选中 / 焦点 / 禁用外观')
    ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '不写死颜色（只用令牌变量）')
    ok(css.includes('.branch-tree__list') && css.includes('.branch-kind'), '保留版面与语义标识类')
    ok(!css.includes('@import'), '模块 CSS 不 @import')
  }

  group('正式 Tree 原语：treegrid / aria-level / 展开 / 选中落在真实 DOM（SSR）')
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
    const { React, renderToStaticMarkup, Tree: RacTree, renderBranchNodes, branchText, buildTreeView, initialCollapsedForLeaf } = rac

    const { tree, leafId } = treeFixture()
    const view = buildTreeView(tree, leafId, initialCollapsedForLeaf(tree, leafId))
    const nodes = nestBranchRows(view.rows)
    const expandedKeys = new Set()
    const collect = (list) => {
      for (const node of list) {
        if (node.children.length) expandedKeys.add(node.row.entryId)
        collect(node.children)
      }
    }
    collect(nodes)

    const ctx = { text: branchText('zh-CN'), pending: null, onNavigate: () => {} }
    const element = React.createElement(
      RacTree,
      { 'aria-label': '会话树', selectionMode: 'single', selectionBehavior: 'replace', selectedKeys: ['a2'], expandedKeys },
      renderBranchNodes(nodes, ctx)
    )
    const html = renderToStaticMarkup(element)

    ok(html.includes('class="ui-tree') && html.includes('role="treegrid"'), 'RAC 渲染为 role="treegrid" 的 .ui-tree 容器')
    ok(html.includes('aria-label="会话树"'), '容器保留 aria-label')
    ok(!/role="tree"/.test(html), '不是用旧 role="tree" 冒充')

    ok(html.includes('aria-level="1"') && html.includes('aria-level="2"') && html.includes('aria-level="3"'), '真实嵌套产生 aria-level 1 / 2 / 3')
    ok((html.match(/aria-expanded="true"/g) ?? []).length >= 2, '已展开父行带 aria-expanded="true"')
    ok(html.includes('slot="chevron"') && html.includes('class="ui-tree__chevron"'), '行内是 RAC 的 chevron 展开按钮')

    ok(html.includes('aria-selected="true"') && html.includes('aria-selected="false"'), '选中 / 未选中都带 aria-selected')
    const leafTag = html.match(/<[^>]*data-key="a2"[^>]*>/)?.[0] ?? ''
    ok(leafTag.includes('aria-selected="true"'), '当前叶子行（data-key=a2）是选中行')
    ok(leafTag.includes('aria-level="3"'), '当前叶子行层级为 3（a1 的子节点）')

    const labelCount = (html.match(/class="ui-tree__label"/g) ?? []).length
    ok(labelCount === 5, `每个可见行都有 TreeItemLabel（${labelCount} 行）`)
    ok(html.includes('>again<') && html.includes('>hello<'), '真实条目文字进入 DOM（不截字符串）')
    ok(html.includes('branch-node--leaf'), '当前叶子行的语义标记类进入 DOM')

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
