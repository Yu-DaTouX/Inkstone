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
export function Checkbox() { return null }
export function CheckboxGroup() { return null }
export function Badge() { return null }
export function Dialog() { return null }
export function Modal() { return null }
export function ModalOverlay() { return null }
export function Spinner() { return null }`

const I18N_STUB = `export function useI18n() { return { lang: 'zh-CN', setLang() {}, toggleLang() {}, t: (k) => String(k) } }
export function useT() { return (k) => String(k) }`

const STORE_STUB = `export function useStore(selector) { return selector(globalThis.__STORE_STATE) }
useStore.getState = () => globalThis.__STORE_STATE`

const LUCIDE_STUB = ['AlertCircle', 'ArrowLeft', 'RotateCw'].map((name) => `export function ${name}() { return null }`).join('\n')

const UI_INDEX_PATH = normalize(resolve(ROOT, 'src/renderer/src/ui/index.ts'))
const I18N_PATH = normalize(resolve(ROOT, 'src/renderer/src/i18n/index.tsx'))
const STORE_PATH = normalize(resolve(ROOT, 'src/renderer/src/state/store.ts'))

function makeStubMap() {
  return new Map(
    Object.entries({
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/state/store.ts': STORE_STUB
    }).map(([rel, src]) => [normalize(resolve(ROOT, rel)), src])
  )
}

function stubPlugin(stubMap, reactShimPath, jsxShimPath) {
  return {
    name: 'v3-native-surfaces-stubs',
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
  const entryFile = join(outdir, 'surfaces-entry.ts')
  await writeFile(
    entryFile,
    `export * from '${posix(resolve(ROOT, 'src/renderer/src/features/session/native/native-surfaces-model'))}'
export * from '${posix(resolve(ROOT, 'src/renderer/src/features/session/native/NativeSessionSurfaces'))}'
export { Button, Checkbox, CheckboxGroup, Badge, Dialog, Modal, ModalOverlay, Spinner } from '${posix(UI_INDEX_PATH)}'
`
  )
  const outfile = join(outdir, 'surfaces-bundle.mjs')
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

async function buildSsrBundle(outdir) {
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import { ScopeModelsView, TrustPanel, EntriesPanel, nativeSurfaceText } from '${posix(resolve(ROOT, 'src/renderer/src/features/session/native/NativeSessionSurfaces'))}'`,
    'export { React, renderToStaticMarkup, ScopeModelsView, TrustPanel, EntriesPanel, nativeSurfaceText }'
  ].join('\n')
  const outfile = join(outdir, 'surfaces-ssr.bundle.cjs')
  const i18nPath = I18N_PATH
  const storePath = STORE_PATH
  const plugin = {
    name: 'v3-native-surfaces-ssr-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (!args.importer || !args.resolveDir) return undefined
        const base = resolve(args.resolveDir, args.path)
        for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const key = normalize(base + e)
          if (key === i18nPath) return { path: 'v3stub:i18n', namespace: 'v3stub' }
          if (key === storePath) return { path: 'v3stub:store', namespace: 'v3stub' }
        }
        return undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
        if (args.path === 'v3stub:i18n') return { contents: I18N_STUB, loader: 'js' }
        if (args.path === 'v3stub:store') return { contents: STORE_STUB, loader: 'js' }
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

const MODELS = [
  { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
  { provider: 'google', id: 'gemini-3', name: 'Gemini 3' }
]

function entryFixture(id, over = {}) {
  return { id, parentId: null, type: 'message', message: { role: 'user', content: `hi ${id}` }, timestamp: 't', ...over }
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
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-native-surfaces-'))
  let mod
  try {
    mod = await import(pathToFileURL(await buildBehaviorBundle(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const {
    isNativeSurfaceMode,
    buildScopedModelsView,
    scopeSaveIds,
    isScopeDirty,
    sameKeySet,
    buildTrustView,
    buildEntriesView,
    loadScopedModels,
    saveScopedModels,
    loadTrust,
    saveTrust,
    loadEntries,
    nativeSurfaceText,
    NativeSessionSurfaces,
    ScopeModelsSurface,
    TrustSurface,
    EntriesSurface,
    ScopeModelsView,
    TrustPanel,
    EntriesPanel,
    CheckboxGroup,
    Button
  } = mod

  const text = nativeSurfaceText('zh-CN')

  group('纯投影：模式判定 / 模型范围 / 信任 / 条目限量')
  {
    ok(isNativeSurfaceMode('scoped-models'), 'scoped-models 是合法面板模式')
    ok(isNativeSurfaceMode('trust') && isNativeSurfaceMode('entries'), 'trust / entries 是合法面板模式')
    ok(!isNativeSurfaceMode('tree'), 'tree 不由本模块消费')
    ok(!isNativeSurfaceMode('bogus') && !isNativeSurfaceMode(null), '未知模式判 false')

    const all = buildScopedModelsView(MODELS, [])
    ok(all.scopeIsAll === true && all.models.length === 3, '空选中 = 全部可用')
    ok(all.models.every((m) => m.inScope), '全部 inScope')

    const subset = buildScopedModelsView(MODELS, ['openai/gpt-5'])
    ok(subset.scopeIsAll === false, '有选中时 scopeIsAll=false')
    ok(subset.models.find((m) => m.key === 'openai/gpt-5').inScope === true, '选中的模型 inScope')
    ok(subset.models.find((m) => m.key === 'anthropic/claude-sonnet').inScope === false, '未选中的模型 not inScope')

    const current = buildScopedModelsView(MODELS, ['openai/gpt-5'], { provider: 'openai', id: 'gpt-5' })
    ok(current.models.find((m) => m.key === 'openai/gpt-5').current === true, '当前模型标 current')
    ok(current.models.find((m) => m.key === 'google/gemini-3').current === false, '其它模型不标 current')

    const dirtyModels = buildScopedModelsView(
      [...MODELS, { provider: '', id: 'x', name: 'bad' }, { provider: 'openai', id: 'gpt-5', name: 'dup' }],
      []
    )
    ok(dirtyModels.models.length === 3, '缺 provider 与重复键被丢弃')

    const keys = new Set(['a', 'b'])
    ok(scopeSaveIds(keys, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]).join(',') === 'a,b', '部分选择原样（排序）给出')
    ok(scopeSaveIds(new Set(['a', 'b', 'c']), [{ key: 'a' }, { key: 'b' }, { key: 'c' }]).length === 0, '显式全选写空数组（= 全部）')
    ok(scopeSaveIds(new Set(), [{ key: 'a' }]).length === 0, '清空写空数组')
    ok(scopeSaveIds(new Set(['a']), []).length === 0, '没有模型时写空数组')
    ok(isScopeDirty(new Set(['a']), new Set(['a', 'b'])) === true, '集合不同 = dirty')
    ok(isScopeDirty(new Set(['a', 'b']), new Set(['b', 'a'])) === false, '集合相同 = 不 dirty')
    ok(sameKeySet(new Set(['a', 'b']), new Set(['b', 'a'])) === true, 'sameKeySet 无序比较')

    const trustUn = buildTrustView({ cwd: 'C:/proj', trusted: false, trustEntry: null })
    ok(trustUn.cwd === 'C:/proj' && trustUn.trusted === false && trustUn.entry === null, '信任投影：未信任')
    ok(trustUn.requiresTrust === true, '缺省 requiresTrust=true（保守）')
    const trustIn = buildTrustView({ cwd: 'C:/p', trusted: true, trustEntry: 'C:/p', requiresTrust: false })
    ok(trustIn.trusted === true && trustIn.entry === 'C:/p' && trustIn.requiresTrust === false, '信任投影：命中条目与不要求信任')
    ok(buildTrustView({}).cwd === '' && buildTrustView({}).trusted === false, '缺字段按未信任 / 空处理')

    const entries = [
      entryFixture('u1'),
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'ok' } },
      { id: 't1', parentId: 'a1', type: 'message', message: { role: 'toolResult', toolName: 'read', content: 'file' } },
      { id: 'm1', parentId: 't1', type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
      { bad: true },
      null,
      { id: '', type: 'message' }
    ]
    const view = buildEntriesView(entries)
    ok(view.total === 4 && view.shown === 4 && !view.truncated, '只统计有字符串 id 的条目')
    assert.deepEqual(view.rows.map((r) => r.kind), ['user', 'assistant', 'tool', 'meta'], '条目种类按 describeEntry 投影')
    ok(view.rows[1].parentId === 'u1' && view.rows[0].parentId === null, 'parentId 规范化')

    const limited = buildEntriesView(entries, { maxRows: 2 })
    ok(limited.shown === 2 && limited.total === 4 && limited.truncated === true, '超过行数上限：只显示 N 条并如实标记')

    const scanned = buildEntriesView([entryFixture('a'), entryFixture('b'), entryFixture('c')], { scanMax: 2 })
    ok(scanned.total === 2 && scanned.truncated === true, '超过扫描上限：停止并标记截断')

    const empty = buildEntriesView(null)
    ok(empty.rows.length === 0 && empty.total === 0 && empty.truncated === false, '空 / 非数组返回空态')

    const preview = buildEntriesView([entryFixture('long', { message: { role: 'user', content: 'x'.repeat(500) } })], { previewMax: 20 })
    ok(preview.rows[0].preview.length <= 20, '预览字符受限')
  }

  group('请求绑定：expectedSessionId 与动作参数')
  {
    const t1 = controlledTransport()
    const loading = loadScopedModels(t1, 'sess-a', '读取失败')
    assert.deepEqual(t1.calls[0], { action: 'scoped-models', expectedSessionId: 'sess-a' }, 'scoped-models 只带 action + owner')
    t1.pending[0].resolve({ ok: true, models: MODELS, scopedModelIds: ['openai/gpt-5'] })
    const r1 = await loading
    ok(r1.ok && r1.view.models.length === 3, 'scoped-models 成功建视图')

    const t2 = controlledTransport()
    const saving = saveScopedModels(t2, 'sess-a', ['openai/gpt-5'], '失败')
    assert.deepEqual(t2.calls[0], { action: 'set-scoped-models', expectedSessionId: 'sess-a', modelIds: ['openai/gpt-5'] }, 'set-scoped-models 带完整键列表')
    t2.pending[0].resolve({ ok: true, requiresReload: true })
    const r2 = await saving
    ok(r2.ok && r2.requiresReload === true, '保存 requiresReload 原样带回')

    const t3 = controlledTransport()
    const cancelling = saveScopedModels(t3, 'sess-a', [], '失败')
    t3.pending[0].resolve({ ok: false, cancelled: true })
    const r3 = await cancelling
    ok(r3.ok === false && r3.cancelled === true, '取消归类为 cancelled，不是普通错误')

    const t4 = controlledTransport()
    const trust = loadTrust(t4, 'sess-a', '失败')
    assert.deepEqual(t4.calls[0], { action: 'trust', expectedSessionId: 'sess-a' }, 'trust 只带 action + owner')
    t4.pending[0].resolve({ ok: true, cwd: 'C:/p', trusted: true, trustEntry: 'C:/p' })
    const r4 = await trust
    ok(r4.ok && r4.view.trusted === true, 'trust 成功建视图')

    const t5 = controlledTransport()
    const savingTrust = saveTrust(t5, 'sess-a', false, '失败')
    assert.deepEqual(t5.calls[0], { action: 'set-trust', expectedSessionId: 'sess-a', trusted: false }, 'set-trust 明确带 trusted')
    t5.pending[0].resolve({ ok: true })
    ok((await savingTrust).ok === true, 'set-trust 成功')

    const t6 = controlledTransport()
    const entries = loadEntries(t6, 'sess-a', '失败')
    assert.deepEqual(t6.calls[0], { action: 'entries', expectedSessionId: 'sess-a' }, 'entries 默认不带 since')
    t6.pending[0].resolve({ ok: true, entries: [entryFixture('u1')] })
    ok((await entries).ok === true, 'entries 成功')

    const t7 = controlledTransport()
    void loadEntries(t7, 'sess-a', '失败', 'u1')
    assert.deepEqual(t7.calls[0], { action: 'entries', expectedSessionId: 'sess-a', since: 'u1' }, 'entries 带 since 时透传')

    const t8 = controlledTransport()
    const failed = loadTrust(t8, 'sess-a', '读取失败')
    t8.pending[0].resolve({ ok: false })
    ok((await failed).error === '读取失败', '宿主错误为空时用兜底文案')

    const t9 = controlledTransport()
    t9.request = () => Promise.reject(new Error('boom'))
    const thrown = await loadEntries(t9, 'sess-a', '失败')
    ok(thrown.ok === false && thrown.error === 'boom', '抛出的异常翻成失败结果')
  }

  group('ScopeModelsSurface：加载 / 勾选 / 保存 / 迟到 / 错误')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const t = controlledTransport()
    const props = { transport: t, sessionId: 'sess-a', text }
    let tree = rt.render(ScopeModelsSurface, props)
    ok(findByTestId(tree, 'native-surface-loading'), '首帧加载态')
    ok(t.calls.length === 1 && t.calls[0].expectedSessionId === 'sess-a', '加载请求绑定 owner.sessionId')

    t.pending[0].resolve({ ok: true, models: MODELS, scopedModelIds: ['openai/gpt-5'] })
    tree = await flush(rt, ScopeModelsSurface, props)
    let view = findByType(tree, ScopeModelsView)
    ok(!!view, '加载成功渲染模型范围')
    ok(view.props.models.length === 3 && view.props.selected.has('openai/gpt-5'), '选中模型带入勾选集合')
    ok(view.props.dirty === false && view.props.busy === false, '未改动时不可保存')

    view.props.onChange(['openai/gpt-5', 'anthropic/claude-sonnet'])
    tree = await flush(rt, ScopeModelsSurface, props)
    view = findByType(tree, ScopeModelsView)
    ok(view.props.dirty === true, '改动后可保存')
    view.props.onSave()
    tree = await flush(rt, ScopeModelsSurface, props)
    const saveCall = t.calls.find((c) => c.action === 'set-scoped-models')
    ok(!!saveCall && saveCall.expectedSessionId === 'sess-a', '保存发给打开时的 owner')
    assert.deepEqual(saveCall.modelIds, ['anthropic/claude-sonnet', 'openai/gpt-5'], '保存完整键列表（排序）')

    t.pending.find((p) => p.request === saveCall).resolve({ ok: true })
    tree = await flush(rt, ScopeModelsSurface, props)
    view = findByType(tree, ScopeModelsView)
    ok(view.props.notice === text.scope.saved && view.props.error === '', '保存成功显示提示')
    ok(view.props.dirty === false, '保存后回到未改动')

    view.props.onSelectAll()
    tree = await flush(rt, ScopeModelsSurface, props)
    view = findByType(tree, ScopeModelsView)
    ok(view.props.selected.size === 3 && view.props.dirty === true, '全选包含全部模型')
    view.props.onSave()
    tree = await flush(rt, ScopeModelsSurface, props)
    const allCall = t.calls.filter((c) => c.action === 'set-scoped-models').at(-1)
    assert.deepEqual(allCall.modelIds, [], '显式全选写空数组（pi 空 = 全部）')
    t.pending.find((p) => p.request === allCall).resolve({ ok: true })
    tree = await flush(rt, ScopeModelsSurface, props)
    view = findByType(tree, ScopeModelsView)
    ok(view.props.scopeIsAll === true, '保存全选后显示「全部可用」')

    view.props.onClear()
    tree = await flush(rt, ScopeModelsSurface, props)
    view = findByType(tree, ScopeModelsView)
    ok(view.props.selected.size === 0 && view.props.dirty === true, '清空相对全部可用也是改动')

    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    const t2 = controlledTransport()
    rt2.render(ScopeModelsSurface, { transport: t2, sessionId: 'sess-a', text })
    rt2.render(ScopeModelsSurface, { transport: t2, sessionId: 'sess-b', text })
    ok(t2.calls.length === 2 && t2.calls[1].expectedSessionId === 'sess-b', '切 owner 后为新会话重新请求')
    t2.pending[1].resolve({ ok: true, models: MODELS, scopedModelIds: [] })
    let late = await flush(rt2, ScopeModelsSurface, { transport: t2, sessionId: 'sess-b', text })
    t2.pending[0].resolve({ ok: true, models: [MODELS[0]], scopedModelIds: ['anthropic/claude-sonnet'] })
    late = await flush(rt2, ScopeModelsSurface, { transport: t2, sessionId: 'sess-b', text })
    let lateView = findByType(late, ScopeModelsView)
    ok(!!lateView && lateView.props.models.length === 3, 'B 的模型仍在')
    ok(lateView.props.scopeIsAll === true, '迟到 A 的响应未覆盖新会话')

    const rt3 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt3
    const t3 = controlledTransport()
    let err = rt3.render(ScopeModelsSurface, { transport: t3, sessionId: 'sess-a', text })
    t3.pending[0].resolve({ ok: false, error: 'boo' })
    err = await flush(rt3, ScopeModelsSurface, { transport: t3, sessionId: 'sess-a', text })
    ok(findByTestId(err, 'native-surface-error'), '加载失败显示错误态')
    findByTestId(err, 'native-surface-error-retry').props.onPress()
    err = await flush(rt3, ScopeModelsSurface, { transport: t3, sessionId: 'sess-a', text })
    ok(t3.calls.filter((c) => c.action === 'scoped-models').length >= 2, '重试重新发请求')

    const rt4 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt4
    const t4 = controlledTransport()
    const noOwner = await flush(rt4, ScopeModelsSurface, { transport: t4, sessionId: '', text })
    ok(t4.calls.length === 0 && !!findByTestId(noOwner, 'native-surface-error'), '没有 owner 明确报错，不发请求')
  }

  group('TrustSurface：真实状态 / 显式保存 / 取消 / 迟到')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const t = controlledTransport()
    const props = { transport: t, sessionId: 'sess-a', text }
    let tree = rt.render(TrustSurface, props)
    t.pending[0].resolve({ ok: true, cwd: 'C:/proj', trusted: false, trustEntry: null })
    tree = await flush(rt, TrustSurface, props)
    let panel = findByType(tree, TrustPanel)
    ok(!!panel && panel.props.view.cwd === 'C:/proj', '加载成功渲染真实 cwd')
    ok(panel.props.view.trusted === false, '显示真实未信任状态')
    ok(panel.props.busy === false, '未信任时唯一操作可用')

    panel.props.onToggle()
    tree = await flush(rt, TrustSurface, props)
    const call = t.calls.find((c) => c.action === 'set-trust')
    assert.deepEqual(call, { action: 'set-trust', expectedSessionId: 'sess-a', trusted: true }, '显式点击才发 set-trust(true)')
    t.pending.find((p) => p.request === call).resolve({ ok: true })
    tree = await flush(rt, TrustSurface, props)
    panel = findByType(tree, TrustPanel)
    ok(panel.props.view.trusted === true && panel.props.notice === text.trust.saved, '保存成功更新状态与提示')

    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    const t2 = controlledTransport()
    const props2 = { transport: t2, sessionId: 'sess-a', text }
    let tree2 = rt2.render(TrustSurface, props2)
    t2.pending[0].resolve({ ok: true, cwd: 'C:/p', trusted: false, trustEntry: null })
    tree2 = await flush(rt2, TrustSurface, props2)
    findByType(tree2, TrustPanel).props.onToggle()
    tree2 = await flush(rt2, TrustSurface, props2)
    const call2 = t2.calls.find((c) => c.action === 'set-trust')
    t2.pending.find((p) => p.request === call2).resolve({ ok: false, cancelled: true })
    tree2 = await flush(rt2, TrustSurface, props2)
    const panel2 = findByType(tree2, TrustPanel)
    ok(panel2.props.error === '' && panel2.props.notice === '' && panel2.props.busy === false, '用户取消不当错误、不谎称保存、释放 busy')
    ok(panel2.props.view.trusted === false, '取消后状态不变')

    const rt3 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt3
    const t3 = controlledTransport()
    rt3.render(TrustSurface, { transport: t3, sessionId: 'sess-a', text })
    t3.pending[0].resolve({ ok: true, cwd: 'C:/a', trusted: false, trustEntry: null })
    let late = await flush(rt3, TrustSurface, { transport: t3, sessionId: 'sess-a', text })
    findByType(late, TrustPanel).props.onToggle()
    late = await flush(rt3, TrustSurface, { transport: t3, sessionId: 'sess-a', text })
    const lateCall = t3.calls.find((c) => c.action === 'set-trust')
    late = rt3.render(TrustSurface, { transport: t3, sessionId: 'sess-b', text })
    t3.pending.find((p) => p.request === lateCall).resolve({ ok: true })
    t3.pending.at(-1).resolve({ ok: true, cwd: 'C:/b', trusted: false, trustEntry: null })
    late = await flush(rt3, TrustSurface, { transport: t3, sessionId: 'sess-b', text })
    const latePanel = findByType(late, TrustPanel)
    ok(!!latePanel && latePanel.props.notice === '' && latePanel.props.view.trusted === false, '切走后的迟到保存不回写提示')
  }

  group('EntriesSurface：只读 / 空 / 错误 / 上限 / 刷新')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const t = controlledTransport()
    const props = { transport: t, sessionId: 'sess-a', text }
    let tree = rt.render(EntriesSurface, props)
    ok(findByTestId(tree, 'native-surface-loading'), '首帧加载态')
    t.pending[0].resolve({ ok: true, entries: [entryFixture('u1'), entryFixture('a1', { parentId: 'u1' })] })
    tree = await flush(rt, EntriesSurface, props)
    let panel = findByType(tree, EntriesPanel)
    ok(!!panel && panel.props.view.rows.length === 2, '条目视图渲染')
    ok(typeof panel.props.onRefresh === 'function' && !('onSave' in panel.props), '条目视图只有刷新，没有写动作')

    panel.props.onRefresh()
    tree = await flush(rt, EntriesSurface, props)
    ok(t.calls.filter((c) => c.action === 'entries').length >= 2, '刷新重新发 entries 请求')
    t.pending.at(-1).resolve({ ok: true, entries: [entryFixture('u2')] })
    tree = await flush(rt, EntriesSurface, props)
    panel = findByType(tree, EntriesPanel)
    ok(panel.props.view.rows.length === 1 && panel.props.view.rows[0].id === 'u2', '刷新后显示新条目')

    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    const t2 = controlledTransport()
    rt2.render(EntriesSurface, { transport: t2, sessionId: 'sess-a', text })
    t2.pending[0].resolve({ ok: true, entries: [] })
    const emptyTree = await flush(rt2, EntriesSurface, { transport: t2, sessionId: 'sess-a', text })
    const emptyPanel = findByType(emptyTree, EntriesPanel)
    ok(!!emptyPanel && emptyPanel.props.view.rows.length === 0, '空条目显示空态')

    const many = Array.from({ length: 8 }, (_, i) => entryFixture(`e${i}`))
    const limitView = buildEntriesView(many, { maxRows: 3 })
    ok(limitView.truncated === true && limitView.shown === 3 && limitView.total === 8, '超过上限时视图标记截断')

    const rt3 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt3
    const t3 = controlledTransport()
    let errTree = rt3.render(EntriesSurface, { transport: t3, sessionId: 'sess-a', text })
    t3.pending[0].resolve({ ok: false, error: 'nope' })
    errTree = await flush(rt3, EntriesSurface, { transport: t3, sessionId: 'sess-a', text })
    ok(findByTestId(errTree, 'native-surface-error'), '读取失败显示错误态')
    findByTestId(errTree, 'native-surface-error-retry').props.onPress()
    errTree = await flush(rt3, EntriesSurface, { transport: t3, sessionId: 'sess-a', text })
    t3.pending[1].resolve({ ok: true, entries: [entryFixture('u1')] })
    errTree = await flush(rt3, EntriesSurface, { transport: t3, sessionId: 'sess-a', text })
    ok(!!findByType(errTree, EntriesPanel), '重试成功后恢复列表')
  }

  group('NativeSessionSurfaces：模式映射 / 未知模式 / owner 关闭')
  {
    const store = {
      nativeSessionPanel: null,
      closeNativeSessionPanel: () => {
        store.closed += 1
      },
      closed: 0,
      session: null,
      peekedSessionId: null,
      peekedPath: null,
      refreshSessions: async () => {}
    }
    globalThis.__STORE_STATE = store
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const transport = controlledTransport()

    store.nativeSessionPanel = null
    ok(rt.render(NativeSessionSurfaces, { transport }) === null, '无请求时宿主返回 null')

    store.nativeSessionPanel = { mode: 'tree', sessionId: 'sess-a' }
    ok(rt.render(NativeSessionSurfaces, { transport }) === null, 'tree 放行给分支页签，宿主不复制')

    store.session = { sessionId: 'sess-a' }
    store.nativeSessionPanel = { mode: 'scoped-models', sessionId: 'sess-a' }
    let tree = rt.render(NativeSessionSurfaces, { transport })
    ok(findByTestId(tree, 'native-surface-scoped-models'), 'scoped-models 映射到模型范围对话框')
    const scopeEl = findByType(tree, ScopeModelsSurface)
    ok(!!scopeEl && scopeEl.props.sessionId === 'sess-a', 'surface 收到打开时的 owner')

    store.nativeSessionPanel = { mode: 'trust', sessionId: 'sess-a' }
    tree = rt.render(NativeSessionSurfaces, { transport })
    ok(findByTestId(tree, 'native-surface-trust') && findByType(tree, TrustSurface), 'trust 映射到信任对话框')

    store.nativeSessionPanel = { mode: 'entries', sessionId: 'sess-a' }
    tree = rt.render(NativeSessionSurfaces, { transport })
    ok(findByTestId(tree, 'native-surface-entries') && findByType(tree, EntriesSurface), 'entries 映射到只读条目对话框')

    store.nativeSessionPanel = { mode: 'bogus-mode', sessionId: 'sess-a' }
    tree = rt.render(NativeSessionSurfaces, { transport })
    ok(findByTestId(tree, 'native-surface-unknown'), '未知面板类型显示明确错误框')
    ok(!!findByTestId(tree, 'native-surface-unknown-detail'), '未知模式有可读说明')

    const storeB = {
      nativeSessionPanel: { mode: 'trust', sessionId: 'sess-a' },
      closeNativeSessionPanel: () => {
        storeB.closed += 1
      },
      closed: 0,
      session: { sessionId: 'sess-a' },
      peekedSessionId: null,
      peekedPath: null,
      refreshSessions: async () => {}
    }
    globalThis.__STORE_STATE = storeB
    const rt2 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt2
    rt2.render(NativeSessionSurfaces, { transport })
    ok(storeB.closed === 0, '同一会话不关闭面板')
    storeB.session = { sessionId: 'sess-b' }
    rt2.render(NativeSessionSurfaces, { transport })
    ok(storeB.closed === 1, '视图切到别的会话时关闭面板')

    const storeC = {
      nativeSessionPanel: { mode: 'scoped-models', sessionId: 'sess-a' },
      closeNativeSessionPanel: () => {
        storeC.closed += 1
      },
      closed: 0,
      session: { sessionId: 'sess-a' },
      peekedSessionId: 'sess-b',
      peekedPath: 'C:/b.jsonl',
      refreshSessions: async () => {}
    }
    globalThis.__STORE_STATE = storeC
    const rt3 = makeHookRuntime()
    globalThis.__V3_HOOKS = rt3
    rt3.render(NativeSessionSurfaces, { transport })
    ok(storeC.closed === 1, 'peek 到别的会话时关闭面板')

    const storeD = {
      nativeSessionPanel: { mode: 'scoped-models', sessionId: 'sess-a' },
      closeNativeSessionPanel: () => {},
      session: { sessionId: 'sess-a' },
      peekedSessionId: null,
      peekedPath: null,
      refreshSessions: async () => {}
    }
    globalThis.__STORE_STATE = storeD
    const rtD = makeHookRuntime()
    globalThis.__V3_HOOKS = rtD
    let dTree = rtD.render(NativeSessionSurfaces, { transport })
    const dScope = findByType(dTree, ScopeModelsSurface)
    ok(typeof dScope.props.onShowEntries === 'function', '模型范围对话框提供只读条目入口')
    dScope.props.onShowEntries()
    dTree = rtD.render(NativeSessionSurfaces, { transport })
    ok(findByTestId(dTree, 'native-surface-entries'), '入口切到只读条目视图（同一 owner）')
  }

  group('静态边界：只用 v3 原语，不自画控件外观')
  {
    const src = await readFile(join(ROOT, 'src/renderer/src/features/session/native/NativeSessionSurfaces.tsx'), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok(code.includes("from '../../../ui'"), '从 v3 ui 入口引入原语')
    for (const name of ['Checkbox', 'CheckboxGroup', 'Dialog', 'Modal', 'ModalOverlay', 'Button', 'Badge', 'Spinner']) {
      ok(code.includes(name), `使用原语 ${name}`)
    }
    ok(!code.includes('styles/chat.css') && !code.includes('components/ui'), '不导入 v2 样式或旧控件')
    ok(!code.includes('ui.answer') && !code.includes('ApprovalBroker'), '不直接调用审批接口')
    ok(!/role="dialog"/.test(code), '对话框 ARIA 交给 ui/Dialog')
    ok(!code.includes('ensureActivated'), '面板不调用 ensureActivated')
    ok(code.includes('sessionId={panel.sessionId}'), 'surface 一律传打开时的 owner')

    const model = await readFile(join(ROOT, 'src/renderer/src/features/session/native/native-surfaces-model.ts'), 'utf8')
    ok(model.includes('expectedSessionId'), '请求构造强制绑定 expectedSessionId')
    ok(!model.includes('ensureActivated') && !model.includes("action: 'navigate'"), '不扩其它原生能力')
    ok(model.includes('NATIVE_ENTRIES_MAX_ROWS'), '条目有体积上限常量')

    const rawCss = await readFile(join(ROOT, 'src/renderer/src/features/session/native/native-surfaces.css'), 'utf8')
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
    ok(!/:hover|:focus-visible|\[data-selected\]|\[data-disabled\]/.test(css), '不自画 hover / 选中 / 焦点 / 禁用外观')
    ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '不写死颜色（只用令牌变量）')
    ok(!/-(btn|chip|tab)\b/.test(css), '不自建控件类')
    ok(!css.includes('@import'), '模块 CSS 不 @import')
  }

  group('真实 v3 原语 SSR：勾选 / 状态 / 只读行落在真实 DOM')
  {
    installSsrGlobals()
    const require = createRequire(import.meta.url)
    const outdirSsr = await mkdtemp(join(tmpdir(), 'yan-v3-native-ssr-'))
    let ssr
    try {
      ssr = require(await buildSsrBundle(outdirSsr))
    } catch (err) {
      process.stderr.write(`\n[SSR bundle 失败] ${err && err.stack ? err.stack : err}\n`)
      report.fail += 1
      await rm(outdirSsr, { recursive: true, force: true })
      await rm(outdir, { recursive: true, force: true })
      process.exitCode = 1
      return
    }
    const { React, renderToStaticMarkup } = ssr

    const scopeView = ssr.ScopeModelsView
    const trustPanel = ssr.TrustPanel
    const entriesPanel = ssr.EntriesPanel

    const models = buildScopedModelsView(MODELS, ['openai/gpt-5'], { provider: 'openai', id: 'gpt-5' }).models
    const scopeHtml = renderToStaticMarkup(
      React.createElement(scopeView, {
        text,
        models,
        scopeIsAll: false,
        selected: new Set(['openai/gpt-5']),
        dirty: false,
        busy: false,
        error: '',
        notice: '',
        onChange() {},
        onSelectAll() {},
        onClear() {},
        onSave() {}
      })
    )
    ok((scopeHtml.match(/type="checkbox"/g) ?? []).length === 3, `模型行是 checkbox（${(scopeHtml.match(/type="checkbox"/g) ?? []).length}）`)
    ok(scopeHtml.includes('aria-label="可用模型"'), '勾选组带可读名称')
    ok(scopeHtml.includes('checked'), '已选 / 未选状态区分')
    ok(scopeHtml.includes('GPT-5') && scopeHtml.includes('Claude Sonnet'), '模型名进入 DOM')

    const trustHtml = renderToStaticMarkup(
      React.createElement(trustPanel, {
        text,
        view: buildTrustView({ cwd: 'C:/proj', trusted: false, trustEntry: null }),
        busy: false,
        error: '',
        notice: '',
        onToggle() {}
      })
    )
    ok(trustHtml.includes('C:/proj'), '信任面板显示真实 cwd')
    ok(trustHtml.includes('未信任'), '信任面板显示真实状态')
    ok(trustHtml.includes('native-trust-risk'), '风险说明进入 DOM')

    const entriesView = buildEntriesView([entryFixture('u1'), entryFixture('a1', { parentId: 'u1' })], { maxRows: 1 })
    const entriesHtml = renderToStaticMarkup(
      React.createElement(entriesPanel, { text, view: entriesView, busy: false, error: '', onRefresh() {} })
    )
    ok((entriesHtml.match(/data-kind="/g) ?? []).length === 1, '只读条目行按上限渲染')
    ok(entriesHtml.includes('native-entries-limit'), '上限说明进入 DOM')
    ok(!entriesHtml.includes('<button') || !/删除|保存/.test(entriesHtml), '条目视图没有写动作按钮')

    await rm(outdirSsr, { recursive: true, force: true })
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
