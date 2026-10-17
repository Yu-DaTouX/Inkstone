#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

const report = { pass: 0, fail: 0 }
let currentGroup = null

function group(name) {
  currentGroup = name
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

const REACT_SHIM = `/* v3 工作区回归的 React 浅渲染替身：hook 状态放在 globalThis.__V3_HOOKS。 */
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

const STUBS = {
  ui: `export function Tabs(){ return null }
export function TabList(){ return null }
export function Tab(){ return null }
export function IconButton(){ return null }
export function Button(){ return null }
export function Menu(){ return null }
export function MenuItem(){ return null }
export function MenuTrigger(){ return null }
export function Popover(){ return null }
export function cx(...a){ return a.filter(Boolean).join(' ') }`,
  overview: `export function OverviewPane(){ return null }`,
  i18n: `export function useI18n(){ return { lang: 'zh-CN', setLang(){}, toggleLang(){}, t: (k) => String(k) } }`,
  lucide: `export function X(){ return null }
export function Rows2(){ return null }
export function Columns2(){ return null }
export function Maximize2(){ return null }
export function Minimize2(){ return null }
export function ExternalLink(){ return null }
export function ArrowLeft(){ return null }
export function FolderOpen(){ return null }
export function Globe(){ return null }
export function MoreHorizontal(){ return null }
export function Terminal(){ return null }`
}

function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': STUBS.ui,
      'src/renderer/src/i18n/index.tsx': STUBS.i18n,
      'src/renderer/src/features/workbench/OverviewPane.tsx': STUBS.overview
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)

  const entry = join(outdir, 'workbench-entry.ts')
  await writeFile(
    entry,
    `export { WorkbenchPanel } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/WorkbenchPanel'))}'
export { useUiV3, restorableWorkbenchTab } from '${posix(resolve(ROOT, 'src/renderer/src/state/ui-v3'))}'
export { emptyMountState, nextVisited, mountedTabs, MAX_MOUNTED_PANES } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/mount-state'))}'
export { bindPreviewPath, previewPathFor, MAX_PREVIEW_BINDINGS } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/preview-state'))}'
`
  )

  const stubMap = makeStubMap()
  const stubPlugin = {
    name: 'v3-workbench-stubs',
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

  const outfile = join(outdir, 'workbench-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'process.env.NODE_ENV': '"production"'
    },
    plugins: [stubPlugin]
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
    frames: [],
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
      rt.frames = []
      do {
        rt.dirty = false
        rt.idx = 0
        rt.effects = []
        tree = Component(props || {})
        rt.frames.push(tree)
        for (const fn of rt.effects) fn()
      } while (rt.dirty && ++guard < 100)
      if (guard >= 100) throw new Error('浅渲染未收敛（疑似 effect 里无限 setState）')
      return tree
    }
  }
  return rt
}

function childrenArray(kids) {
  if (kids === undefined || kids === null) return []
  return Array.isArray(kids) ? kids : [kids]
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const k of childrenArray(node.props?.children)) walk(k, visit)
}

function findClass(node, className) {
  let hit = null
  walk(node, (el) => {
    if (!hit && el?.props?.className === className) hit = el
  })
  return hit
}

function findByTestId(node, id) {
  let hit = null
  walk(node, (el) => {
    if (!hit && el?.props?.['data-testid'] === id) hit = el
  })
  return hit
}

function allClass(node, className) {
  const hits = []
  walk(node, (el) => {
    if (el?.props?.className === className) hits.push(el)
  })
  return hits
}

function paneSlots(tree) {
  return slotsIn(tree, 0)
}

function slotsIn(tree, index) {
  const wrap = allClass(tree, 'wb-panes')[index]
  if (!wrap) return []
  return childrenArray(wrap.props.children).filter(
    (el) => el && typeof el === 'object' && typeof el.type === 'function' && el.props && 'containerVisible' in el.props && 'tab' in el.props
  )
}

function slotFor(tree, tab) {
  return paneSlots(tree).find((s) => s.props.tab === tab) ?? null
}

function renderSlot(slot, stubs) {
  const host = slot.type(slot.props)
  const leaf = childrenArray(host.props.children).find((el) => el && typeof el === 'object' && stubs.has(el.type))
  return { host, leaf }
}

const stubPane = (name) => {
  const C = function () {
    return null
  }
  Object.defineProperty(C, 'name', { value: name })
  return C
}

const ownerA = { key: 'sess-a', sessionId: 'sess-a', sessionFile: 'C:/data/a.jsonl', cwd: 'C:/proj/a', runId: 'run-a', generation: 1, active: true }
const ownerB = { key: 'sess-b', sessionId: 'sess-b', sessionFile: 'C:/data/b.jsonl', cwd: 'C:/proj/b', runId: 'run-b', generation: 1, active: true }
const idleA = { ...ownerA, runId: undefined, generation: undefined, active: false }

async function main() {
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-workbench-state-'))
  let mod
  try {
    const outfile = await buildBundle(outdir)
    const persisted = new Map([['inkstone.v3.prefs', JSON.stringify({ version: 1, workbenchTab: 'terminal' })]])
    globalThis.localStorage = {
      getItem: (key) => (persisted.has(key) ? persisted.get(key) : null),
      setItem: (key, value) => { persisted.set(key, String(value)) },
      removeItem: (key) => { persisted.delete(key) },
      clear: () => persisted.clear()
    }
    mod = await import(pathToFileURL(outfile).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { WorkbenchPanel, useUiV3, restorableWorkbenchTab, emptyMountState, nextVisited, mountedTabs, MAX_MOUNTED_PANES, bindPreviewPath, previewPathFor, MAX_PREVIEW_BINDINGS } = mod

  const PaneStubs = {
    changes: stubPane('ChangesStub'),
    terminal: stubPane('TerminalStub'),
    files: stubPane('FilesStub'),
    browser: stubPane('BrowserStub'),
    preview: stubPane('PreviewStub'),
    context: stubPane('ContextStub')
  }
  const stubSet = new Set(Object.values(PaneStubs))
  const panes = { ...PaneStubs }

  const hookRuntime = () => {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    return rt
  }
  const panelProps = (over = {}) => ({
    owner: ownerA,
    open: false,
    mode: 'docked',
    panes,
    onClose: () => {},
    onRequestActivation: async () => true,
    ...over
  })

  group('mount-state / preview-state 纯函数规则')
  {
    const empty = emptyMountState()
    ok(empty.size === 0, '初始 visited 为空集（默认关闭零挂载）')
    ok(nextVisited(empty, { open: false, activeTab: 'changes' }) === empty, '关闭时 visited 原样返回（不注销、不新建）')
    const opened = nextVisited(empty, { open: true, activeTab: 'changes' })
    ok(opened.has('changes') && opened.size === 1, '首次 open 只登记当前页签')
    ok(nextVisited(opened, { open: true, activeTab: 'changes' }) === opened, '同页签再次同步返回原引用（不触发重渲染）')
    ok(nextVisited(opened, { open: false, activeTab: 'terminal' }) === opened, '关闭不因 activeTab 变化而清 visited')
    const two = nextVisited(opened, { open: true, activeTab: 'terminal' })
    ok(two.has('changes') && two.has('terminal'), '打开新页签不丢已访问页签')
    let all = emptyMountState()
    const fixedTabs = ['changes', 'terminal', 'files', 'browser', 'preview', 'context', 'branch', 'logs', 'quota']
    for (const tab of fixedTabs) all = nextVisited(all, { open: true, activeTab: tab })
    ok(MAX_MOUNTED_PANES === 9 && mountedTabs(all).length === 9, '九个固定页签最多九块', { max: MAX_MOUNTED_PANES, mounted: mountedTabs(all).length })
    assert.deepEqual([...mountedTabs(all)], fixedTabs, '挂载顺序按固定页签顺序')

    const path = 'C:/proj/a/readme.md'
    let bindings = new Map()
    bindings = bindPreviewPath(bindings, 'sess-a', path)
    ok(previewPathFor(bindings, 'sess-a') === path, '正路径：绑定给 A 的路径能取回')
    ok(previewPathFor(bindings, 'sess-b') === undefined, '负路径：没有绑定的 B 取到 undefined，不是 A 的路径')
    ok(previewPathFor(bindings, null) === undefined, '没有 owner 时取回 undefined')
    ok(bindPreviewPath(bindings, null, 'C:/x') === bindings, 'owner 为空时不产生无主绑定')
    for (let i = 0; i < MAX_PREVIEW_BINDINGS + 1; i += 1) bindings = bindPreviewPath(bindings, `sess-${i}`, `C:/p/${i}.md`)
    ok(bindings.size === MAX_PREVIEW_BINDINGS, `绑定表封顶 ${MAX_PREVIEW_BINDINGS} 个 owner`, bindings.size)
    const rebound = bindPreviewPath(bindings, 'sess-a', 'C:/p/a2.md')
    ok(previewPathFor(rebound, 'sess-a') === 'C:/p/a2.md' && rebound.size === MAX_PREVIEW_BINDINGS, '重复 owner 移到末尾并封顶不涨')
  }

  group('恢复页签：终端 / 浏览器页签不在启动时隐式恢复')
  {
    ok(restorableWorkbenchTab('terminal') === 'overview', '恢复阶段把终端页签降级到概览，不隐式起 PTY')
    ok(restorableWorkbenchTab('browser') === 'overview', '恢复阶段把浏览器页签降级到概览，不隐式导航')
    ok(restorableWorkbenchTab('changes') === 'changes', '改动页原样恢复')
    ok(restorableWorkbenchTab('files') === 'files', '文件页原样恢复')
    ok(restorableWorkbenchTab('preview') === 'preview', '预览页原样恢复')
    ok(restorableWorkbenchTab('context') === 'context', '上下文页是只读页签，按同一规则原样恢复')
    ok(
      useUiV3.getState().workspaceTab === 'overview',
      '持久化 terminal 时真实 store 的初始视图是概览（只点开工作区不会隐式起 PTY）',
      useUiV3.getState().workspaceTab
    )
  }

  group('WorkbenchPanel：默认关闭零挂载 / open 才挂 / close 保活')
  {
    useUiV3.setState({ workspaceTab: 'changes', workspaceOpen: false })
    const rt = hookRuntime()
    let tree = rt.render(WorkbenchPanel, panelProps({ open: false }))
    ok(paneSlots(tree).length === 0, '默认关闭：一个 PaneSlot 都不挂', paneSlots(tree).map((s) => s.props.tab))
    ok(!findByTestId(tree, 'wb-pane-changes'), '默认关闭：没有 wb-pane-changes 宿主节点')

    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    ok(paneSlots(tree).length === 1 && slotFor(tree, 'changes'), '首次 open：只挂当前 activeTab（changes）', paneSlots(tree).map((s) => s.props.tab))

    useUiV3.getState().setWorkspaceTab('terminal')
    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    let tabs = paneSlots(tree).map((s) => s.props.tab)
    ok(tabs.includes('changes') && tabs.includes('terminal'), '打开终端后 changes 与 terminal 并存', tabs)

    const beforeSwitch = paneSlots(tree).map((s) => ({ tab: s.props.tab, key: s.key, idx: paneSlots(tree).indexOf(s) }))
    const terminalBefore = beforeSwitch.find((p) => p.tab === 'terminal')

    useUiV3.getState().setWorkspaceTab('files')
    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    tabs = paneSlots(tree).map((s) => s.props.tab)
    ok(tabs.includes('terminal') && tabs.includes('files'), '切到文件页签后终端仍在挂载集合里', tabs)
    const terminalAfter = paneSlots(tree)
      .map((s, idx) => ({ tab: s.props.tab, key: s.key, idx }))
      .find((p) => p.tab === 'terminal')
    ok(
      terminalAfter && terminalBefore && terminalAfter.idx === terminalBefore.idx && terminalAfter.key === terminalBefore.key,
      '切页签后终端的 key 与兄弟位置不变（React 不会重挂原终端）',
      { terminalBefore, terminalAfter }
    )

    tree = rt.render(WorkbenchPanel, panelProps({ open: false }))
    tabs = paneSlots(tree).map((s) => s.props.tab)
    ok(tabs.includes('terminal') && tabs.includes('files'), '关闭面板清不掉 visited：终端/文件实例保留', tabs)
    const closedTerminal = slotFor(tree, 'terminal')
    ok(closedTerminal.props.containerVisible === false, '关闭后容器 visible=false（隐藏而非卸载）')

    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    tabs = paneSlots(tree).map((s) => s.props.tab)
    ok(tabs.includes('terminal') && tabs.includes('files') && !tabs.includes('browser'), '重新打开沿用已访问集合，未访问页签仍不挂', tabs)
    ok(!tabs.includes('context'), '未点开的上下文页签不挂载（只读但不预建）', tabs)
  }

  group('WorkbenchPanel：owner 切换先隐藏旧 owner；active/visible 双门')
  {
    useUiV3.setState({ workspaceTab: 'terminal' })
    const rt = hookRuntime()
    let tree = rt.render(WorkbenchPanel, panelProps({ owner: idleA, open: true }))
    let slot = slotFor(tree, 'terminal')
    ok(slot.props.containerVisible === true, '容器可见门：面板开 + 是当前页签 + ownerReady')
    ok(slot.props.blocked === true, '未激活门：terminal 需要激活，blocked=true')
    let { host, leaf } = renderSlot(slot, stubSet)
    ok(slot.type(slot.props).props['data-testid'] === 'wb-pane-terminal', 'PaneSlot 渲染出 wb-pane-terminal 宿主')
    ok(leaf?.props?.visible === false, '双门结果：containerVisible 为真但 blocked，叶子 visible=false')
    ok(!!findByTestId(slot.type(slot.props), 'wb-pane-activate'), '未激活时盖上「先激活」提示')

    tree = rt.render(WorkbenchPanel, panelProps({ owner: ownerA, open: true }))
    slot = slotFor(tree, 'terminal')
    ok(slot.props.blocked === false, '已激活：blocked=false')
    ;({ leaf } = renderSlot(slot, stubSet))
    ok(leaf?.props?.visible === true, '双门结果：已激活叶子 visible=true')
    ok(!findByTestId(slot.type(slot.props), 'wb-pane-activate'), '已激活不再显示提示')
  }

  group('WorkbenchPanel：A 预览 → 切 B 不给 A path → 回 A 规则明确')
  {
    useUiV3.setState({ workspaceTab: 'files' })
    const rt = hookRuntime()
    const A_PATH = 'C:/proj/a/readme.md'
    let tree = rt.render(WorkbenchPanel, panelProps({ owner: ownerA, open: true }))
    let filesSlot = slotFor(tree, 'files')
    ok(filesSlot.props.previewPath === undefined, '未预览前不给路径')
    filesSlot.props.onPreview(A_PATH)

    tree = rt.render(WorkbenchPanel, panelProps({ owner: ownerA, open: true }))
    filesSlot = slotFor(tree, 'files')
    ok(filesSlot.props.previewPath === A_PATH, 'A 预览后文件页签拿到 A 的路径（正对照）')
    const framesA = rt.frames.map((f) => slotFor(f, 'files')).filter(Boolean)
    ok(framesA.some((s) => s.props.owner.key === 'sess-a' && s.props.previewPath === A_PATH), '存在「owner=A 且 path=A」的帧')

    tree = rt.render(WorkbenchPanel, panelProps({ owner: ownerB, open: true }))
    const badFrame = rt.frames
      .map((f) => slotFor(f, 'files'))
      .filter(Boolean)
      .find((s) => s.props.owner.key === 'sess-b' && s.props.previewPath === A_PATH)
    ok(!badFrame, '负对照：切 B 的每一帧都没有「owner=B + A 的 path」', badFrame?.props?.previewPath)
    filesSlot = slotFor(tree, 'files')
    ok(filesSlot.props.owner.key === 'sess-b' && filesSlot.props.previewPath === undefined, '收敛帧：B 没有绑定，路径为 undefined')
    const { leaf } = renderSlot(filesSlot, stubSet)
    ok(leaf?.props?.path === undefined, '传给 B 叶子的 path 确实是 undefined（不是靠 effect 稍后清）')
    ok(leaf?.props?.owner?.cwd === 'C:/proj/b', 'B 的叶子只拿到 B 自己的 cwd')

    tree = rt.render(WorkbenchPanel, panelProps({ owner: ownerA, open: true }))
    filesSlot = slotFor(tree, 'files')
    ok(filesSlot.props.owner.key === 'sess-a' && filesSlot.props.previewPath === A_PATH, '回 A 后恢复 A 的路径（每条 owner 各自绑定）')
  }

  group('WorkbenchPanel：拆分两格 / 专注单格 / 弹出为禁用占位')
  {
    useUiV3.setState({ workspaceTab: 'changes', workspaceSplit: false, workspaceFocus: false, workspaceSplitTab: 'context' })
    const rt = hookRuntime()
    let tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    ok(allClass(tree, 'wb-panes').length === 1, '不拆分时只有一块容器')
    ok(findByTestId(tree, 'wb-split')?.props?.isDisabled !== true, '拆分按钮可用（未专注）')
    ok(findByTestId(tree, 'wb-popout')?.props?.isDisabled === true, '弹出按钮是禁用占位')
    ok(String(findByTestId(tree, 'wb-popout')?.props?.title ?? '').includes('未迁移'), '弹出按钮标注「未迁移」')

    useUiV3.getState().setWorkspaceSplit(true)
    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    ok(allClass(tree, 'wb-panes').length === 2, '拆分后上下两格各一块容器', allClass(tree, 'wb-panes').length)
    ok(!!findByTestId(tree, 'wb-split-secondary'), '渲染出下半格')
    const primary = slotsIn(tree, 0)
    const secondary = slotsIn(tree, 1)
    ok(primary.some((s) => s.props.tab === 'changes' && s.props.containerVisible), '主格显示当前页签')
    ok(secondary.some((s) => s.props.tab === 'context' && s.props.containerVisible), '下半格显示上下文页签')
    ok(!primary.some((s) => s.props.tab === 'context'), '上下文页签只在下半格挂一份')
    const ctxSlot = secondary.find((s) => s.props.tab === 'context')
    ok(!!ctxSlot, '下半格里的上下文挂载位可定位')
    const { leaf } = renderSlot(ctxSlot, stubSet)
    ok(leaf?.type?.name === 'ContextStub', '下半格的上下文页签拿到真实叶子组件', leaf?.type?.name)

    useUiV3.getState().setWorkspaceFocus(true)
    tree = rt.render(WorkbenchPanel, panelProps({ open: true }))
    ok(tree.props['data-focus'] === '1', '专注时面板带 data-focus=1')
    ok(allClass(tree, 'wb-panes').length === 1, '专注时只留一块容器')
    const focused = slotsIn(tree, 0)
    ok(focused.some((s) => s.props.tab === 'changes' && s.props.containerVisible), '专注时当前页签可见')
    ok(
      focused.find((s) => s.props.tab === 'context')?.props.containerVisible === false,
      '专注时下半格页签隐藏但保活'
    )
    useUiV3.getState().setWorkspaceFocus(false)
    useUiV3.getState().setWorkspaceSplit(false)
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
