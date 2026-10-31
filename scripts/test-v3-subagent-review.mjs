#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const __EXTRA = {'Collapsible': 'export function Collapsible(p){ return p.children ?? null }', 'CollapsibleHeader': 'export function CollapsibleHeader(p){ return p.children ?? null }', 'CollapsiblePanel': 'export function CollapsiblePanel(p){ return p.children ?? null }', 'DiffStat': 'export function DiffStat(){ return null }', 'DialogFooter': 'export function DialogFooter(p){ return p.children ?? null }', 'FindBar': 'export function FindBar(){ return null }', 'ListRow': 'export function ListRow(p){ return p.children ?? null }', 'Spinner': 'export function Spinner(){ return null }'}
function __patch(key, src){ if (!/[\\/]ui[\\/]index\.ts$/.test(key)) return src; let out = src; for (const [n, code] of Object.entries(__EXTRA)) { if (!new RegExp('export (function|const|class) '+n+'\\b').test(out) && !new RegExp('export \\{[^}]*\\b'+n+'\\b').test(out)) out += '\n' + code } return out }

const posix = (p) => p.replace(/\\/g, '/')
const abs = (rel) => normalize(resolve(ROOT, rel))

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

const REACT_SHIM = `const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useRef(init) { return rt().useRef(init) }
export function useMemo(fn) { return fn() }
export function useCallback(fn) { return fn }
export function useSyncExternalStore(_sub, getSnapshot) { return getSnapshot() }
export function useDebugValue() {}
export function useId() { return rt().useId() }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export function isValidElement(el) { return !!el && typeof el === 'object' && 'type' in el && 'props' in el }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, useId, createElement, forwardRef, memo, isValidElement }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

function installGlobals() {
  globalThis.window = {
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  }
  globalThis.requestAnimationFrame = (fn) => { try { fn(0) } catch { } return 0 }
  globalThis.cancelAnimationFrame = () => {}
}

function makeHookRuntime() {
  const rt = {
    cells: [], idx: 0, effects: [], dirty: false, seq: 0,
    slot(kind) {
      const i = rt.idx++
      let c = rt.cells[i]
      if (!c || c.kind !== kind) c = rt.cells[i] = { kind, has: false, value: undefined, deps: undefined }
      return c
    },
    useState(init) {
      const c = rt.slot('state')
      if (!c.has) { c.value = typeof init === 'function' ? init() : init; c.has = true }
      const set = (v) => {
        const next = typeof v === 'function' ? v(c.value) : v
        if (!Object.is(next, c.value)) { c.value = next; rt.dirty = true }
      }
      return [c.value, set]
    },
    useRef(init) {
      const c = rt.slot('ref')
      if (!c.has) { c.value = { current: init }; c.has = true }
      return c.value
    },
    useEffect(fn, deps) {
      const c = rt.slot('effect')
      const prev = c.deps
      const changed = !c.has || deps === undefined || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]))
      if (changed) { c.deps = deps ? [...deps] : undefined; c.has = true; rt.effects.push(fn) }
    },
    useId() { return `v3id-${rt.seq++}` },
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
      if (guard >= 100) throw new Error('浅渲染未收敛')
      return tree
    }
  }
  return rt
}

function collect(node, pred, out = []) {
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  if (node.props?.children !== undefined) collect(node.props.children, pred, out)
  return out
}
const byTestId = (tree, id) => collect(tree, (el) => el.props && el.props['data-testid'] === id)
const flattenText = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (node && typeof node === 'object' && node.props) return flattenText(node.props.children)
  return ''
}
const textOf = (el) => (typeof el?.props?.children === 'string' ? el.props.children : '')

const DEFINE = {
  'import.meta.env.DEV': 'false',
  'import.meta.env.PROD': 'true',
  'process.env.NODE_ENV': '"production"',
  requestAnimationFrame: 'globalThis.requestAnimationFrame',
  cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
}

const UI_STUB = `const h = (type, props) => ({ type, props: props || {} })
export function Button(props) { return h('button', { 'data-testid': props['data-testid'], 'data-disabled': props.isDisabled ? '1' : undefined, 'data-pending': props.isPending ? '1' : undefined, onClick: props.onPress, children: props.children }) }
export function IconButton() { return null }
export function Notice(props) { return h('div', { 'data-testid': props['data-testid'], role: props.tone === 'fail' ? 'alert' : 'status', children: props.children }) }
export function Dialog(props) { return h('div', { 'data-testid': props['data-testid'], children: [props.title, props.children] }) }
export function Modal(props) { return h('div', { children: props.children }) }
export function ModalOverlay(props) { return h('div', { 'data-open': props.isOpen ? '1' : '0', children: props.children }) }
`

const I18N_STUB = `export function useT() { return (k, vars) => vars ? k + JSON.stringify(vars) : String(k) }
export function useI18n() { return { lang: 'zh-CN', t: (k) => String(k) } }
export function translate(_l, k) { return String(k) }
`

const DIFF_STUB = `const h = (type, props) => ({ type, props: props || {} })
export function DiffView(props) { return h('div', { 'data-testid': 'diff-stub', 'data-bytes': String((props.patch || '').length), children: props.patch }) }
`

function makeStubPlugin(rawMap) {
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
  return {
    name: 'v3-subagent-review-stubs',
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
        return { contents: __patch(key, stubMap.get(key) ?? 'export {}'), loader: 'js' }
      })
    }
  }
}

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entry = join(outdir, 'entry.ts')
  await writeFile(entry, [
    `export { SubagentReview } from '${posix(abs('src/renderer/src/features/session/SubagentReview.tsx'))}'`,
    `export { subagentReviewGate, loadSubagentPatch, mergeSubagentResult, discardSubagentResult } from '${posix(abs('src/renderer/src/features/session/subagent-review.ts'))}'`
  ].join('\n'))
  const out = join(outdir, 'bundle.mjs')
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
    define: DEFINE,
    alias: { react: reactShim, 'react/jsx-runtime': jsxShim, 'react/jsx-dev-runtime': jsxShim },
    plugins: [makeStubPlugin({
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/features/diff/index.ts': DIFF_STUB
    })]
  })
  return out
}

const PATCH = '/data/subagents/sub-42.patch'

const run = (over = {}) => ({
  id: 'sub-42',
  task: '补齐 PKCE 单元测试',
  cwd: '/p',
  isolation: 'worktree',
  status: 'done',
  startedAt: 1_000,
  endedAt: 2_000,
  transcript: [],
  review: 'pending',
  diff: { files: 3, additions: 10, deletions: 2, paths: ['src/a.ts'], truncated: false, patchPath: PATCH },
  ...over
})

let lib
let rt
const tick = () => new Promise((r) => setTimeout(r, 0))

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-subagent-review-'))
  let bundle
  try {
    bundle = await import(pathToFileURL(await buildBundle(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }
  lib = bundle
  rt = makeHookRuntime()
  globalThis.__V3_HOOKS = rt

  group('处置闸门：只认隔离 worktree 的终态待审阅结果')
  {
    const g = lib.subagentReviewGate(run())
    ok(g.canReview && g.canPatch && g.canDiscard && g.blocked === null, 'worktree + pending + 补丁：可查看 / 采纳 / 放弃', g)

    const conflict = lib.subagentReviewGate(run({ review: 'conflict' }))
    ok(conflict.canReview && conflict.canPatch, 'conflict 同样可处置（后端保留工作树）', conflict)

    for (const iso of ['controlled-cwd', 'shared-cwd']) {
      const c = lib.subagentReviewGate(run({ isolation: iso }))
      ok(!c.canReview && !c.canPatch && !c.canDiscard && c.blocked === 'not-worktree', `${iso}：不画假采纳`, c)
    }

    for (const status of ['starting', 'running']) {
      const r = lib.subagentReviewGate(run({ status }))
      ok(!r.canReview && r.blocked === 'running', `运行中（${status}）：不可处置`, r)
    }

    const archived = lib.subagentReviewGate(run({ review: 'archived' }))
    ok(!archived.canReview && archived.blocked === 'no-worktree', '已归档（工作树已清理）：不给假入口', archived)

    for (const review of ['merged', 'discarded', 'none']) {
      const r = lib.subagentReviewGate(run({ review }))
      ok(!r.canReview && r.blocked === 'nothing-to-review', `${review}：没有待审阅改动`, r)
    }

    const noDiff = lib.subagentReviewGate(run({ diff: undefined }))
    ok(!noDiff.canPatch && noDiff.canDiscard && noDiff.blocked === 'no-patch', '无补丁：可放弃、不可采纳', noDiff)

    const empty = lib.subagentReviewGate(run({ diff: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false, patchPath: PATCH } }))
    ok(!empty.canPatch && empty.canDiscard && empty.blocked === 'no-patch', '零文件：可放弃、不可采纳', empty)
  }

  group('归档补丁读取：先登记再读，失败抛出明确原因')
  {
    const calls = []
    const io = {
      describeFiles: async (paths) => { calls.push(['describeFiles', paths]); return [{ ok: true, path: '/real/sub-42.patch' }] },
      readFileText: async (p) => { calls.push(['readFileText', p]); return { ok: true, text: 'diff --git a/x b/x\n', truncated: false } }
    }
    const patch = await lib.loadSubagentPatch(PATCH, io)
    ok(patch.patch.includes('diff --git'), '读到真实补丁文本', patch)
    ok(patch.truncated === false, '未截断标记正确', patch.truncated)
    ok(calls[0][0] === 'describeFiles' && calls[0][1][0] === PATCH, '先登记这条补丁路径', calls[0])
    ok(calls[1][0] === 'readFileText' && calls[1][1] === '/real/sub-42.patch', '读取登记后的真实路径', calls[1])

    const truncated = await lib.loadSubagentPatch(PATCH, {
      describeFiles: async () => [{ ok: true, path: PATCH }],
      readFileText: async () => ({ ok: true, text: 'partial', truncated: true })
    })
    ok(truncated.truncated === true && truncated.patch === 'partial', '超过 2MB 上限时带截断标记', truncated)

    await assert.rejects(
      lib.loadSubagentPatch(PATCH, { describeFiles: async () => [{ ok: false, error: '文件过大' }], readFileText: async () => ({ ok: true, text: '' }) }),
      /文件过大/,
      '登记失败抛出宿主原因'
    )
    await assert.rejects(
      lib.loadSubagentPatch(PATCH, { describeFiles: async () => [{ ok: true, path: PATCH }], readFileText: async () => ({ ok: false, error: '读取失败' }) }),
      /读取失败/,
      '读取失败抛出宿主原因'
    )
    ok(pass > 0, '（登记 / 读取失败都有明确原因，不静默当空补丁）')
  }

  const render = (props) => rt.render(lib.SubagentReview, props)
  const resetHooks = () => { rt = makeHookRuntime(); globalThis.__V3_HOOKS = rt }
  const callbacks = () => ({ onMerge: async () => {}, onDiscard: async () => {} })

  group('SubagentReview：不可处置时不出现任何按钮')
  {
    resetHooks()
    ok(render({ run: run({ isolation: 'controlled-cwd' }), ...callbacks() }) === null, 'controlled-cwd：不渲染审阅控件')
    ok(render({ run: run({ isolation: 'shared-cwd' }), ...callbacks() }) === null, 'shared-cwd：不渲染审阅控件')
    ok(render({ run: run({ status: 'running' }), ...callbacks() }) === null, '运行中：不渲染审阅控件')
    ok(render({ run: run({ review: 'archived' }), ...callbacks() }) === null, '已归档：不渲染审阅控件')
    ok(render({ run: run({ review: 'merged' }), ...callbacks() }) === null, '已采纳：不渲染审阅控件')
  }

  group('SubagentReview：pending/conflict 只展示结果与查看差异，不给用户采纳或放弃')
  {
    resetHooks()
    const tree = render({ run: run(), ...callbacks() })
    ok(byTestId(tree, 'v3-subagent-review').length === 1, '渲染审阅区', tree)
    ok(byTestId(tree, 'v3-subagent-review-view').length === 1, '有查看差异', tree)
    ok(byTestId(tree, 'v3-subagent-review-merge').length === 0 && byTestId(tree, 'v3-subagent-review-discard').length === 0, '没有采纳 / 放弃按钮，处置交给主会话', tree)
    ok(textOf(byTestId(tree, 'v3-subagent-review-state')[0]) === 'sa.reviewPending', 'pending 显示待审阅', textOf(byTestId(tree, 'v3-subagent-review-state')[0]))

    const conflictTree = render({ run: run({ review: 'conflict' }), ...callbacks() })
    ok(textOf(byTestId(conflictTree, 'v3-subagent-review-state')[0]) === 'sa.reviewConflict', 'conflict 显示冲突说明', textOf(byTestId(conflictTree, 'v3-subagent-review-state')[0]))

    const noPatch = render({ run: run({ diff: undefined }), ...callbacks() })
    ok(byTestId(noPatch, 'v3-subagent-review-view').length === 0, '无补丁不画查看', noPatch)
  }

  group('SubagentReview：查看差异走 run 自己的归档补丁')
  {
    resetHooks()
    const loads = []
    const props = {
      run: run(),
      onMerge: async () => {},
      onDiscard: async () => {},
      loadPatch: async (p) => { loads.push(p); return { patch: 'diff --git a/x b/x\n', truncated: false } }
    }
    const diffs = (tree) => collect(tree, (el) => typeof el.type === 'function' && el.type.name === 'DiffView')
    let tree = render(props)
    byTestId(tree, 'v3-subagent-review-view')[0].props.onPress()
    tree = render(props)
    ok(loads.length === 1 && loads[0] === PATCH, '按这条运行的 patchPath 读取，不取前台会话', loads)
    ok(byTestId(tree, 'v3-subagent-review-diff').length === 1, '打开 diff 容器', tree)
    await tick()
    tree = render(props)
    const diffEls = diffs(tree)
    ok(diffEls.length === 1 && diffEls[0].props.patch.includes('diff --git'), '补丁交给 v3 DiffView 渲染', diffEls.length)
  }

  group('SubagentReview：补丁读取失败就地提示，不装空 DiffView')
  {
    resetHooks()
    const diffs = (tree) => collect(tree, (el) => typeof el.type === 'function' && el.type.name === 'DiffView')
    const props = { run: run(), onMerge: async () => {}, onDiscard: async () => {}, loadPatch: async () => { throw new Error('登记被拒') } }
    let tree = render(props)
    byTestId(tree, 'v3-subagent-review-view')[0].props.onPress()
    tree = render(props)
    await tick()
    tree = render(props)
    ok(byTestId(tree, 'v3-subagent-review-diff-error').length === 1, '显示读取失败', tree)
    ok(diffs(tree).length === 0, '不装空 DiffView', tree)
    ok(collect(tree, (el) => flattenText(el).includes('登记被拒')).length >= 1, '带出宿主原因', tree)
  }

  group('SubagentReview：没有确认框与处置回调')
  {
    resetHooks()
    const tree = render({ run: run(), ...callbacks() })
    ok(byTestId(tree, 'v3-subagent-review-dialog').length === 0 && byTestId(tree, 'v3-subagent-review-confirm').length === 0, '不再弹确认框', tree)
  }

  group('窄结果适配器：{ ok:false } 转成明确失败，成功 / 传输拒绝不改变语义')
  {
    const mergeCalls = []
    await lib.mergeSubagentResult('sub-42', {
      merge: async (id) => { mergeCalls.push(id); return { ok: true } },
      discard: async () => ({ ok: true })
    })
    ok(mergeCalls.length === 1 && mergeCalls[0] === 'sub-42', '{ ok:true } 成功 resolve，只动这条 run', mergeCalls)

    await assert.rejects(
      lib.mergeSubagentResult('sub-42', { merge: async () => ({ ok: false, error: '合并冲突或补丁已失效' }), discard: async () => ({ ok: true }) }),
      /合并冲突或补丁已失效/,
      'Promise.resolve({ ok:false, error }) 抛出后端原因'
    )
    await assert.rejects(
      lib.mergeSubagentResult('sub-42', { merge: async () => ({ ok: false }), discard: async () => ({ ok: true }) }),
      /state.error.subagentMergeFailed/,
      '无 error 字段时给出缺省失败文案'
    )
    await assert.rejects(
      lib.mergeSubagentResult('sub-42', { merge: async () => { throw new Error('IPC 断开') }, discard: async () => ({ ok: true }) }),
      /IPC 断开/,
      '传输层 reject 原样向上抛'
    )

    await lib.discardSubagentResult('sub-42', { merge: async () => ({ ok: true }), discard: async () => ({ ok: true }) })
    await assert.rejects(
      lib.discardSubagentResult('sub-42', { merge: async () => ({ ok: true }), discard: async () => ({ ok: false, error: '工作树已清理' }) }),
      /工作树已清理/,
      '放弃同样把 { ok:false } 转成明确失败'
    )
  }

  process.stdout.write(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  if (fail) process.exit(1)
}

main().catch(async (error) => {
  process.stderr.write(`\n[测试异常] ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
