#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
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

function installWindow() {
  const intervalIds = new Map()
  let nextId = 1
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' },
    setInterval: (fn) => {
      const id = nextId++
      intervalIds.set(id, fn)
      return id
    },
    clearInterval: (id) => intervalIds.delete(id)
  }
  return intervalIds
}

const REACT_SHIM = `/* v3 会话轨回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
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

function abs(rel) {
  return normalize(resolve(ROOT, rel))
}

function makeStubPlugin(rawMap) {
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
  return {
    name: 'v3-session-rail-stubs',
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
        return { contents: fillMissingExports(key, stubMap.get(key) ?? 'export {}'), loader: 'js' }
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

async function buildRail(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)

  const entry = join(outdir, 'rail-entry.ts')
  await writeFile(
    entry,
    `export { OutlineRail, userTurnRenderIndex } from '${posix(abs('src/renderer/src/features/session/OutlineRail.tsx'))}'
export { minimapIndexAt, minimapTopPercent, plainPreview, firstLine, turnPreview } from '${posix(abs('src/renderer/src/features/session/outline-minimap.ts'))}'
export { sessionViewIdentity, sameViewPath } from '${posix(abs('src/renderer/src/features/session/view-state.ts'))}'
`
  )
  const out = join(outdir, 'rail-bundle.mjs')
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
    plugins: [
      makeStubPlugin({
        'src/renderer/src/i18n/index.tsx': `export function useT(){ return (k, vars)=> vars && vars.n !== undefined ? String(k) + ' ' + vars.n : String(k) }
export function useI18n(){ return { lang: 'zh-CN', t: (k)=>String(k), setLang(){}, toggleLang(){} } }
export function translate(_l,k){ return String(k) }`,
        'src/renderer/src/ui/index.ts': `export function Button(){ return null }
Button.__stub = 'button'`,
        'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }
Icon.__stub = 'icon'`
      })
    ]
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
const byStub = (tree, name) => collect(tree, (el) => el.type && el.type.__stub === name)
const byTypeName = (tree, name) => collect(tree, (el) => typeof el.type === 'function' && el.type.name === name)

const msg = (id, role, text, extra = {}) => ({ id, role, text, ...extra })

const CONVO = [
  msg('u1', 'user', '第一问：改标题', { timestamp: 1 }),
  msg('a1', 'assistant', '第一答', { timestamp: 2 }),
  msg('u2', 'user', '第二问：跑测试', { timestamp: 3 }),
  msg('a2', 'assistant', '第二答', { timestamp: 4 }),
  msg('u3', 'user', '第三问：发版', { timestamp: 5 }),
  msg('a3', 'assistant', '第三答', { timestamp: 6 })
]

async function main() {
  installGlobals()
  installWindow()

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-session-rail-'))
  let rail
  try {
    rail = await import(pathToFileURL(await buildRail(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { OutlineRail, userTurnRenderIndex, minimapIndexAt, minimapTopPercent, plainPreview, firstLine, turnPreview } = rail

  group('userTurnRenderIndex：用户回合下标 → 含助手块的回合下标')
  {
    const turns = [{ kind: 'user' }, { kind: 'assistant' }, { kind: 'user' }, { kind: 'assistant' }, { kind: 'user' }, { kind: 'assistant' }]
    ok(userTurnRenderIndex(turns, 0) === 0, '第 0 个用户回合在数组第 0 位', userTurnRenderIndex(turns, 0))
    ok(userTurnRenderIndex(turns, 1) === 2, '第 1 个用户回合跳过助手块，落在第 2 位', userTurnRenderIndex(turns, 1))
    ok(userTurnRenderIndex(turns, 2) === 4, '第 2 个用户回合落在第 4 位', userTurnRenderIndex(turns, 2))
    ok(userTurnRenderIndex(turns, 3) === undefined, '越界的用户回合返回 undefined，不落到最后一轮', userTurnRenderIndex(turns, 3))
    ok(userTurnRenderIndex(turns, 2) !== turns.length - 1, '定位目标是目标轮（4），不是最后一轮（5）→ 不会强拉到底部')
  }

  group('OutlineRail：真实投影列用户回合，点击报告正确下标')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const jumps = []
    let tree = rt.render(OutlineRail, { messages: CONVO, onJump: (i) => jumps.push(i) })
    ok(tree !== null && byTestId(tree, 'v3-outline-rail').length === 1, '3 轮以上：小地图根节点渲染出来')
    const ticks = byTestId(tree, 'v3-outline-tick')
    ok(ticks.length === 3, '每轮用户消息一个刻度（助手不产生刻度）', ticks.length)
    ok(ticks.every((tick, i) => tick.props['data-index'] === i), '刻度保留 data-index 序号', ticks.map((tick) => tick.props['data-index']))
    ok(ticks.every((tick) => tick.props['aria-hidden']), '刻度本身对读屏隐藏')
    ok(ticks[0].props.style.top === '0%' && ticks[2].props.style.top === '100%' && ticks[1].props.style.top === '50%', '刻度按比例均匀分布在竖轨上', ticks.map((tick) => tick.props.style.top))

    const stopped = []
    const click = () => ({ stopPropagation: () => stopped.push(true) })
    ticks[1].props.onClick(click())
    ok(jumps.length === 1 && jumps[0] === 1, '点第 2 个刻度报告用户回合下标 1，不自行换算', jumps)
    ticks[2].props.onClick(click())
    ok(jumps[1] === 2, '点第 3 个刻度报告下标 2', jumps)
    ok(stopped.length === 2, '刻度自己的点击不再冒泡到轨道的按坐标换算', stopped.length)

    const sliders = collect(tree, (el) => el.props?.role === 'slider')
    ok(sliders.length === 1, '整条轨道是一个滑块控件', sliders.length)
    const slider = sliders[0]
    ok(slider?.props.tabIndex === 0 && slider?.props['aria-orientation'] === 'vertical', '滑块可聚焦且为竖向')
    ok(slider?.props['aria-valuemin'] === 1 && slider?.props['aria-valuemax'] === 3, '取值范围是轮次序号 1..N', [slider?.props['aria-valuemin'], slider?.props['aria-valuemax']])
    ok(byTestId(tree, 'v3-outline-prev').length === 1 && byTestId(tree, 'v3-outline-next').length === 1, '上一轮、下一轮按钮都在')
    ok(byTestId(tree, 'v3-outline-prev')[0].props['aria-label'] === 'outline.prev' && byTestId(tree, 'v3-outline-next')[0].props.title === 'outline.next', '上下按钮带无障碍名称与 title')
    ok(byTestId(tree, 'v3-outline-preview').length === 1, '预览卡容器常驻（悬停或聚焦时才填内容）')
    ok(byTestId(tree, 'v3-outline-preview')[0].props.children === null, '未悬停时不计算预览摘要')
  }

  group('OutlineRail：短会话也可导航，单轮只占位，空会话不渲染')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const short = CONVO.slice(0, 4)
    ok(byTestId(rt.render(OutlineRail, { messages: short, onJump: () => {} }), 'v3-outline-tick').length === 2, '2 轮也显示可点击的导航刻度')
    const single = rt.render(OutlineRail, { messages: CONVO.slice(0, 2), onJump: () => {} })
    ok(single !== null && single.props.hidden === true && byTestId(single, 'v3-outline-tick').length === 0, '1 轮：只渲染隐藏占位，用来提前留出正文列的位置', single && single.props)
    ok(rt.render(OutlineRail, { messages: [], onJump: () => {} }) === null, '空会话：返回 null')
  }

  group('小地图换算：纵坐标比例 → 最近的轮次')
  {
    ok(minimapTopPercent(0, 5) === 0 && minimapTopPercent(4, 5) === 100 && minimapTopPercent(2, 5) === 50, '首尾在 0% 与 100%，中间均分')
    ok(minimapTopPercent(0, 1) === 0, '单轮落在顶端')
    ok(minimapIndexAt(0, 400, 147) === 0 && minimapIndexAt(400, 400, 147) === 146, '顶端是第一轮，底端是最后一轮')
    ok(minimapIndexAt(-30, 400, 147) === 0 && minimapIndexAt(999, 400, 147) === 146, '越界坐标夹到首尾')
    ok(minimapIndexAt(200, 400, 147) === 73, '中点换算到最近的轮次', minimapIndexAt(200, 400, 147))
    ok(minimapIndexAt(3, 8, 2) === 0 && minimapIndexAt(5, 8, 2) === 1, '两轮时按就近取整')
    ok(minimapIndexAt(10, 0, 3) === 0 && minimapIndexAt(10, 100, 0) === -1, '零高度回落到首轮，零轮返回 -1')
  }

  group('预览卡文字：首行与答复纯文字')
  {
    ok(firstLine('\n\n  第一行  \n第二行') === '第一行', '用户首行跳过空行并去掉首尾空白')
    const md = '# 标题\n\n**加粗** 与 *斜体*、`code` 和 [链接](https://x.y)。\n\n- 列表项\n- [x] 任务\n\n> 引用\n\n```ts\nconst a = 1\n```\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n\n---\n~~删~~ snake_case_name'
    const plain = plainPreview(md)
    ok(!/[#*`>|~]|\]\(|```/.test(plain), '去掉 markdown 记号', plain)
    ok(plain.startsWith('标题 加粗 与 斜体、code 和 链接。 列表项 任务 引用 const a = 1'), '保留正文顺序并压成一行', plain)
    ok(plain.includes('列 · 值') && plain.includes('a · 1'), '表格行改成分隔的纯文字', plain)
    ok(plain.includes('snake_case_name'), '标识符里的下划线不当作斜体', plain)
    ok(plainPreview('x'.repeat(1000)).length === 400, '最多只处理前 400 字符', plainPreview('x'.repeat(1000)).length)
    const turn = { user: '问\n补充', assistant: '**答**', msgId: 'm', index: 0, failed: false, steps: 0 }
    const a = turnPreview(turn)
    ok(a.line === '问' && a.answer === '答', '每轮预览取用户首行与答复摘要', a)
    ok(turnPreview(turn) === a, '同一轮对象的预览按对象缓存')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0 || report.pass === 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
