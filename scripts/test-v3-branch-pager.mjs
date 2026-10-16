#!/usr/bin/env node
/**
 * 用户消息旁「2/3 ‹ ›」原生兄弟分支切换的小检查（v3 · 设计 §8.8 / BR3）。
 *
 * 目标：把**真实生产模块**现场 esbuild 出来跑，不用源码字符串当唯一证据：
 *   · `features/session/branch-pager-model.ts` —— 分叉点投影、目标叶子选择、请求封装；
 *   · `features/session/BranchPager.tsx` —— 呈现 / 禁用 / 键盘 / 错误；
 *   · `features/session/TurnView.tsx` —— 只在用户消息带稳定 `entryId` 且查到模型时才画；
 *   · `features/session/SessionView.tsx` —— 低频读树、忙 / owner 切换守卫、点击再核、
 *     pending 防连点、成功后刷新宿主同步。
 *
 * 另有一组用真实 `ui/IconButton` + `react-dom/server` 核对可访问名称落在 DOM。
 *
 * 用法：node scripts/test-v3-branch-pager.mjs
 * 不启动 Electron / 浏览器，不读用户数据，不连 pi，不调用真实模型，不发真实 IPC。
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
const abs = (rel) => normalize(resolve(ROOT, rel))

/* ------------------------------------------------------------------ 断言 */

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

/* ------------------------------------------------------- React 浅渲染替身 */

/**
 * 浅渲染 hook 运行时。与同目录其它 v3 检查不同的一点：**支持 effect 清理**，
 * 这样 `window.setTimeout` 的去抖取消才能在测试里真正生效（否则旧 timer 会累积，
 * 「低频」就测不准）。
 */
function makeHookRuntime() {
  const rt = {
    cells: [],
    idx: 0,
    effects: [],
    pendingCleanups: [],
    dirty: false,
    seq: 0,
    slot(kind) {
      const i = rt.idx++
      let c = rt.cells[i]
      if (!c || c.kind !== kind) c = rt.cells[i] = { kind, has: false, value: undefined, deps: undefined, fn: undefined, cleanup: undefined }
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
        if (typeof c.cleanup === 'function') rt.pendingCleanups.push(c.cleanup)
        c.deps = deps ? [...deps] : undefined
        c.fn = fn
        c.has = true
        rt.effects.push(c)
      }
    },
    useId() {
      return `v3id-${rt.seq++}`
    },
    unmount() {
      for (const c of rt.cells) {
        if (c && c.kind === 'effect' && typeof c.cleanup === 'function') c.cleanup()
        if (c) c.cleanup = undefined
      }
    },
    render(Component, props) {
      let tree
      let guard = 0
      do {
        rt.dirty = false
        rt.idx = 0
        rt.effects = []
        rt.pendingCleanups = []
        tree = Component(props || {})
        for (const cleanup of rt.pendingCleanups) cleanup()
        for (const c of rt.effects) {
          const out = c.fn()
          c.cleanup = typeof out === 'function' ? out : undefined
        }
      } while (rt.dirty && ++guard < 100)
      if (guard >= 100) throw new Error('浅渲染未收敛（疑似 effect 里无限 setState）')
      return tree
    }
  }
  return rt
}

const REACT_SHIM = `const rt = () => globalThis.__V3_HOOKS
export const Fragment = Symbol.for('v3.fragment')
export function useState(init) { return rt().useState(init) }
export function useEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useLayoutEffect(fn, deps) { return rt().useEffect(fn, deps) }
export function useInsertionEffect() {}
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
export function Badge() { return null }`

const I18N_STUB = `export function useI18n() { return { lang: 'zh-CN', setLang() {}, toggleLang() {}, t: (k) => String(k) } }
export function useT() { return (k) => String(k) }
export function translate(_l, k) { return String(k) }`

const ICON_STUB = `export function Icon() { return null }`

async function bundle(outdir, name, entrySource, stubMap, shims) {
  const entry = join(outdir, `${name}-entry.ts`)
  await writeFile(entry, entrySource)
  const out = join(outdir, `${name}-bundle.mjs`)
  const map = new Map(Object.entries(stubMap).map(([rel, src]) => [abs(rel), src]))
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
    plugins: [
      {
        name: `v3-pager-stubs-${name}`,
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'react') return { path: shims.react }
            if (args.path === 'react/jsx-runtime') return { path: shims.jsx }
            if (args.path === 'react/jsx-dev-runtime') return { path: shims.jsx }
            if (args.path === 'virtua') return { path: 'v3stub:virtua', namespace: 'v3stub' }
            if (!args.importer || !args.resolveDir) return undefined
            const base = resolve(args.resolveDir, args.path)
            for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
              const key = normalize(base + e)
              if (map.has(key)) return { path: `v3stub:${key}`, namespace: 'v3stub' }
            }
            return undefined
          })
          b.onLoad({ filter: /.*/, namespace: 'v3stub' }, (args) => {
            if (args.path === 'v3stub:virtua') return { contents: 'export function VList(){ return null }\nexport const Virtualizer = VList', loader: 'js' }
            const key = args.path.slice('v3stub:'.length)
            return { contents: map.get(key) ?? 'export {}', loader: 'js' }
          })
        }
      }
    ]
  })
  return out
}

async function makeShims(outdir) {
  const react = join(outdir, 'react-shim.mjs')
  const jsx = join(outdir, 'jsx-shim.mjs')
  await writeFile(react, REACT_SHIM)
  await writeFile(jsx, JSX_SHIM)
  return { react, jsx }
}

async function flush(rt, Component, props, rounds = 8) {
  let tree = null
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await Promise.resolve()
    tree = rt.render(Component, props)
  }
  return tree
}

/* ----------------------------------------------------------- 元素树工具 */

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
function findAll(node, predicate) {
  const hits = []
  walk(node, (el) => {
    if (el && predicate(el)) hits.push(el)
  })
  return hits
}
function findByTestId(node, id) {
  return findAll(node, (el) => el.props?.['data-testid'] === id)[0] ?? null
}
function findByStub(node, stub) {
  return findAll(node, (el) => el.type && el.type.__stub === stub)
}
function classIncludes(el, name) {
  return typeof el?.props?.className === 'string' && el.props.className.split(/\s+/).includes(name)
}

/* ----------------------------------------------------------- 会话树 fixture */

const user = (id, parentId, kids = []) => ({ entry: { id, parentId, type: 'message', message: { role: 'user', content: id } }, children: kids })
const assistant = (id, parentId, kids = []) => ({ entry: { id, parentId, type: 'message', message: { role: 'assistant', content: id } }, children: kids })
const metaNode = (id, parentId, type = 'label', kids = []) => ({ entry: { id, parentId, type, ...(type === 'label' ? { label: id } : {}) }, children: kids })

/** u1 → a1 → [u2 → a2, u3 → a3]：在 a1 处分叉，两个用户分支。 */
function forkTree() {
  return [user('u1', null, [assistant('a1', 'u1', [user('u2', 'a1', [assistant('a2', 'u2')]), user('u3', 'a1', [assistant('a3', 'u3')])])])]
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-branch-pager-'))
  const shims = await makeShims(outdir)

  let model
  let pagerMod
  let sessionMod
  try {
    const modelOut = await bundle(
      outdir,
      'model',
      `export * from '${posix(abs('src/renderer/src/features/session/branch-pager-model.ts'))}'\n`,
      {},
      shims
    )
    model = await import(pathToFileURL(modelOut).href)

    const pagerOut = await bundle(
      outdir,
      'pager',
      `export { BranchPager, branchPagerText } from '${posix(abs('src/renderer/src/features/session/BranchPager.tsx'))}'\n`,
      {
        'src/renderer/src/ui/index.ts': UI_STUB,
        'src/renderer/src/i18n/index.tsx': I18N_STUB,
        'src/renderer/src/features/session/Icon.tsx': ICON_STUB
      },
      shims
    )
    pagerMod = await import(pathToFileURL(pagerOut).href)

    const sessionOut = await bundle(
      outdir,
      'session',
      `export { SessionView } from '${posix(abs('src/renderer/src/features/session/SessionView.tsx'))}'\n`,
      {
        'src/renderer/src/features/session/TurnView.tsx': `export function TurnView(){ return null }\nTurnView.__stub='turnview'`,
        'src/renderer/src/features/session/ApprovalCard.tsx': 'export function ApprovalCard(){ return null }',
        'src/renderer/src/features/session/QuestionCard.tsx': 'export function QuestionCard(){ return null }',
        'src/renderer/src/features/session/OutlineRail.tsx': 'export function OutlineRail(){ return null }\nexport function userTurnRenderIndex(){ return 0 }',
        'src/renderer/src/features/session/StalledCard.tsx': 'export function StalledCard(){ return null }\nexport function currentStalledRun(){ return null }',
        'src/renderer/src/features/session/Icon.tsx': ICON_STUB,
        'src/renderer/src/features/session/V3EmptyState.tsx': 'export function V3EmptyState(){ return null }',
        'src/renderer/src/features/session/RewindDialogV3.tsx': 'export function RewindDialogV3(){ return null }',
        'src/renderer/src/features/ambient/AsciiField.tsx': 'export function AsciiField(){ return null }',
        'src/renderer/src/features/ambient/ascii-field-model.ts': 'export function asciiBackgroundEnabled(){ return false }',
        'src/renderer/src/i18n/index.tsx': I18N_STUB,
        'src/renderer/src/state/runs-v3.ts': 'export function useRunsV3(selector){ return selector({ runs: [] }) }',
        'src/renderer/src/state/store.ts': `export function useStore(selector){ return selector(globalThis.__STORE) }\nuseStore.getState = () => globalThis.__STORE\nexport function streamingMessageId(){ return undefined }`,
        'src/renderer/src/ui/index.ts': UI_STUB
      },
      shims
    )
    sessionMod = await import(pathToFileURL(sessionOut).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  /* ============================================== 组 1：纯投影：2/3 与目标叶子 */
  group('branch-pager-model：同分叉点计数 / 目标叶子 / 无 id / 保护')
  {
    const tree = forkTree()
    const map = model.buildBranchPagerMap(tree, 'a3')
    ok(map.size === 2, '两个用户分支都有模型', [...map.keys()])
    const u2 = map.get('u2')
    const u3 = map.get('u3')
    ok(u2 && u2.index === 1 && u2.count === 2, 'u2 在 1/2 位', u2)
    ok(u3 && u3.index === 2 && u3.count === 2, 'u3 在 2/2 位', u3)
    ok(u2.prevTargetId === 'a3' && u2.nextTargetId === 'a3', '只有两个兄弟时前后都指向对方叶子', u2)
    ok(u3.prevTargetId === 'a2' && u3.nextTargetId === 'a2', 'u3 的两个方向都指向 a2', u3)
    ok(u2.forkId === 'a1' && u3.forkId === 'a1', '共同分叉点 = 父条目 a1')
    ok(u3.onActivePath === true && u2.onActivePath === false, '活动 leaf 路径只标记当前分支')

    ok(model.branchPagerFor(tree, undefined) === null, '无稳定 entryId 不产生模型')
    ok(model.branchPagerFor(tree, 'm0') === null, '合成序号 / 未知 id 查不到模型')
    ok(model.branchPagerFor(tree, 'u1') === null, '根条目（没有父分叉点）不画 pager')

    const single = [user('s1', null, [assistant('s2', 's1', [user('s3', 's2')])])]
    ok(model.buildBranchPagerMap(single, 's3').size === 0, '单分支即使有 entryId 也不画 pager')
    ok(model.treeHasEntryId(tree, 'a3') === true && model.treeHasEntryId(tree, 'ghost') === false, 'treeHasEntryId 只认真实条目')

    /* 书签 / 元信息子节点不冒充兄弟分支 */
    const withMeta = [user('m1', null, [assistant('m2', 'm1', [metaNode('lab', 'm2'), user('m3', 'm2', [assistant('m4', 'm3')])])])]
    ok(model.buildBranchPagerMap(withMeta, 'm4').size === 0, '只有书签 + 一个用户分支：不算分叉')
    const withMetaFork = [user('m1', null, [assistant('m2', 'm1', [
      metaNode('lab', 'm2'),
      user('m3', 'm2', [assistant('m4', 'm3')]),
      user('m5', 'm2', [assistant('m6', 'm5')])
    ])])]
    const metaMap = model.buildBranchPagerMap(withMetaFork, 'm6')
    ok(metaMap.get('m3')?.index === 1 && metaMap.get('m3')?.count === 2, '书签被过滤后仍正确计 1/2', metaMap.get('m3'))
    ok(metaMap.get('m5')?.index === 2 && metaMap.get('m5')?.count === 2, '书签不把 m5 挤成 3/3')

    /* 嵌套分叉：目标取该兄弟分支最新创建的末端（每个岔口取末位分支子节点） */
    const nested = [user('n1', null, [assistant('n2', 'n1', [
      user('n3', 'n2', [assistant('n4', 'n3')]),
      user('n5', 'n2', [assistant('n6', 'n5', [user('n7', 'n6', [assistant('n8', 'n7')]), user('n9', 'n6', [assistant('n10', 'n9')])])])
    ])])]
    const nestedMap = model.buildBranchPagerMap(nested, 'n10')
    ok(nestedMap.get('n3')?.nextTargetId === 'n10', '指向兄弟子树里最新创建的真实叶子 n10', nestedMap.get('n3')?.nextTargetId)
    ok(nestedMap.get('n7')?.index === 1 && nestedMap.get('n9')?.index === 2, '嵌套分叉各自成组')
    ok(nestedMap.get('n5')?.index === 2 && nestedMap.get('n5')?.count === 2, '外层兄弟计数不受内层分叉影响')

    /* 重复 id / 环：不抛、不死循环 */
    const cyclic = [user('c1', null, [assistant('c2', 'c1', [user('c3', 'c2'), user('c3', 'c2')])])]
    let cyclicMap
    try {
      cyclicMap = model.buildBranchPagerMap(cyclic, 'c3')
      ok(cyclicMap.size >= 0, '重复 id 被安全去重')
    } catch (error) {
      ok(false, '重复 id 不应抛错', error?.message)
    }

    /* 深树：超过共享上限也不挂、不抛 */
    let deepRoot = user('d0', null, [assistant('d1', 'd0')])
    let cursor = deepRoot.children[0]
    for (let i = 2; i < 260; i += 1) {
      const node = i % 2 === 0 ? user(`d${i}`, `d${i - 1}`) : assistant(`d${i}`, `d${i - 1}`)
      cursor.children.push(node)
      cursor = node
    }
    let deepMap
    try {
      deepMap = model.buildBranchPagerMap([deepRoot], 'd259')
      ok(deepMap.size === 0, '线性深树没有分叉、返回空模型')
    } catch (error) {
      ok(false, '深树不应抛错', error?.message)
    }
    ok(typeof model.treeHasEntryId([deepRoot], 'd259') === 'boolean', '深树上目标校验有界返回')
  }

  /* ============================================== 组 2：请求绑定与固定不摘要 */
  group('请求封装：只发 tree / navigate，绑定 expectedSessionId，不带 summarize')
  {
    const calls = []
    const transport = async (request) => {
      calls.push(request)
      return { ok: true, tree: forkTree(), leafId: 'a3' }
    }
    const loaded = await model.loadPagerTree(transport, 'sess-a', '读取失败')
    assert.deepEqual(calls[0], { action: 'tree', expectedSessionId: 'sess-a' }, 'tree 请求只带 action + expectedSessionId')
    ok(loaded.ok && loaded.tree.length === 1 && loaded.leafId === 'a3', '成功解析树与 leaf')

    const navCalls = []
    const navTransport = async (request) => {
      navCalls.push(request)
      return { ok: true }
    }
    const navigated = await model.navigatePagerBranch(navTransport, 'sess-a', 'a3', '切换失败')
    assert.deepEqual(navCalls[0], { action: 'navigate', expectedSessionId: 'sess-a', entryId: 'a3' }, 'navigate 只带 action / expectedSessionId / entryId')
    ok(!('summarize' in navCalls[0]) && !('args' in navCalls[0]), '固定不带 summarize 或其它参数')
    ok(navigated.ok === true, 'navigate 成功')

    const failed = await model.navigatePagerBranch(async () => ({ ok: false, error: '会话已切换' }), 'sess-a', 'a3', '切换失败')
    ok(failed.ok === false && failed.error === '会话已切换', '宿主错误原样带回')
    const fallback = await model.navigatePagerBranch(async () => ({ ok: false }), 'sess-a', 'a3', '切换失败')
    ok(fallback.ok === false && fallback.error === '切换失败', '宿主错误为空时用兜底文案')
    const thrown = await model.loadPagerTree(async () => { throw new Error('boom') }, 'sess-a', '读取失败')
    ok(thrown.ok === false && thrown.error === 'boom', '抛错也收成明确失败')
  }

  /* ============================================== 组 3：pager 组件呈现 */
  group('BranchPager：序号 / 前后切换 / 禁用 / 错误 / 行内方向键')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const target = { entryId: 'u2', forkId: 'a1', index: 2, count: 3, prevTargetId: 'p1', nextTargetId: 'n1', onActivePath: true }
    const seen = []
    const props = { model: target, onNavigate: (id) => seen.push(id) }
    let tree = rt.render(pagerMod.BranchPager, props)

    const root = tree
    ok(root && root.props['data-testid'] === 'v3-branch-pager', '渲染出分组容器')
    ok(root.props.role === 'group', '容器 role=group')
    ok(root.props['data-index'] === 2 && root.props['data-count'] === 3, '序号 / 总数作为数据属性')
    const count = findAll(tree, (el) => classIncludes(el, 'branch-pager__count'))[0]
    ok(count && childrenArray(count.props.children).join('') === '2/3', '显示 2/3', count?.props?.children)
    ok(String(root.props['aria-label']).length > 0, '分组有可读名称')

    const prev = findByTestId(tree, 'v3-branch-prev')
    const next = findByTestId(tree, 'v3-branch-next')
    ok(prev && prev.props['aria-label'] === '上一个分支', '上一个按钮有可读名称')
    ok(next && next.props['aria-label'] === '下一个分支', '下一个按钮有可读名称')
    prev.props.onPress()
    next.props.onPress()
    assert.deepEqual(seen, ['p1', 'n1'], '两个按钮分别导航到前 / 后目标叶子')

    root.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
    root.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
    assert.deepEqual(seen, ['p1', 'n1', 'p1', 'n1'], '行内左右方向键复用同一导航')
    root.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} })
    assert.deepEqual(seen.length, 4, '不吞其它方向键')

    let pend = rt.render(pagerMod.BranchPager, { ...props, pending: true })
    ok(findByTestId(pend, 'v3-branch-prev').props.isDisabled === true, '切换在途禁用按钮')
    ok(findAll(pend, (el) => el.props?.role === 'status').length === 1, '切换在途有可见状态')
    pend.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
    ok(seen.length === 4, '在途时不响应方向键')

    let disabled = rt.render(pagerMod.BranchPager, { ...props, disabled: true })
    ok(findByTestId(disabled, 'v3-branch-next').props.isDisabled === true, '会话忙时禁用切换')

    let errored = rt.render(pagerMod.BranchPager, { ...props, error: '切换失败：会话已切换' })
    const err = findByTestId(errored, 'v3-branch-pager-error')
    ok(err && err.props.role === 'alert' && String(err.props.children).includes('会话已切换'), '失败原因可见', err?.props?.children)
  }

  /* ============================================== 组 4：TurnView 的 entryId 门闩 */
  group('TurnView：只有用户消息带稳定 entryId 且命中模型才画 pager（真实 SSR）')
  {
    const outdirTurn = await mkdtemp(join(tmpdir(), 'yan-v3-branch-pager-turn-'))
    try {
      const entry = [
        "import * as React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        `import { TurnView } from '${posix(abs('src/renderer/src/features/session/TurnView.tsx'))}'`,
        'export { React, renderToStaticMarkup, TurnView }'
      ].join('\n')
      const turnStubs = {
        'src/renderer/src/features/session/Markdown.tsx': 'export function Markdown(){ return null }\nexport function PlainText(){ return null }',
        'src/renderer/src/features/session/MessageParts.tsx': 'export function TurnArtifacts(){ return null }',
        'src/renderer/src/features/session/Thinking.tsx': 'export function ThinkingLine(){ return null }',
        'src/renderer/src/features/session/ToolSteps.tsx': 'export function ToolSteps(){ return null }',
        'src/renderer/src/features/session/Image.tsx': 'export function MessageImage(){ return null }',
        'src/renderer/src/features/session/text.ts': 'export function useSessionText(){ return (k)=>String(k) }\nexport function sessionText(_l,k){ return String(k) }',
        'src/renderer/src/features/session/ErrorCard.tsx': 'export function ErrorCard(){ return null }',
        'src/renderer/src/features/session/CompactionMarker.tsx': 'export function CompactionMarker(){ return null }',
        'src/renderer/src/features/session/BranchSummary.tsx': 'export function BranchSummary(){ return null }',
        'src/renderer/src/features/session/SubagentLine.tsx': 'export function SubagentLine(){ return null }',
        'src/renderer/src/features/session/Icon.tsx': ICON_STUB,
        'src/renderer/src/i18n/index.tsx': I18N_STUB,
        'src/renderer/src/ui/index.ts': UI_STUB,
        'src/renderer/src/components/chat/run-status.ts': 'export function useRunProgress(){ return null }\nexport function runPhaseText(){ return "" }',
        'src/renderer/src/components/chat/turn-model-display.ts': 'export function resolveTurnModelDisplay(){ return null }',
        'src/renderer/src/lib/fork.ts': 'export async function forkFromText(){ globalThis.__V3_FORK_CALLED = (globalThis.__V3_FORK_CALLED ?? 0) + 1 }',
        'src/renderer/src/state/store.ts': `export function useStore(selector){ return selector(globalThis.__TURN_STORE ?? {}) }\nuseStore.getState = () => globalThis.__TURN_STORE ?? {}`
      }
      const outfile = join(outdirTurn, 'turn-ssr.cjs')
      await build({
        stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
        outfile,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        jsx: 'automatic',
        logLevel: 'silent',
        loader: { '.css': 'empty' },
        plugins: [
          {
            name: 'v3-pager-turn-ssr',
            setup(b) {
              const map = new Map(Object.entries(turnStubs).map(([rel, src]) => [abs(rel), src]))
              b.onResolve({ filter: /.*/ }, (args) => {
                if (!args.importer || !args.resolveDir) return undefined
                const base = resolve(args.resolveDir, args.path)
                for (const e of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
                  const key = normalize(base + e)
                  if (map.has(key)) return { path: `v3turn:${key}`, namespace: 'v3turn' }
                }
                return undefined
              })
              b.onLoad({ filter: /.*/, namespace: 'v3turn' }, (args) => {
                const key = args.path.slice('v3turn:'.length)
                return { contents: map.get(key) ?? 'export {}', loader: 'js' }
              })
            }
          }
        ]
      })

      function ElementShim() {}
      ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
      globalThis.HTMLElement = ElementShim
      globalThis.Element = ElementShim
      globalThis.Node = ElementShim
      globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
      globalThis.window = { addEventListener() {}, removeEventListener() {}, getComputedStyle: globalThis.getComputedStyle, screen: { orientation: { angle: 0 } }, location: { href: 'http://localhost/' } }
      globalThis.document = { readyState: 'loading', addEventListener() {}, removeEventListener() {}, documentElement: {}, visibilityState: 'visible' }

      const require = createRequire(import.meta.url)
      const turnSsr = require(outfile)
      globalThis.__TURN_STORE = { checkpoints: [], openRewind: () => {}, models: [], messages: [] }

      const modelEntry = { entryId: 'u2', forkId: 'a1', index: 1, count: 2, prevTargetId: 'a3', nextTargetId: 'a3', onActivePath: false }
      const binding = { models: new Map([['u2', modelEntry]]), pending: null, error: '', disabled: false, onNavigate: () => {} }
      const withId = { kind: 'user', id: 'turn-u2', msg: { id: 'm7', entryId: 'u2', role: 'user', text: '你好', timestamp: 1 } }
      const withoutId = { kind: 'user', id: 'turn-m8', msg: { id: 'm8', role: 'user', text: '你好', timestamp: 2 } }
      const unknownId = { kind: 'user', id: 'turn-x', msg: { id: 'm9', entryId: 'x', role: 'user', text: '你好', timestamp: 3 } }

      let html = turnSsr.renderToStaticMarkup(turnSsr.React.createElement(turnSsr.TurnView, { turn: withId, branchPager: binding }))
      ok(html.includes('data-testid="v3-branch-pager"'), '带 entryId 且命中模型：画 pager')
      ok(html.includes('>1/2<'), 'pager 显示这条消息自己的序号', html.match(/>\d+\/\d+</)?.[0])

      html = turnSsr.renderToStaticMarkup(turnSsr.React.createElement(turnSsr.TurnView, { turn: withoutId, branchPager: binding }))
      ok(!html.includes('v3-branch-pager'), '无稳定 entryId：不画 pager（不拿合成 id 猜）')

      html = turnSsr.renderToStaticMarkup(turnSsr.React.createElement(turnSsr.TurnView, { turn: unknownId, branchPager: binding }))
      ok(!html.includes('v3-branch-pager'), 'entryId 查不到分叉模型：不画 pager')

      html = turnSsr.renderToStaticMarkup(turnSsr.React.createElement(turnSsr.TurnView, { turn: withId }))
      ok(!html.includes('v3-branch-pager'), '没有绑定模型表：不画 pager')

      ok(html.includes('chat.fork'), '用户消息仍保留原有分叉入口（未被分支切换挤掉）')
    } catch (err) {
      process.stderr.write(`\n[TurnView SSR 失败] ${err && err.stack ? err.stack : err}\n`)
      report.fail += 1
    } finally {
      await rm(outdirTurn, { recursive: true, force: true })
    }
  }

  /* ============================================== 组 5：SessionView 低频读与守卫 */
  group('SessionView：去抖低读树 / 忙态 / owner 切换迟到 / 点击再核 / pending')
  {
    const installTimers = () => {
      const timers = new Map()
      let seq = 0
      globalThis.__PAGER_TIMERS = timers
      globalThis.window = {
        yan: { nativeSession: async () => ({ ok: false, error: 'no bridge' }) },
        setTimeout: (fn, ms) => {
          const id = ++seq
          timers.set(id, { fn, ms, cancelled: false })
          return id
        },
        clearTimeout: (id) => {
          const t = timers.get(id)
          if (t) t.cancelled = true
        },
        addEventListener() {},
        removeEventListener() {},
        location: { href: 'http://localhost/' }
      }
      globalThis.requestAnimationFrame = (fn) => {
        try { fn(0) } catch { /* 浅渲染没有真实帧 */ }
        return 0
      }
      globalThis.cancelAnimationFrame = () => {}
      globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
      globalThis.document = {
        addEventListener() {},
        removeEventListener() {},
        visibilityState: 'visible',
        documentElement: {},
        querySelector: () => null,
        createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} })
      }
      const storage = new Map()
      globalThis.localStorage = {
        getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
        setItem: (k, v) => storage.set(String(k), String(v)),
        removeItem: (k) => storage.delete(String(k)),
        clear: () => storage.clear()
      }
    }
    const runTimers = () => {
      const due = [...globalThis.__PAGER_TIMERS.values()]
      globalThis.__PAGER_TIMERS.clear()
      for (const t of due) if (!t.cancelled) t.fn()
    }
    const controlled = () => {
      const calls = []
      const pending = []
      return {
        calls,
        pending,
        fn: (request) => new Promise((resolveCount) => {
          calls.push(request)
          pending.push({ request, resolve: resolveCount })
        })
      }
    }
    const storeState = (overrides = {}) => {
      const state = {
        session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', isAgentRunning: false, isStreaming: false, isCompacting: false },
        messages: [{ id: 'm0', role: 'user', text: 'hi', entryId: 'u2' }],
        questionLog: [],
        questionLogSession: null,
        runTail: null,
        peekedSessionId: null,
        peekedPath: null,
        approvals: [],
        subagents: [],
        uiRequests: [],
        models: [],
        settings: {},
        checkpoints: [],
        abort: async () => {},
        refreshCheckpoints: async () => {},
        refreshCount: 0,
        refreshSessions: async () => { state.refreshCount += 1 },
        ...overrides
      }
      return state
    }

    installTimers()
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const SessionView = sessionMod.SessionView

    /* (a) 空闲：去抖后只读一次树，签名不变不重复读 */
    const t = controlled()
    globalThis.window.yan.nativeSession = t.fn
    globalThis.__STORE = storeState()
    let tree = rt.render(SessionView, {})
    ok(findByStub(tree, 'turnview').length >= 1, 'SessionView 渲染出用户回合')
    ok(t.calls.length === 0, '去抖前不发请求')
    runTimers()
    ok(t.calls.length === 1 && t.calls[0].action === 'tree' && t.calls[0].expectedSessionId === 'sess-a', '去抖后读取树并绑定会话')
    t.pending[0].resolve({ ok: true, tree: forkTree(), leafId: 'a3' })
    tree = await flush(rt, SessionView, {})
    let pager = findByStub(tree, 'turnview')[0].props.branchPager
    ok(pager && pager.models.get('u2')?.count === 2, '树投影进 TurnView 的 pager 绑定', pager?.models?.get('u2'))
    runTimers()
    ok(t.calls.filter((c) => c.action === 'tree').length === 1, '稳定 entryId 签名下不重复读树')

    /* (b) 忙态不读；结束忙态再读 */
    const tBusy = controlled()
    globalThis.window.yan.nativeSession = tBusy.fn
    const busyState = storeState({ session: { sessionId: 'sess-a', sessionFile: 'A', isStreaming: true } })
    globalThis.__STORE = busyState
    const rtBusy = makeHookRuntime()
    globalThis.__V3_HOOKS = rtBusy
    rtBusy.render(SessionView, {})
    runTimers()
    ok(tBusy.calls.length === 0, '会话忙时不读树')
    busyState.session = { sessionId: 'sess-a', sessionFile: 'A', isStreaming: false }
    rtBusy.render(SessionView, {})
    runTimers()
    ok(tBusy.calls.length === 1, '结束忙态后按去抖补读一次')

    /* (c) owner 切换：旧响应迟到不得覆盖新会话 */
    const tOwner = controlled()
    globalThis.window.yan.nativeSession = tOwner.fn
    const ownerState = storeState()
    globalThis.__STORE = ownerState
    const rtOwner = makeHookRuntime()
    globalThis.__V3_HOOKS = rtOwner
    rtOwner.render(SessionView, {})
    runTimers()
    ok(tOwner.calls.length === 1 && tOwner.calls[0].expectedSessionId === 'sess-a', '先为 sess-a 读树')
    ownerState.session = { sessionId: 'sess-b', sessionFile: 'B', isAgentRunning: false, isStreaming: false, isCompacting: false }
    ownerState.messages = [{ id: 'm1', role: 'user', text: 'B', entryId: 'by' }]
    rtOwner.render(SessionView, {})
    runTimers()
    ok(tOwner.calls.length === 2 && tOwner.calls[1].expectedSessionId === 'sess-b', '切会话后为 sess-b 重读')
    const treeB = { tree: [user('b0', null, [assistant('b1', 'b0', [user('by', 'b1', [assistant('b2', 'by')]), user('bz', 'b1', [assistant('b3', 'bz')])])])], leafId: 'b3' }
    tOwner.pending[1].resolve({ ok: true, ...treeB })
    let ownerTree = await flush(rtOwner, SessionView, {})
    ok(findByStub(ownerTree, 'turnview')[0].props.branchPager.models.has('by'), 'B 的树已投影')
    tOwner.pending[0].resolve({ ok: true, tree: forkTree(), leafId: 'a3' })
    ownerTree = await flush(rtOwner, SessionView, {})
    const ownerPager = findByStub(ownerTree, 'turnview')[0].props.branchPager
    ok(ownerPager.models.has('by') && !ownerPager.models.has('u2'), '迟到的 A 树没有覆盖 B')

    /* (d) 点击导航：请求绑定 + 成功后刷新宿主同步 + pending 防连点 */
    const tNav = controlled()
    globalThis.window.yan.nativeSession = tNav.fn
    const navState = storeState()
    globalThis.__STORE = navState
    const rtNav = makeHookRuntime()
    globalThis.__V3_HOOKS = rtNav
    rtNav.render(SessionView, {})
    runTimers()
    tNav.pending[0].resolve({ ok: true, tree: forkTree(), leafId: 'a2' })
    let navTree = await flush(rtNav, SessionView, {})
    let binding = findByStub(navTree, 'turnview')[0].props.branchPager
    ok(binding.models.get('u2')?.nextTargetId === 'a3', 'u2 的目标是 a3')
    binding.onNavigate('a3')
    ok(tNav.calls.filter((c) => c.action === 'navigate').length === 1, '点击立刻发出 navigate')
    const navCall = tNav.calls.find((c) => c.action === 'navigate')
    assert.deepEqual(navCall, { action: 'navigate', expectedSessionId: 'sess-a', entryId: 'a3' }, '导航请求绑定会话与目标 entryId')
    ok(!('summarize' in navCall), '导航固定不摘要')

    await Promise.resolve()
    await Promise.resolve()
    navTree = rtNav.render(SessionView, {})
    binding = findByStub(navTree, 'turnview')[0].props.branchPager
    ok(binding.pending === 'a3', '在途目标进入 pending')
    binding.onNavigate('a2')
    ok(tNav.calls.filter((c) => c.action === 'navigate').length === 1, 'pending 期间拒绝连续点击')

    tNav.pending.find((p) => p.request === navCall).resolve({ ok: true })
    navTree = await flush(rtNav, SessionView, {})
    ok(navState.refreshCount === 1, '导航成功后刷新正式宿主同步（refreshSessions）')
    runTimers()
    ok(tNav.calls.filter((c) => c.action === 'tree').length >= 2, '成功后就地重读树')

    /* (e) 失败显示原因 */
    const tFail = controlled()
    globalThis.window.yan.nativeSession = tFail.fn
    const failState = storeState()
    globalThis.__STORE = failState
    const rtFail = makeHookRuntime()
    globalThis.__V3_HOOKS = rtFail
    rtFail.render(SessionView, {})
    runTimers()
    tFail.pending[0].resolve({ ok: true, tree: forkTree(), leafId: 'a2' })
    let failTree = await flush(rtFail, SessionView, {})
    let failBinding = findByStub(failTree, 'turnview')[0].props.branchPager
    failBinding.onNavigate('a3')
    const failCall = tFail.calls.find((c) => c.action === 'navigate')
    tFail.pending.find((p) => p.request === failCall).resolve({ ok: false, error: '会话已切换' })
    failTree = await flush(rtFail, SessionView, {})
    failBinding = findByStub(failTree, 'turnview')[0].props.branchPager
    ok(failBinding.error === '会话已切换' && failState.refreshCount === 0, '失败时显示宿主原因且不假装同步成功', failBinding.error)

    /* (f) 点击时再核：目标已失效 / 会话已切走 */
    const tRecheck = controlled()
    globalThis.window.yan.nativeSession = tRecheck.fn
    const recheckState = storeState()
    globalThis.__STORE = recheckState
    const rtRecheck = makeHookRuntime()
    globalThis.__V3_HOOKS = rtRecheck
    rtRecheck.render(SessionView, {})
    runTimers()
    tRecheck.pending[0].resolve({ ok: true, tree: forkTree(), leafId: 'a2' })
    let recheckTree = await flush(rtRecheck, SessionView, {})
    let recheckBinding = findByStub(recheckTree, 'turnview')[0].props.branchPager
    recheckBinding.onNavigate('ghost')
    ok(tRecheck.calls.filter((c) => c.action === 'navigate').length === 0, '目标不在当前树：不发导航')
    recheckTree = rtRecheck.render(SessionView, {})
    recheckBinding = findByStub(recheckTree, 'turnview')[0].props.branchPager
    ok(!!recheckBinding.error, '目标失效给出可读错误', recheckBinding.error)

    recheckState.session = { sessionId: 'sess-elsewhere', sessionFile: 'Z', isAgentRunning: false, isStreaming: false, isCompacting: false }
    recheckBinding.onNavigate('a3')
    ok(tRecheck.calls.filter((c) => c.action === 'navigate').length === 0, '会话已切走：本次点击作废')

    /* (g) 无宿主桥：不伪造树 */
    const rtNoBridge = makeHookRuntime()
    globalThis.__V3_HOOKS = rtNoBridge
    globalThis.window.yan = {}
    globalThis.__STORE = storeState()
    rtNoBridge.render(SessionView, {})
    runTimers()
    const noBridgeTree = rtNoBridge.render(SessionView, {})
    const noBridgePager = findByStub(noBridgeTree, 'turnview')[0].props.branchPager
    ok(noBridgePager.models.size === 0, '无宿主桥时不伪造分叉模型')
  }

  /* ============================================== 组 6：静态边界 */
  group('静态边界：模型层无 React/DOM，CSS 不自画控件外观')
  {
    const modelSrc = await readFile(abs('src/renderer/src/features/session/branch-pager-model.ts'), 'utf8')
    ok(!/from 'react'/.test(modelSrc) && !/document\./.test(modelSrc), '纯投影层不 import React、不碰 DOM')
    ok(modelSrc.includes('entryId') && modelSrc.includes('describeEntry'), '按稳定 entryId / 官方条目描述投影')

    const css = (await readFile(abs('src/renderer/src/features/session/branch-pager.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '')
    ok(css.includes('@layer features'), '版面 CSS 归入 features 层')
    ok(!css.includes('@import'), '模块 CSS 不 @import')
    ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), '不写死颜色（只用令牌变量）')
    ok(!/:hover|:focus-visible|\[data-disabled\]|\[data-pressed\]/.test(css), '不自画按钮悬停 / 焦点 / 禁用外观')

    const turnSrc = await readFile(abs('src/renderer/src/features/session/TurnView.tsx'), 'utf8')
    ok(turnSrc.includes("msg.entryId ? branchPager?.models.get(msg.entryId)"), 'TurnView 只用稳定 entryId 查模型')
    ok(!/models\.get\(msg\.id\)|models\.get\(m\.id\)/.test(turnSrc), '不拿合成 id 当 entryId')
  }

  /* ============================================== 组 7：真实原语 SSR 可访问名称 */
  group('真实 ui/IconButton SSR：分组 / 名称 / 序号落在真实 DOM')
  {
    const outdirSsr = await mkdtemp(join(tmpdir(), 'yan-v3-branch-pager-ssr-'))
    try {
      const entry = [
        "import * as React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        `import { I18nProvider } from '${posix(abs('src/renderer/src/i18n/index.tsx'))}'`,
        `import { BranchPager } from '${posix(abs('src/renderer/src/features/session/BranchPager.tsx'))}'`,
        'export { React, renderToStaticMarkup, I18nProvider, BranchPager }'
      ].join('\n')
      const uiIndex = abs('src/renderer/src/ui/index.ts')
      const iconButton = abs('src/renderer/src/ui/IconButton.tsx')
      const outfile = join(outdirSsr, 'ssr.cjs')
      await build({
        stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
        outfile,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        jsx: 'automatic',
        logLevel: 'silent',
        loader: { '.css': 'empty' },
        plugins: [
          {
            name: 'v3-pager-ssr',
            setup(b) {
              b.onResolve({ filter: /.*/ }, (args) => {
                if (!args.importer || !args.resolveDir) return undefined
                const key = normalize(resolve(args.resolveDir, args.path))
                if (key === uiIndex) return { path: iconButton }
                return undefined
              })
            }
          }
        ]
      })

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
      globalThis.SVGElement = ElementShim
      globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
      globalThis.window = {
        HTMLElement: ElementShim,
        Element: ElementShim,
        Node: ElementShim,
        SVGElement: ElementShim,
        addEventListener() {},
        removeEventListener() {},
        getComputedStyle: globalThis.getComputedStyle,
        screen: { orientation: { angle: 0 } },
        location: { href: 'http://localhost/' }
      }
      globalThis.document = {
        readyState: 'loading',
        addEventListener() {},
        removeEventListener() {},
        documentElement: {},
        body: {},
        visibilityState: 'visible'
      }
      globalThis.window.document = globalThis.document

      const require = createRequire(import.meta.url)
      const ssr = require(outfile)
      const modelEntry = { entryId: 'u2', forkId: 'a1', index: 2, count: 3, prevTargetId: 'p1', nextTargetId: 'n1', onActivePath: true }
      const element = ssr.React.createElement(
        ssr.I18nProvider,
        null,
        ssr.React.createElement(ssr.BranchPager, { model: modelEntry, onNavigate: () => {} })
      )
      const html = ssr.renderToStaticMarkup(element)
      ok(html.includes('data-testid="v3-branch-pager"'), '真实 DOM 带 pager 容器')
      ok(html.includes('role="group"') && html.includes('aria-label="同一分叉点的兄弟分支"'), '分组有可读名称')
      ok(html.includes('aria-label="上一个分支"') && html.includes('aria-label="下一个分支"'), '前后按钮有可读名称')
      ok(html.includes('data-index="2"') && html.includes('data-count="3"'), '真实 DOM 带序号数据')
      ok(html.includes('>2/3<'), '真实 DOM 显示 2/3')
      ok((html.match(/<button/g) ?? []).length === 2, '两个按钮都是真实 button')
    } catch (err) {
      process.stderr.write(`\n[SSR 失败] ${err && err.stack ? err.stack : err}\n`)
      report.fail += 1
    } finally {
      await rm(outdirSsr, { recursive: true, force: true })
    }
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
