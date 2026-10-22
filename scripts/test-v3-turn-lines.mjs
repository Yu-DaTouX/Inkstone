#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
export function createContext(value) { return { __value: value, Provider: () => null } }
export function useContext(context) { return context.__value }
export function useId() { return rt().useId() }
export function createElement(type, props, ...children) { const out = props ? { ...props } : {}; if (children.length) out.children = children.length === 1 ? children[0] : children; return { type, props: out } }
export function forwardRef(fn) { return fn }
export function memo(fn) { return fn }
export function isValidElement(el) { return !!el && typeof el === 'object' && 'type' in el && 'props' in el }
export default { Fragment, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, useDebugValue, createContext, useContext, useId, createElement, forwardRef, memo, isValidElement }
`

const JSX_SHIM = `import { createElement, Fragment } from './react-shim.mjs'
export { Fragment }
export function jsx(type, props, key) { const el = createElement(type, props); if (key !== undefined) el.key = key; return el }
export const jsxs = jsx
export const jsxDEV = jsx
`

function installGlobals() {
  globalThis.__V3_STORE = {}
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
const textOf = (el) => (typeof el.props?.children === 'string' ? el.props.children : '')
const flattenText = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (node && typeof node === 'object' && node.props) return flattenText(node.props.children)
  return ''
}

const DEFINE = {
  'import.meta.env.DEV': 'false',
  'import.meta.env.PROD': 'true',
  'process.env.NODE_ENV': '"production"',
  requestAnimationFrame: 'globalThis.requestAnimationFrame',
  cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
}

const STORE_STUB = `export const useStore = (selector) => selector(globalThis.__V3_STORE)
useStore.getState = () => globalThis.__V3_STORE
useStore.setState = (patch) => { Object.assign(globalThis.__V3_STORE, typeof patch === 'function' ? patch(globalThis.__V3_STORE) : patch) }
`

const UI_STUB = `export function Button(props){ return null } Button.__stub='ui-button'
export function IconButton(props){ return null } IconButton.__stub='ui-iconbutton'
export function Badge(props){ return null } Badge.__stub='ui-badge'
export function Dialog(props){ return null } Dialog.__stub='ui-dialog'
export function Modal(props){ return null } Modal.__stub='ui-modal'
export function ModalOverlay(props){ return null } ModalOverlay.__stub='ui-modal-overlay'
export function ProgressBar(props){ return null } ProgressBar.__stub='ui-progress'
export function StatusDot(props){ return null } StatusDot.__stub='ui-status-dot'
export function StatusSlot(props){ return null } StatusSlot.__stub='ui-status-slot'
export function Card(props){ return null } Card.__stub='ui-card'
export function ShimmerText(props){ return null } ShimmerText.__stub='ui-shimmer'
`

const ICON_STUB = `export function Icon(){ return null } Icon.__stub='icon'
`

const DIFF_STUB = `export function DiffView(){ return null } DiffView.__stub='diff'
`

const I18N_STUB = `export function useT(){ return (k, vars) => vars ? k + JSON.stringify(vars) : String(k) }
export function useI18n(){ return { lang: 'zh-CN', t: (k) => String(k) } }
export function translate(_l,k){ return String(k) }
`

const TEXT_STUB = `export function useSessionText(){ return (k, vars) => { let s = String(k); if (vars) for (const [n,v] of Object.entries(vars)) s = s.split('{'+n+'}').join(String(v)); return s } }
export function sessionText(_l,k, vars){ let s = String(k); if (vars) for (const [n,v] of Object.entries(vars)) s = s.split('{'+n+'}').join(String(v)); return s }
`

function makeStubPlugin(rawMap) {
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
  return {
    name: 'v3-turn-lines-stubs',
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

async function buildBundle(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const entry = join(outdir, 'entry.ts')
  await writeFile(entry, [
    `export * from '${posix(abs('src/renderer/src/features/session/turn-lines.ts'))}'`,
    `export { SubagentLine, subagentTitle } from '${posix(abs('src/renderer/src/features/session/SubagentLine.tsx'))}'`,
    `export { orderSubagentRuns, subagentListRank, subagentListSlice, subagentNeighbor, subagentRowFocusTarget, subagentSiblings, useSubagentGroups } from '${posix(abs('src/renderer/src/features/session/subagent-list.ts'))}'`,
    `export { swapLayoutTiles, switchSubagentPane } from '${posix(abs('src/renderer/src/features/session/subagent-actions.ts'))}'`,
    `export { toolExpansion } from '${posix(abs('src/renderer/src/features/session/tool-expansion.ts'))}'`,
    `export { columnLayout, orderedTileIds } from '${posix(abs('src/renderer/src/features/workbench/tile-tree.ts'))}'`,
    `export { ErrorCard } from '${posix(abs('src/renderer/src/features/session/ErrorCard.tsx'))}'`,
    `export { CompactionMarker, CompactCommandEcho } from '${posix(abs('src/renderer/src/features/session/CompactionMarker.tsx'))}'`,
    `export { BranchSummary } from '${posix(abs('src/renderer/src/features/session/BranchSummary.tsx'))}'`,
    `export { modelErrorNotice } from '${posix(abs('src/shared/model-errors.ts'))}'`,
    `export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'`,
    `export { useRunsV3 } from '${posix(abs('src/renderer/src/state/runs-v3.ts'))}'`,
    `export { useUiV3 } from '${posix(abs('src/renderer/src/state/ui-v3.ts'))}'`
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
      'src/renderer/src/state/store.ts': STORE_STUB,
      'src/renderer/src/ui/index.ts': UI_STUB,
      'src/renderer/src/features/session/Icon.tsx': ICON_STUB,
      'src/renderer/src/i18n/index.tsx': I18N_STUB,
      'src/renderer/src/features/session/text.ts': TEXT_STUB,
      'src/renderer/src/features/diff/index.ts': DIFF_STUB
    })]
  })
  return out
}

const notice = (raw) => lib.modelErrorNotice(raw)

const subagentRun = (over = {}) => ({
  id: 'sub-1',
  task: '补齐 PKCE 单元测试',
  cwd: '/p',
  parentSessionId: 'sess-a',
  parentRunId: 'run-a',
  parentMessageId: 'a1',
  isolation: 'worktree',
  status: 'running',
  startedAt: 1_000,
  transcript: [],
  review: 'none',
  ...over
})

const runSnapshot = (over = {}) => ({
  runId: 'sub-1',
  code: 'S12·1',
  kind: 'subagent',
  sessionId: 'sess-a',
  parentRunId: 'run-a',
  title: '子 Agent',
  model: { provider: 'anthropic', id: 'sonnet', label: 'Sonnet 5.5', thinking: '中' },
  startedAt: 1_000,
  phase: { kind: 'running', since: 1_000, activity: 'tool', tool: { name: 'read', label: 'read', callId: 't1' } },
  counts: { tools: 3, edits: 1, errors: 0 },
  ...over
})

let lib
let rt

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-turn-lines-'))
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

  group('错误归类 → 可用动作（看脱敏原文，不被解释文案带偏）')
  {
    const rate = lib.errorCardModel(notice('429 rate limit exceeded'))
    ok(rate && rate.kind === 'quota' && rate.quotaScope === 'rate', '限流认成 quota/rate', rate && [rate.kind, rate.quotaScope])
    ok(rate && rate.actions.includes('retry') && rate.actions.includes('model'), '限流给重试 + 换模型', rate && rate.actions)

    const usage = lib.errorCardModel(notice("You've used all 100 free requests for today"))
    ok(usage && usage.kind === 'quota' && usage.quotaScope === 'usage', '额度用尽认成 quota/usage', usage && [usage.kind, usage.quotaScope])
    ok(usage && !usage.actions.includes('retry') && usage.actions.includes('model'), '额度用尽不给重试，只给换模型', usage && usage.actions)

    const auth = lib.errorCardModel(notice('401 unauthorized invalid api key'))
    ok(auth && auth.kind === 'auth' && auth.actions.length === 1 && auth.actions[0] === 'model', '认证失败只给换模型', auth && auth.actions)

    const context = lib.errorCardModel(notice('context length exceeded'))
    ok(context && context.kind === 'context' && context.actions.length === 1 && context.actions[0] === 'compact', '上下文超限给压缩', context && context.actions)

    const aborted = lib.errorCardModel(notice('Request aborted by user'))
    ok(aborted && aborted.kind === 'aborted' && aborted.actions.length === 0, '用户取消不给动作', aborted && aborted.actions)

    const generic = lib.errorCardModel(notice('fetch failed ECONNRESET'))
    ok(generic && generic.kind === 'retryable' && generic.actions.includes('retry') && generic.actions.includes('model'), '网络类给重试 + 换模型', generic && generic.actions)

    ok(lib.errorCardModel('') === null && lib.errorCardModel(undefined) === null, '没有错误文本就不出卡片')
    ok(lib.errorTitleKey(usage) === 'errorTitleQuotaUsage' && lib.errorTitleKey(rate) === 'errorTitleQuotaRate', '额度标题按细分走不同文案')
  }

  group('重试定位这一轮的用户提示')
  {
    const messages = [
      { id: 'u1', role: 'user', text: '第一问' },
      { id: 'a1', role: 'assistant', text: '答一' },
      { id: 'u2', role: 'user', text: '第二问', images: [{ mimeType: 'image/png', data: 'AAA' }] },
      { id: 'a2', role: 'assistant', text: '答二' }
    ]
    const p2 = lib.promptForTurn(['a2'], messages)
    ok(p2 && p2.text === '第二问' && p2.images.length === 1 && p2.images[0].mimeType === 'image/png', '取到这一轮前最近的用户提示与图片', p2)
    const p1 = lib.promptForTurn(['a1'], messages)
    ok(p1 && p1.text === '第一问', '更早的回合取到它自己的提示', p1)
    ok(lib.promptForTurn(['missing'], messages) === null, '定位不到就不给提示（也就不给重试）')
  }

  group('压缩标记：进行中优先，其次最近一次')
  {
    const running = { status: 'running', reason: 'threshold' }
    const last = { status: 'completed', reason: 'manual' }
    const a = lib.compactionLineModel(running, last)
    ok(a && a.running === true && a.run === running, '有进行中的压缩就先显示它', a && a.running)
    const b = lib.compactionLineModel(undefined, last)
    ok(b && b.running === false && b.run === last, '没有进行中就显示最近一次')
    ok(lib.compactionLineModel(undefined, undefined) === null, '没有记录就不显示（历史缺记录不写未发生过）')
    const msgs = [
      { id: 'u1', role: 'user', text: 'a', timestamp: 100 },
      { id: 'a1', role: 'assistant', text: 'b', timestamp: 110 },
      { id: 'u2', role: 'user', text: 'c', timestamp: 300 },
      { id: 'a2', role: 'assistant', text: 'd', timestamp: 310 }
    ]
    ok(lib.compactionAnchorId(msgs, { status: 'completed', startedAt: 200, endedAt: 250 }) === 'a1', '压缩标记锚定在压缩发生时的回合，不跟随后续新回合')
    ok(lib.compactionAnchorId(msgs, { status: 'completed', startedAt: 400 }) === 'a2', '刚压缩完时显示在最新回合')
    ok(lib.compactionAnchorId(msgs, { status: 'completed', startedAt: 50 }) === null, '早于所有回复的压缩不挂到任何回合')
    ok(lib.compactionAnchorId(msgs, undefined) === null, '没有压缩记录不显示')
  }

  group('分支摘要：按视图身份取分叉来源')
  {
    const sessions = [
      { id: 'sess-a', path: 'C:\\p\\A.jsonl', branchOrigin: '父会话里那句话' },
      { id: 'sess-b', path: 'C:/p/B.jsonl', branchOrigin: '' }
    ]
    ok(lib.branchOriginOf(sessions, { sessionId: 'sess-a', sessionFile: null }) === '父会话里那句话', '按 id 取到分叉来源')
    ok(lib.branchOriginOf(sessions, { sessionId: null, sessionFile: 'c:/p/a.jsonl' }) === '父会话里那句话', 'path-only 视图按归一化路径取到来源')
    ok(lib.branchOriginOf(sessions, { sessionId: 'sess-b', sessionFile: null }) === null, '根会话没有来源就不显示')
    ok(lib.branchOriginOf(sessions, { sessionId: null, sessionFile: 'C:/p/missing.jsonl' }) === null, '匹配不到就不猜')
  }

  group('视图边缘：会话级行只画一次')
  {
    const messages = [
      { id: 'u1', role: 'user', text: '问' },
      { id: 'a1', role: 'assistant', text: '答一' },
      { id: 'a2', role: 'assistant', text: '答二' }
    ]
    ok(lib.viewEdge(['a1'], messages, false).first === true, '第一条助手回合 = 首条')
    ok(lib.viewEdge(['a2'], messages, false).first === false, '后面的回合不是首条')
    ok(lib.viewEdge(['a2'], messages, false).last === true, '含最后一条消息的回合 = 末条')
    ok(lib.viewEdge(['a1'], messages, false).last === false, '不含量最后一条消息的回合不是末条')
    ok(lib.viewEdge(['a2'], messages, true).last === true, '流式中的回合算末条')
    ok(lib.viewEdge(['a1'], [], false).first === false, '消息为空时不冒认边缘')
  }

  group('子 Agent 行：运行投影优先，只有 agent_settled 才算终态')
  {
    const fromPhase = lib.subagentLineModel(subagentRun({ status: 'done', endedAt: 5_000 }), runSnapshot(), 9_000)
    ok(fromPhase.phase && fromPhase.phase.kind === 'running', '有快照时状态取自 runs-v3 阶段')
    ok(fromPhase.terminal === false && fromPhase.live === true, '快照仍在 running：即使子代理记录写了 done 也不算终态', { terminal: fromPhase.terminal, live: fromPhase.live })
    ok(fromPhase.code === 'S12·1', '编号取快照', fromPhase.code)
    ok(fromPhase.model === 'Sonnet 5.5 · 中', '模型取快照的 label 与思考档', fromPhase.model)
    ok(fromPhase.isolation === 'worktree', '范围来自子代理记录')

    const settled = lib.subagentLineModel(subagentRun({ status: 'running' }), runSnapshot({ phase: { kind: 'done', at: 4_000, seen: false } }), 9_000)
    ok(settled.terminal === true && settled.live === false, '快照 done：终态', { terminal: settled.terminal, live: settled.live })
    ok(settled.elapsedMs === 3_000, '终态用结束时刻算用时', settled.elapsedMs)

    const noSnapshot = lib.subagentLineModel(subagentRun({ status: 'error', endReason: 'timeout' }), undefined, 9_000)
    ok(noSnapshot.phase === null && noSnapshot.terminal === true, '没有快照退回子代理记录：非运行态即终态')
    ok(noSnapshot.outcomeKey === 'timeout', '超时说成 timeout，不压成失败', noSnapshot.outcomeKey)

    const running = lib.subagentLineModel(subagentRun({ startedAt: 1_000 }), undefined, 4_500)
    ok(running.terminal === false && running.elapsedMs === 3_500, '运行中用 now 算已用时长', running.elapsedMs)

    const diff = lib.subagentLineModel(subagentRun({ status: 'done', endedAt: 2_000, diff: { files: 3, additions: 10, deletions: 2, paths: [], truncated: false } }), undefined, 9_000)
    ok(diff.diff && diff.diff.files === 3 && diff.diff.additions === 10, '改动统计只在有文件时给出', diff.diff)
    const noDiff = lib.subagentLineModel(subagentRun({ status: 'done', endedAt: 2_000, diff: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false } }), undefined, 9_000)
    ok(noDiff.diff === null, '没有改动就不写统计')

    ok(lib.findSubagentSnapshot([{ runId: 'sub-1', kind: 'session' }], 'sub-1') === undefined, '只认 kind=subagent 的快照')
    ok(lib.findSubagentSnapshot([runSnapshot()], 'sub-1')?.runId === 'sub-1', '按 runId 找到子代理快照')
  }

  const store = (over = {}) => {
    globalThis.__V3_STORE = {
      subagents: [],
      session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' },
      peekedSessionId: null,
      peekedPath: null,
      messages: [],
      sessions: [],
      send: async () => true,
      cycleModel: async () => {},
      compact: async () => {},
      ...over
    }
    return globalThis.__V3_STORE
  }

  const resetPanes = () => lib.useUiV3.setState({ workspaceOpen: false, workspaceTab: 'files', workspacePanes: [] })

  const kind = (name) => (el) => typeof el.type === 'function' && el.type.name === name
  const stub = (name) => (el) => typeof el.type === 'function' && el.type.__stub === name
  const rowsOf = (line) => collect(line, kind('SubagentRow'))
  const renderRowEl = (el) => {
    const saved = rt.cells
    rt.cells = []
    const out = rt.render(el.type, el.props)
    rt.cells = saved
    return out
  }
  const resetExpansion = () => lib.toolExpansion.clear()

  group('SubagentLine：单个子 Agent 是一行，点开右侧转录窗格')
  {
    lib.useRunsV3.setState({ runs: [runSnapshot()], revision: 1, syncing: false, error: null, buffer: [] })
    resetPanes()
    resetExpansion()
    rt.cells = []
    store({ subagents: [subagentRun({ status: 'done', endedAt: 5_000, toolCalls: 4, usage: { input: 9_000, output: 3_000 }, result: { summary: '补齐了 PKCE 测试', summaryTruncated: false, summaryFrom: 'last-message', sources: ['src/a.ts'], artifacts: ['test/a.test.ts'], openQuestions: [], at: 5_000 } })] })
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const line = rt.render(bundle.SubagentLine, { turn })
    ok(line && byTestId(line, 'v3-subagents').length === 1 && line.props['data-layout'] === 'single', '挂在这一轮上的子 Agent 渲染成单行', line?.props['data-layout'])
    ok(byTestId(line, 'v3-subagents-sum').length === 0 && byTestId(line, 'v3-subagents-progress').length === 0, '只有一条时不加组头与进度条')
    ok(collect(line, stub('ui-card')).length === 1 && byTestId(line, 'v3-subagent-list').length === 1, '行放在 ui/Card 里的列表中')
    const rowEl = rowsOf(line)[0]
    ok(!!rowEl, '行组件存在')
    const row = renderRowEl(rowEl)
    ok(row.type === 'button' && row.props.type === 'button' && row.props.className.includes('ui-row'), '整行是按钮，外观来自 ui-row（Tab 可达，Enter 打开）', row.props.className)
    ok(row.props['data-state'] === 'done', '行状态取自任务行（subagent-task-rows）', row.props['data-state'])
    const stateIcon = collect(row, kind('SubagentStateIcon'))[0]
    ok(stateIcon?.props.state === 'done', '状态用小图标表示', stateIcon?.props.state)
    const task = textOf(byTestId(row, 'v3-subagent-task')[0])
    ok(task.includes('PKCE') && task !== subagentRun().task, '标题是任务行带时态的状态文字', task)
    ok(textOf(byTestId(row, 'v3-subagent-usage')[0]) === '4 个工具 · 12k tokens', '上下文未知时，完成后用量列是「N 个工具 · tokens」', textOf(byTestId(row, 'v3-subagent-usage')[0]))
    ok(textOf(byTestId(row, 'v3-subagent-time')[0]) === '4s', '用时单独一列', textOf(byTestId(row, 'v3-subagent-time')[0]))
    const bots = collect(row, kind('SubagentBot'))
    ok(bots.length === 1 && bots[0].props.size === 20, '行首 Bot 为 20px', bots.map((el) => el.props.size))
    ok(byTestId(row, 'v3-subagent-model').length === 0, '没有模型时不写模型名')
    ok(row.props['aria-current'] === undefined && row.props['data-selected'] === undefined, '未打开时不标选中')
    row.props.onClick()
    const ui = lib.useUiV3.getState()
    ok(ui.workspaceOpen === true && ui.workspaceTab === 'subagent:sub-1' && ui.workspacePanes.includes('subagent:sub-1'), '点击后右侧工作区打开 subagent:<runId> 窗格并聚焦', { open: ui.workspaceOpen, tab: ui.workspaceTab, panes: ui.workspacePanes })
    const pressed = renderRowEl(rowEl)
    ok(pressed.props['aria-current'] === 'true' && pressed.props['data-selected'] === '', '窗格打开时行显示为选中')
    pressed.props.onClick()
    ok(lib.useUiV3.getState().workspacePanes.filter((id) => id === 'subagent:sub-1').length === 1, '再点不会重复开窗格')
    resetPanes()
  }

  group('SubagentLine：运行中显示最近动作与调用次数，模型名来自目录，失败显示原因')
  {
    lib.useRunsV3.setState({ runs: [], revision: 3, syncing: false, error: null, buffer: [] })
    resetPanes()
    resetExpansion()
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const renderRow = () => {
      rt.cells = []
      const line = rt.render(bundle.SubagentLine, { turn })
      return { line, row: renderRowEl(rowsOf(line)[0]) }
    }
    const flash = 'commandcode/deepseek/deepseek-v4.1-flash'
    store({
      subagents: [subagentRun({ model: flash, thinkingLevel: 'medium', latestActivity: '运行 read', toolCalls: 9, contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 } })],
      models: [{ provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
    })
    const { line, row } = renderRow()
    ok(byTestId(line, 'v3-subagents-live').length === 0, '不再单独写「N 个任务正在运行」')
    const name = byTestId(row, 'v3-subagent-model')[0]
    ok(flattenText(name) === 'DeepSeek V4.1 Flash · state.think.medium', '模型用菜单名，后接推理档位', name && flattenText(name))
    ok(collect(name, (el) => el?.props?.className === 'v3-sa-model-tail').length === 1, '推理档位单独一段，模型名过长时只截模型名')
    ok(name?.props.title === flash, '悬停保留完整模型身份', name?.props.title)
    const stateIcon = collect(row, kind('SubagentStateIcon'))[0]
    ok(stateIcon?.props.state === 'running', '运行中的状态图标', stateIcon?.props.state)
    ok(collect(byTestId(row, 'v3-subagent-task')[0], stub('ui-shimmer')).length === 1, '运行中的标题用 ShimmerText')
    ok(byTestId(row, 'v3-subagent-usage').length === 0, '运行中不写最近动作与调用次数')
    const gauge = collect(row, kind('ContextGauge'))[0]
    ok(gauge?.props.usage.percent === 25 && gauge?.props['data-testid'] === 'v3-subagent-context', '运行中显示上下文圆环', gauge?.props.usage)
    const liveTitle = textOf(byTestId(row, 'v3-subagent-task')[0])
    ok(!liveTitle.startsWith('进行中') && !liveTitle.startsWith('Running'), '运行中标题不带状态词', liveTitle)
    ok(byTestId(row, 'v3-subagent-time').length === 1, '运行中显示用时')

    store({ subagents: [subagentRun({ model: flash })], models: [] })
    const bare = renderRow().row
    ok(flattenText(byTestId(bare, 'v3-subagent-model')[0]) === 'deepseek/deepseek-v4.1-flash', '目录查不到时退回模型 id', flattenText(byTestId(bare, 'v3-subagent-model')[0] ?? {}))
    ok(byTestId(bare, 'v3-subagent-usage').length === 0 && collect(bare, kind('ContextGauge')).length === 0, '上下文未知时不画圆环与空的用量列')

    store({ subagents: [subagentRun({ status: 'done', endedAt: 5_000, toolCalls: 4, usage: { input: 9_000, output: 3_000 }, contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 } })], models: [] })
    const finished = renderRow().row
    const doneGauge = collect(finished, kind('ContextGauge'))[0]
    ok(doneGauge?.props.usage.percent === 10 && byTestId(finished, 'v3-subagent-usage').length === 0, '完成后与运行中同样显示上下文圆环', doneGauge?.props.usage)
    ok(String(finished.props.title).includes('4 个工具 · 12k tokens'), '完成后的工具数与 tokens 放进行的悬停说明', finished.props.title)

    store({ subagents: [subagentRun({ status: 'error', endedAt: 4_000, error: '模型请求超时\n详细堆栈', toolCalls: 2 })], models: [] })
    const failed = renderRow().row
    const usage = byTestId(failed, 'v3-subagent-usage')[0]
    ok(failed.props['data-state'] === 'failed' && textOf(usage) === '模型请求超时', '失败行用量列是原因摘要（第一行）', textOf(usage))
    ok(usage.props.title === '模型请求超时\n详细堆栈', '悬停看完整原因', usage.props.title)
  }

  group('SubagentLine：多个子 Agent 是对齐的分组列表')
  {
    resetPanes()
    resetExpansion()
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const statuses = ['done', 'running', 'error', 'starting', 'done', 'running', 'cancelled']
    const many = statuses.map((status, i) => subagentRun({ id: 'sub-' + i, startedAt: 1000 + i, status, endedAt: status === 'running' || status === 'starting' ? undefined : 5000 + i, toolCalls: i }))
    lib.useRunsV3.setState({ runs: [runSnapshot({ runId: 'sub-5', phase: { kind: 'needs-you', since: 2_000, request: { id: 'r', type: 'danger', summary: 'x' } } })], revision: 4, syncing: false, error: null, buffer: [] })
    const phases = { 'sub-5': 'needs-you' }
    ok(bundle.orderSubagentRuns(many, phases).map((run) => run.id).join() === 'sub-2,sub-1,sub-3,sub-5,sub-0,sub-4,sub-6', '排序：失败 → 运行中 → 等待（启动中、需处理）→ 已结束，同组按创建顺序', bundle.orderSubagentRuns(many, phases).map((run) => run.id).join())
    ok(bundle.orderSubagentRuns(many).map((run) => run.id).join() === 'sub-2,sub-1,sub-5,sub-3,sub-0,sub-4,sub-6', '没有快照时运行中的按创建顺序排在等待之前')
    ok(bundle.subagentListRank({ status: 'error', dismissedAt: 9 }) === 3, '已忽略的失败不置顶')

    rt.cells = []
    store({ subagents: many, models: [] })
    const line = rt.render(bundle.SubagentLine, { turn })
    ok(line.props['data-layout'] === 'list', '有运行中的项时默认展开成列表', line.props['data-layout'])
    ok(rowsOf(line).map((el) => el.props.run.id).join() === 'sub-2,sub-1,sub-3,sub-5,sub-0', '超过 5 行只显示前 5 行', rowsOf(line).map((el) => el.props.run.id).join())
    const more = byTestId(line, 'v3-subagents-more')[0]
    ok(textOf(more) === 'subagentShowMore' && more.type.__stub === 'ui-button', '其余折叠为「再显示 N 个」按钮')
    ok(bundle.subagentListSlice(bundle.orderSubagentRuns(many), false, null).hidden === 2, '「再显示」的数目是被折叠的行数')
    const sum = byTestId(line, 'v3-subagents-sum')[0]
    ok(textOf(sum) === 'subagentCount · subagentLiveCount · subagentFailedCount · subagentDoneCount · subagentStoppedCount', '组头写总数与各状态计数', textOf(sum))
    ok(sum.props['aria-expanded'] === true && sum.props.trailingIcon && sum.props['data-failed'] === '1', '组头是可折叠按钮，有失败时带失败标记')
    ok(byTestId(line, 'v3-subagents-progress').length === 1, '有运行中的项时显示进度条')
    ok(['v3-subagent-deck', 'v3-subagent-slot', 'v3-subagent-strip', 'v3-subagent-dots', 'v3-subagent-pos', 'v3-subagent-nav'].every((id) => byTestId(line, id).length === 0), '没有卡组、翻张、点点分页与滚轮提示')
    const list = byTestId(line, 'v3-subagent-list')[0]
    ok(list.props.role === 'group' && typeof list.props.onKeyDown === 'function' && list.props.tabIndex === undefined, '列表不是焦点停靠点，只处理行间方向键')
    ok(lib.useSubagentGroups.getState().byRun['sub-2']?.join() === 'sub-2,sub-1,sub-3,sub-5,sub-0,sub-4,sub-6', '列表顺序发布给转录窗格做上一个 / 下一个', lib.useSubagentGroups.getState().byRun['sub-2'])

    more.props.onPress()
    const all = rt.render(bundle.SubagentLine, { turn })
    ok(rowsOf(all).length === 7 && textOf(byTestId(all, 'v3-subagents-more')[0]) === 'subagentShowLess', '展开后显示全部，按钮变「收起」')
    rt.cells = []
    ok(rowsOf(rt.render(bundle.SubagentLine, { turn })).length === 7, '展开状态存在展开存储里，重新挂载后保持')
    byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagents-more')[0].props.onPress()
    ok(rowsOf(rt.render(bundle.SubagentLine, { turn })).length === 5, '收起后回到前 5 行')

    lib.useUiV3.setState({ workspaceOpen: true, workspaceTab: 'subagent:sub-6', workspacePanes: ['subagent:sub-6'] })
    ok(rowsOf(rt.render(bundle.SubagentLine, { turn })).length === 7, '选中的行被折叠时整组展开，选中项不藏起来')
    resetPanes()

    byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagents-sum')[0].props.onPress()
    const folded = rt.render(bundle.SubagentLine, { turn })
    ok(folded.props['data-layout'] === 'summary' && byTestId(folded, 'v3-subagent-list').length === 0, '运行中也能手动收成一行')
    byTestId(folded, 'v3-subagents-sum')[0].props.onPress()

    const ended = many.map((run, i) => ({ ...run, status: i === 2 ? 'error' : 'done', endedAt: 5000 + i, usage: { input: 1000 } }))
    lib.useRunsV3.setState({ runs: [], revision: 5, syncing: false, error: null, buffer: [] })
    resetExpansion()
    rt.cells = []
    store({ subagents: ended, models: [] })
    const summary = rt.render(bundle.SubagentLine, { turn })
    const sumText = textOf(byTestId(summary, 'v3-subagents-sum')[0])
    ok(summary.props['data-layout'] === 'summary' && rowsOf(summary).length === 0, '全部结束后自动收成一行摘要')
    ok(sumText === 'subagentCount · subagentFailedCount · subagentDoneCount · 21 个工具 · 7.0k tokens · 4s', '摘要写计数（含失败）、工具、tokens、整组用时', sumText)
    ok(byTestId(summary, 'v3-subagents-progress').length === 0, '结束后不显示进度条')
    byTestId(summary, 'v3-subagents-sum')[0].props.onPress()
    rt.cells = []
    const reopened = rt.render(bundle.SubagentLine, { turn })
    ok(reopened.props['data-layout'] === 'list' && rowsOf(reopened).length === 5, '点击摘要展开，用户展开过的状态保持', reopened.props['data-layout'])

    resetExpansion()
    rt.cells = []
    store({ subagents: ended.map((run) => ({ ...run, status: 'done' })), models: [] })
    const clean = textOf(byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagents-sum')[0])
    ok(clean.startsWith('subagentCount · subagentAllDone · '), '没有失败时摘要写「全部完成」', clean)
    ok(byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagents-sum')[0].props.trailingIcon === undefined, '没有失败时不带失败标记')

    resetExpansion()
    rt.cells = []
    store({ subagents: [ended[0]], models: [] })
    ok(rt.render(bundle.SubagentLine, { turn }).props['data-layout'] === 'single', '单个已结束的子 Agent 仍是一行，不收成摘要')
  }

  group('子 Agent 列表：键盘、标题与转录窗格切换')
  {
    ok(bundle.subagentTitle('用联网搜索找「体育」领域最近 3 天的新闻：先运行 yan search query') === '用联网搜索找「体育」领域最近 3 天的新闻', '中文冒号前作短标题')
    const pathTask = 'Fix C:\\repo\\a.ts now'
    ok(bundle.subagentTitle(pathTask) === pathTask, '路径里的冒号不截断', bundle.subagentTitle(pathTask))
    ok(bundle.subagentTitle('修：x') === '修：x', '冒号前太短时保留整句')
    ok(bundle.subagentRowFocusTarget('ArrowDown', 0, 3) === 1 && bundle.subagentRowFocusTarget('ArrowUp', 2, 3) === 1 && bundle.subagentRowFocusTarget('Home', 2, 3) === 0 && bundle.subagentRowFocusTarget('End', 0, 3) === 2, '↑↓ / Home / End 在行间移动焦点')
    ok(bundle.subagentRowFocusTarget('ArrowUp', 0, 3) === null && bundle.subagentRowFocusTarget('ArrowDown', 2, 3) === null && bundle.subagentRowFocusTarget('Enter', 1, 3) === null && bundle.subagentRowFocusTarget('Tab', 1, 3) === null, '边界与 Enter / Tab 不拦截')
    ok(bundle.subagentNeighbor(['a', 'b', 'c'], 'b', -1) === 'a' && bundle.subagentNeighbor(['a', 'b', 'c'], 'b', 1) === 'c' && bundle.subagentNeighbor(['a', 'b'], 'a', -1) === null && bundle.subagentNeighbor(['a'], 'x', 1) === null, '上一个 / 下一个按列表顺序，到头为空')
    const sib = [
      subagentRun({ id: 's1', parentRunId: 'r1', parentMessageId: 'm1' }),
      subagentRun({ id: 's2', parentRunId: 'r1', parentMessageId: 'm2' }),
      subagentRun({ id: 's3', parentRunId: 'r2', parentMessageId: 'm1' }),
      subagentRun({ id: 's4', parentRunId: 'r1', review: 'merged' })
    ]
    ok(bundle.subagentSiblings(sib, sib[0]).map((run) => run.id).join() === 's1,s2', '列表没挂载时按同一次父运行找同组子 Agent', bundle.subagentSiblings(sib, sib[0]).map((run) => run.id).join())

    const layout = lib.columnLayout(['files', 'subagent:s1', 'context'])
    const swapped = bundle.swapLayoutTiles(layout, 'subagent:s1', 'subagent:s2')
    ok(lib.orderedTileIds(swapped).join() === 'files,subagent:s2,context', '交换磁贴 id 保留位置')
    lib.useUiV3.setState({ workspaceOpen: true, workspaceTab: 'subagent:s1', workspacePanes: ['files', 'subagent:s1', 'context'], workspaceLayout: layout })
    bundle.switchSubagentPane('s1', 's2')
    const ui = lib.useUiV3.getState()
    ok(ui.workspacePanes.join() === 'files,subagent:s2,context' && ui.workspaceTab === 'subagent:s2' && lib.orderedTileIds(ui.workspaceLayout).filter((id) => id !== 'chat').join() === 'files,subagent:s2,context', '窗格切换在原位换成另一个子 Agent，不新增磁贴', { panes: ui.workspacePanes, tab: ui.workspaceTab })
    lib.useUiV3.setState({ workspacePanes: ['subagent:s2', 'subagent:s3'], workspaceTab: 'subagent:s2', workspaceLayout: lib.columnLayout(['subagent:s2', 'subagent:s3']) })
    bundle.switchSubagentPane('s2', 's3')
    ok(lib.useUiV3.getState().workspacePanes.join() === 'subagent:s2,subagent:s3' && lib.useUiV3.getState().workspaceTab === 'subagent:s3', '目标已打开时只切换焦点')
    resetPanes()
  }

  group('SubagentLine：未激活视图（peek 别的会话）不显示别的会话的子 Agent')
  {
    lib.useRunsV3.setState({ runs: [], revision: 2, syncing: false, error: null, buffer: [] })
    store({
      subagents: [subagentRun({ parentSessionId: 'sess-a' })],
      session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' },
      peekedSessionId: 'sess-b',
      peekedPath: 'B'
    })
    const line = rt.render(bundle.SubagentLine, { turn: { kind: 'assistant', id: 'a1', sourceIds: ['a1'] } })
    ok(line === null || byTestId(line, 'v3-subagents').length === 0, '看 B 时不显示挂在 A 上的子 Agent')
  }

  group('ErrorCard：动作只在当前视图可用时出现')
  {
    store({ messages: [{ id: 'u1', role: 'user', text: '跑一下' }, { id: 'a2', role: 'assistant', text: 'x' }] })
    const active = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('429 rate limit exceeded') })
    ok(textOf(byTestId(active, 'v3-error-title')[0]) === 'errorTitleQuotaRate', '额度限流有类别标题', textOf(byTestId(active, 'v3-error-title')[0]))
    ok(byTestId(active, 'v3-error-retry').length === 1, '能定位提示时给重试')
    ok(byTestId(active, 'v3-error-model').length === 1, '限流也给换模型')
    const fold = byTestId(active, 'v3-error-toggle')[0]
    ok(!!fold && fold.props['aria-expanded'] === false, '原始错误默认折叠在「查看详情」里')
    ok(byTestId(active, 'v3-error-body').length === 0, '折叠时不渲染正文')
    fold.props.onPress()
    const opened = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('429 rate limit exceeded') })
    ok(flattenText(byTestId(opened, 'v3-error-body')[0]).includes('原因：'), '展开后正文含脱敏原因')
    ok(byTestId(opened, 'v3-error-copy').length === 1, '展开后可复制详情')

    const auth = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('401 unauthorized') })
    ok(byTestId(auth, 'v3-error-retry').length === 0 && byTestId(auth, 'v3-error-model').length === 1, '认证失败不给重试，只给换模型')

    const aborted = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('Request aborted by user') })
    ok(byTestId(aborted, 'v3-error-retry').length === 0 && byTestId(aborted, 'v3-error-model').length === 0 && byTestId(aborted, 'v3-error-compact').length === 0, '取消不给任何动作按钮')

    store({
      messages: [{ id: 'u1', role: 'user', text: '跑一下' }, { id: 'a2', role: 'assistant', text: 'x' }],
      session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' },
      peekedSessionId: 'sess-b',
      peekedPath: 'B'
    })
    const inactive = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('429 rate limit exceeded') })
    ok(byTestId(inactive, 'v3-error-retry').length === 0 && byTestId(inactive, 'v3-error-model').length === 0, '未激活视图不提供任何动作（不操作别的会话）')
    ok(textOf(byTestId(inactive, 'v3-error-title')[0]) === 'errorTitleQuotaRate', '未激活视图仍如实显示原因')
  }

  group('压缩标记 / 分支摘要：复用现有投影，只读显示')
  {
    store({
      session: {
        sessionId: 'sess-a',
        conversationId: 'sess-a',
        sessionFile: 'A',
        lastCompaction: { status: 'completed', reason: 'threshold', beforeTokens: 150_000, afterTokens: 32_000, afterMeasured: true }
      }
    })
    const marker = rt.render(bundle.CompactionMarker, {})
    ok(marker && byTestId(marker, 'v3-compaction-marker').length === 1, '有压缩记录就画标记行')
    const markerText = flattenText(marker)
    ok(markerText.includes('150k → 32k'), '两端 token 都拿到时写定量结果', markerText)
    store({ session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', lastCompaction: { status: 'completed', reason: 'threshold', beforeTokens: 150_000, afterTokens: 32_000 } } })
    ok(flattenText(rt.render(bundle.CompactionMarker, {})).includes('150k → ≈32k'), '压缩后读数未实测时标为估计值')
    ok(markerText.includes('compactionTitle'), '已完成压缩带「上下文已压缩」标题', markerText)

    store({ session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', compaction: { status: 'running', reason: 'overflow' } } })
    const running = rt.render(bundle.CompactionMarker, {})
    ok(running.props['data-running'] === '1', '进行中的压缩优先显示')
    ok(rt.render(bundle.CompactCommandEcho, {}) === null, '自动压缩不显示命令气泡')
    store({ compactCommand: { sessionId: 'sess-a', text: '/compact 只留代码' }, session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', compaction: { status: 'running', reason: 'manual' } } })
    ok(flattenText(rt.render(bundle.CompactCommandEcho, {})).includes('/compact 只留代码'), '手动压缩把发出的命令显示为用户气泡')
    store({ compactCommand: null, session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', lastCompaction: { status: 'completed', reason: 'manual' } } })
    ok(flattenText(rt.render(bundle.CompactCommandEcho, {})).includes('/compact'), '重载后手动压缩仍显示 /compact')
    ok(!flattenText(running).includes('compactionTitle'), '进行中不写「已压缩」', flattenText(running))

    store({ session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' } })
    ok(rt.render(bundle.CompactionMarker, {}) === null, '没有记录就不显示（不写未发生过）')

    store({
      session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' },
      sessions: [{ id: 'sess-a', path: 'A', branchOrigin: '父会话里那句话' }]
    })
    const branch = rt.render(bundle.BranchSummary, {})
    const span = collect(branch, (el) => el.props && el.props.title === '父会话里那句话')[0]
    ok(branch && byTestId(branch, 'v3-branch-summary').length === 1 && !!span, '分叉来源按当前视图匹配后只读显示')
    ok(flattenText(span) === 'branchFrom' && span.props.title === '父会话里那句话', '分支摘要行用 branchFrom 文案并把来源放在 title', { text: flattenText(span), title: span.props.title })

    store({ session: { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A' }, sessions: [] })
    ok(rt.render(bundle.BranchSummary, {}) === null, '根会话没有来源就不显示')
  }

  process.stdout.write(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
