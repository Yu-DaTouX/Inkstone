#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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

async function buildRail(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)

  const entry = join(outdir, 'rail-entry.ts')
  await writeFile(
    entry,
    `export { OutlineRail, userTurnRenderIndex } from '${posix(abs('src/renderer/src/features/session/OutlineRail.tsx'))}'
export { StalledCard, currentStalledRun } from '${posix(abs('src/renderer/src/features/session/StalledCard.tsx'))}'
export { stallReason, railText } from '${posix(abs('src/renderer/src/features/session/rail-text.ts'))}'
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

const runOf = (over = {}) => ({
  runId: 'run-1',
  code: 'S1',
  kind: 'session',
  sessionId: 'sess-a',
  sessionPath: 'C:/proj/A.jsonl',
  title: 'A',
  startedAt: 100,
  phase: { kind: 'stalled', since: 1_000, cause: 'no-output' },
  counts: { tools: 0, edits: 0, errors: 0 },
  ...over
})

async function main() {
  installGlobals()
  const intervalIds = installWindow()

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-session-rail-'))
  let rail
  try {
    rail = await import(pathToFileURL(await buildRail(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { OutlineRail, userTurnRenderIndex, StalledCard, currentStalledRun, stallReason } = rail

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
    ok(tree !== null, '3 轮以上：轨道渲染出来')
    const ticks = byTestId(tree, 'v3-outline-tick')
    ok(ticks.length === 3, '每轮用户消息一个刻度（助手不产生刻度）', ticks.length)
    ok(byTestId(tree, 'v3-outline-zone').length === 1, '右缘有独立的悬停窄带（显隐由 CSS 控制）')

    ticks[1].props.onClick()
    ok(jumps.length === 1 && jumps[0] === 1, '点第 2 个刻度报告用户回合下标 1，不自行换算', jumps)
    ticks[2].props.onClick()
    ok(jumps[1] === 2, '点第 3 个刻度报告下标 2', jumps)
    ok(byTestId(tree, 'v3-outline-tick')[0].props['aria-label'].includes('1'), '刻度带「第 N 轮」无障碍名称')
    ok(byTestId(tree, 'v3-outline-tick')[0].props.title === '第一问：改标题', '刻度 title 用该轮用户原话')
  }

  group('OutlineRail：短会话也可导航，空会话不渲染')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    const short = CONVO.slice(0, 4)
    ok(byTestId(rt.render(OutlineRail, { messages: short, onJump: () => {} }), 'v3-outline-tick').length === 2, '2 轮也显示可点击的导航刻度')
    ok(rt.render(OutlineRail, { messages: [], onJump: () => {} }) === null, '空会话：返回 null')
  }

  group('stallReason：原因 / 详情 / 计时来自 runs-v3 的 phase 与文案函数')
  {
    const noOutput = stallReason('zh-CN', { kind: 'stalled', since: 1_000, cause: 'no-output' }, 6_000)
    ok(noOutput.word === '无响应', '无输出：短词「无响应」', noOutput.word)
    ok(noOutput.timing.includes('5'), '无输出：计时是已停滞时长 5 秒', noOutput.timing)
    ok(noOutput.detail === null, '无输出没有额外详情时保持 null', noOutput.detail)

    const toolSilent = stallReason('zh-CN', { kind: 'stalled', since: 0, cause: 'tool-silent', detail: 'npm run build' }, 1_000)
    ok(toolSilent.word === '工具无输出', '工具无输出短词', toolSilent.word)
    ok(toolSilent.detail === 'npm run build', '工具无输出详情带命令标签', toolSilent.detail)

    const retry = stallReason('zh-CN', { kind: 'stalled', since: 0, cause: 'retry', retry: { attempt: 2, max: 3, resumeAt: 30_000 } }, 5_000)
    ok(retry.word === '重试中', '自动重试短词', retry.word)
    ok(retry.detail === '2/3', '自动重试详情是第几次 / 共几次', retry.detail)
    ok(retry.timing.includes('25'), '自动重试显示到 resumeAt 的倒计时 25 秒', retry.timing)

    const loop = stallReason('zh-CN', { kind: 'stalled', since: 0, cause: 'loop', detail: '重复输出被中止，不再自动续接' }, 1_000)
    ok(loop.word === '重复输出', '循环中止短词', loop.word)
    ok(loop.detail === '重复输出被中止，不再自动续接', '循环中止保留原因详情', loop.detail)

    const rate = stallReason('zh-CN', { kind: 'stalled', since: 0, cause: 'rate-limit' }, 2_000)
    ok(rate.word === '限流等待', '限流短词', rate.word)

    ok(stallReason('zh-CN', { kind: 'running', since: 0, activity: 'streaming' }, 1_000) === null, '非停滞阶段返回 null')
    ok(stallReason('en-US', { kind: 'stalled', since: 0, cause: 'loop' }, 1_000).word === 'Looping', '英文环境用英文短词')
  }

  group('currentStalledRun：只认激活视图、只认 stalled、按 id 或归一化路径归属')
  {
    const view = { sessionId: 'sess-a', sessionFile: 'C:/proj/A.jsonl', key: 'C:/proj/A.jsonl' }
    ok(currentStalledRun([runOf()], view, true)?.runId === 'run-1', '激活视图 + 会话 id 命中：返回该运行')
    ok(currentStalledRun([runOf()], view, false) === null, '未激活视图：返回 null（停止动作不会落到别的会话）')
    ok(currentStalledRun([runOf({ phase: { kind: 'running', since: 0, activity: 'streaming' } })], view, true) === null, '运行中不算停滞')
    ok(
      currentStalledRun([runOf({ sessionId: 'sess-z', sessionPath: 'C:/proj/Z.jsonl' })], view, true) === null,
      '别的会话的运行不挂到当前视图'
    )
    const pathOnly = { sessionId: null, sessionFile: 'c:/proj/a.jsonl', key: 'c:/proj/a.jsonl' }
    ok(currentStalledRun([runOf()], pathOnly, true)?.runId === 'run-1', 'path-only 视图按归一化路径命中（大小写 / 分隔符不敏感）')
    const older = runOf({ runId: 'old', startedAt: 1, phase: { kind: 'stalled', since: 5, cause: 'retry' } })
    ok(currentStalledRun([older, runOf()], view, true)?.runId === 'run-1', '同一会话多条停滞：取最新开始的那条')
  }

  group('StalledCard：原因 / 计时 / 停止，不自动续跑')
  {
    const rt = makeHookRuntime()
    globalThis.__V3_HOOKS = rt
    let stopped = 0
    let tree = rt.render(StalledCard, { run: runOf(), onStop: () => { stopped += 1 } })
    ok(byTestId(tree, 'v3-stall').length === 1, '停滞运行渲染出卡片')
    const texts = JSON.stringify(tree)
    ok(texts.includes('运行停滞'), '卡片标题「运行停滞」')
    ok(texts.includes('无响应'), '卡片显示来自 phase 的原因短词')
    ok(texts.includes('不会自动续跑或停止'), '卡片注明不会自动续跑 / 停止')

    const buttons = byStub(tree, 'button')
    ok(buttons.length === 1, '只有一个动作按钮（停止），没有「换模型 / 继续」等未实现动作', buttons.length)
    ok(buttons[0].props.variant === 'danger', '停止用危险按钮外观')
    buttons[0].props.onPress()
    ok(stopped === 1, '点击停止调用传入的动作（SessionView 接到 store.abort）', stopped)

    ok(rt.render(StalledCard, { run: runOf({ phase: { kind: 'running', since: 0, activity: 'streaming' } }), onStop: () => {} }) === null, '运行中不显示停滞卡')
    ok(rt.render(StalledCard, { run: null, onStop: () => {} }) === null, '无运行不显示停滞卡')

    intervalIds.clear()
    tree = rt.render(StalledCard, { run: runOf({ phase: { kind: 'stalled', since: 0, cause: 'retry', retry: { attempt: 1, max: 2, resumeAt: Date.now() + 60_000 } } }), onStop: () => {} })
    ok(JSON.stringify(tree).includes('后重试'), '自动重试卡片显示倒计时')
    ok(intervalIds.size >= 1, '停滞期间登记秒级刷新计时器')
    ok(typeof tree.props.children !== 'undefined', '卡片内容完整')
  }

  group('细刻度常驻 + 悬停展开卡片 + 减少动态效果：外观规则')
  {
    const css = readFileSync(resolve(ROOT, 'src/renderer/src/features/session/rail.css'), 'utf8')
    const look = readFileSync(resolve(ROOT, 'src/renderer/src/features/session/ui/rail-look.css'), 'utf8')
    ok(css.includes('.v3-rail[data-open] .v3-rail-card') && look.includes('.v3-rail[data-open] .v3-rail-card'), '展开由 data-open 控制，卡片在展开时才可见可点')
    ok(/v3-rail-tick:focus-visible/.test(look), '刻度有可见的键盘焦点环')
    ok(/v3-rail-tick\[aria-current\]/.test(look) && css.includes('left: var(--s-8)'), '刻度列在左侧常驻，当前轮高亮')

    ok(/prefers-reduced-motion:\s*reduce/.test(look), 'rail-look.css 声明了 reduced-motion 分支')
    ok(/prefers-reduced-motion[\s\S]*transition:\s*none/.test(look), 'reduced-motion 下把过渡关掉')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
