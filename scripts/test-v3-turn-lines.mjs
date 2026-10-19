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
    `export { SubagentLine, subagentTitle, subagentDeckOrder, subagentDefaultFront } from '${posix(abs('src/renderer/src/features/session/SubagentLine.tsx'))}'`,
    `export { DECK_WHEEL, createDeckWheelState, deckWheelDelta, deckWheelStep, deckKeyTarget, deckTouchStep, deckStripDepth, deckVisible } from '${posix(abs('src/renderer/src/features/session/subagent-deck.ts'))}'`,
    `export { ErrorCard } from '${posix(abs('src/renderer/src/features/session/ErrorCard.tsx'))}'`,
    `export { CompactionMarker } from '${posix(abs('src/renderer/src/features/session/CompactionMarker.tsx'))}'`,
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

  group('SubagentLine：消息里一张 26px 卡片，点开右侧转录窗格')
  {
    lib.useRunsV3.setState({ runs: [runSnapshot()], revision: 1, syncing: false, error: null, buffer: [] })
    resetPanes()
    store({ subagents: [subagentRun({ status: 'done', endedAt: 5_000, toolCalls: 4, result: { summary: '补齐了 PKCE 测试', summaryTruncated: false, summaryFrom: 'last-message', sources: ['src/a.ts'], artifacts: ['test/a.test.ts'], openQuestions: [], at: 5_000 } })] })
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const line = rt.render(bundle.SubagentLine, { turn })
    ok(line && byTestId(line, 'v3-subagents').length === 1, '挂在这一轮上的子 Agent 渲染出来')
    ok(byTestId(line, 'v3-subagents-sum').length === 0, '只有一条时不加汇总行')
    ok(byTestId(line, 'v3-subagents-live').length === 0, '没有运行中的任务时不写「N 个任务正在运行」')
    const rowEl = collect(line, (el) => typeof el.type === 'function' && el.type.name === 'SubagentRow')[0]
    ok(!!rowEl, '行组件存在')
    const row = rt.render(rowEl.type, rowEl.props)
    ok(row.props['data-terminal'] === '0', '运行投影仍 running：行标记为非终态', row.props['data-terminal'])
    ok(row.props['data-state'] === 'done', '行状态取自任务行（subagent-task-rows）', row.props['data-state'])
    const stateIcon = collect(row, (el) => typeof el.type === 'function' && el.type.name === 'SubagentStateIcon')[0]
    ok(stateIcon?.props.state === 'done', '状态用小图标表示', stateIcon?.props.state)
    const task = textOf(byTestId(row, 'v3-subagent-task')[0])
    ok(task.includes('PKCE') && task !== subagentRun().task, '标题是任务行带时态的状态文字', task)
    ok(textOf(byTestId(row, 'v3-subagent-time')[0]).startsWith('4 个工具'), '结束后元信息是任务行摘要（工具数、用时）', textOf(byTestId(row, 'v3-subagent-time')[0]))
    const bots = collect(row, (el) => typeof el.type === 'function' && el.type.name === 'SubagentBot')
    ok(bots.length === 1 && bots[0].props.size === 20, '卡片 Bot 为 20px', bots.map((el) => el.props.size))
    ok(byTestId(row, 'v3-subagent-model').length === 0, '没有模型时不写模型名')
    ok(byTestId(row, 'v3-subagent-summary').length === 0, '摘要不在消息流里展开')

    const toggle = byTestId(row, 'v3-subagent-toggle')[0]
    ok(toggle && toggle.props['aria-pressed'] === false, '整行是打开转录窗格的按钮，未打开时不按下', toggle?.props['aria-pressed'])
    toggle.props.onClick()
    const ui = lib.useUiV3.getState()
    ok(ui.workspaceOpen === true && ui.workspaceTab === 'subagent:sub-1' && ui.workspacePanes.includes('subagent:sub-1'), '点击后右侧工作区打开 subagent:<runId> 窗格并聚焦', { open: ui.workspaceOpen, tab: ui.workspaceTab, panes: ui.workspacePanes })
    const pressed = byTestId(rt.render(rowEl.type, rowEl.props), 'v3-subagent-toggle')[0]
    ok(pressed.props['aria-pressed'] === true, '窗格打开时卡片显示为选中')
    toggle.props.onClick()
    ok(lib.useUiV3.getState().workspacePanes.filter((id) => id === 'subagent:sub-1').length === 1, '再点不会重复开窗格')
    resetPanes()
  }

  group('SubagentLine：运行中写「N 个任务正在运行」，模型名来自目录')
  {
    lib.useRunsV3.setState({ runs: [], revision: 3, syncing: false, error: null, buffer: [] })
    resetPanes()
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const renderRow = () => {
      const line = rt.render(bundle.SubagentLine, { turn })
      const rowEl = collect(line, (el) => typeof el.type === 'function' && el.type.name === 'SubagentRow')[0]
      return { line, row: rt.render(rowEl.type, rowEl.props) }
    }
    const flash = 'commandcode/deepseek/deepseek-v4.1-flash'
    store({
      subagents: [subagentRun({ model: flash, thinkingLevel: 'medium' })],
      models: [{ provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
    })
    const { line, row } = renderRow()
    ok(textOf(collect(byTestId(line, 'v3-subagents-live')[0], (el) => el.type === 'span')[0]) === 'subagentRunningTasks', '有运行中的任务时写「N 个任务正在运行」')
    const name = byTestId(row, 'v3-subagent-model')[0]
    ok(textOf(name) === 'DeepSeek V4.1 Flash', '模型用菜单名', name && textOf(name))
    ok(name?.props.title === flash, '悬停保留完整模型身份', name?.props.title)
    const stateIcon = collect(row, (el) => typeof el.type === 'function' && el.type.name === 'SubagentStateIcon')[0]
    ok(stateIcon?.props.state === 'running', '运行中的状态图标', stateIcon?.props.state)
    ok(byTestId(row, 'v3-subagent-time').length === 1, '运行中显示用时')

    store({ subagents: [subagentRun({ model: flash })], models: [] })
    const bare = renderRow().row
    ok(textOf(byTestId(bare, 'v3-subagent-model')[0]) === 'deepseek/deepseek-v4.1-flash', '目录查不到时退回模型 id', textOf(byTestId(bare, 'v3-subagent-model')[0] ?? {}))
  }

  group('SubagentLine：多开时翻叠，标题取第一句')
  {
    ok(bundle.subagentTitle('用联网搜索找「体育」领域最近 3 天的新闻：先运行 yan search query') === '用联网搜索找「体育」领域最近 3 天的新闻', '中文冒号前作短标题')
    const pathTask = 'Fix C:\\repo\\a.ts now'
    ok(bundle.subagentTitle(pathTask) === pathTask, '路径里的冒号不截断', bundle.subagentTitle(pathTask))
    ok(bundle.subagentTitle('修：x') === '修：x', '冒号前太短时保留整句')
    lib.useRunsV3.setState({ runs: [], revision: 4, syncing: false, error: null, buffer: [] })
    resetPanes()
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const kind = (name) => (el) => typeof el.type === 'function' && el.type.name === name
    const mk = (n) => Array.from({ length: n }, (_, i) => subagentRun({ id: 'sub-' + i, startedAt: 1000 + i, status: i < 2 ? 'done' : 'running', endedAt: i < 2 ? 5000 + i : undefined }))
    const isolated = (el) => {
      const saved = rt.cells
      rt.cells = []
      const out = rt.render(el.type, el.props)
      rt.cells = saved
      return out
    }
    const slotsOf = (line) => byTestId(line, 'v3-subagent-slot')
    const slotKeys = (line) => slotsOf(line).map((el) => el.props['data-slot']).join()
    const stripsOf = (line) => collect(line, kind('SubagentStrip'))
    const rowsOf = (line) => collect(line, kind('SubagentRow'))
    const front = (line) => rowsOf(line).find((el) => el.props.front === true)
    const press = (line, key) => {
      const deckEl = byTestId(line, 'v3-subagent-deck')[0]
      const event = { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: 'inner', currentTarget: 'deck', prevented: false, preventDefault() { this.prevented = true } }
      deckEl.props.onKeyDown(event)
      return event
    }
    const many = mk(6)
    rt.cells = []
    store({ subagents: many, models: [] })
    const line = rt.render(bundle.SubagentLine, { turn })
    const deckEl = byTestId(line, 'v3-subagent-deck')[0]
    ok(deckEl?.props.role === 'group' && deckEl.props.tabIndex === 0 && typeof deckEl.props.onKeyDown === 'function', '翻叠组可聚焦并响应键盘')
    ok(front(line).props.run.id === 'sub-5', '默认停在正在运行的里最新启动的', front(line)?.props.run.id)
    ok(bundle.subagentDeckOrder(many).map((run) => run.id).join() === 'sub-5,sub-4,sub-3,sub-2,sub-1,sub-0', '翻叠顺序按启动时间新到旧')
    ok(slotKeys(line) === '0,1,2,3,4', '停在第一张：上一张的位置空着，下面 2 条完整标题带 + 2 层叠边', slotKeys(line))
    ok(deckEl.props['data-first'] === undefined && deckEl.props['data-long'] === undefined, '第一张时不做上移补偿，位置与停在中间时一致')
    const slotEls = slotsOf(line)
    ok(slotEls.map((el) => el.props['aria-hidden'] === true).join() === 'false,false,false,true,true', '只有 2 条完整标题带对读屏可见，叠边隐藏')
    const windowEl = collect(line, (el) => el.props?.className === 'v3-sa-window')[0]
    ok(windowEl.props.style['--sa-rows'] === 3 && windowEl.props.style['--sa-edges'] === 2, '窗口高度按上一张空位 + 卡片 + 2 条标题带 + 2 层叠边计，翻张不变')
    ok(rowsOf(line).length === 2 && rowsOf(line).filter((el) => el.props.front).length === 1 && rowsOf(line).filter((el) => el.props.inert).length === 1, '只有相邻两张挂完整卡片层，当前这张可操作，其余失效')
    ok(stripsOf(line).length === 5 && byTestId(line, 'v3-subagents-more').length === 0, '标题带层随每个槽位渲染，没有「另外 N 个」')
    ok(textOf(byTestId(line, 'v3-subagent-pos')[0]) === '1 / 6' && byTestId(line, 'v3-subagent-dots')[0].props.children.length === 6, '底部位置指示：n / N 与每张一个圆点')
    ok(textOf(collect(byTestId(line, 'v3-subagent-nav')[0], (el) => el.props?.className === 'v3-sa-hint')[0]) === 'subagentDeckHint', '底部有滚轮与方向键提示')
    ok(byTestId(line, 'v3-subagents-legend').length === 0 && textOf(byTestId(line, 'v3-subagents-sum')[0]) === 'subagentCount', '组头只写总数，不再有图例', textOf(byTestId(line, 'v3-subagents-sum')[0]))
    ok(byTestId(line, 'v3-subagents-live').length === 1, '有运行中的任务时组下写「N 个任务正在运行」')
    ok(byTestId(line, 'v3-subagents-progress').length === 1 && byTestId(line, 'v3-subagents-sum').length === 1, '组头与进度条保留')
    ok(byTestId(line, 'v3-subagent-stack').length === 0 && byTestId(line, 'v3-subagent-pile').length === 0, '没有组内滚动窗口与旧叠层')

    const strips = stripsOf(line)
    const stripRender = isolated(strips[1])
    ok(stripRender.type === 'button' && stripRender.props.type === 'button' && stripRender.props['data-edge'] === 'bottom' && stripRender.props['data-depth'] === 1, '下方标题带是按钮，贴在槽位下沿，越远越深', [stripRender.props['data-edge'], stripRender.props['data-depth']])
    ok(strips.map((el) => el.props.slot).join() === '0,1,2,3,4' && strips.map((el) => isolated(el).props['data-depth']).join() === '1,1,2,3,4' && isolated(strips[3]).props['data-depth'] === 3, '越远越深')
    ok(byTestId(stripRender, 'v3-subagent-task').length === 1 && byTestId(stripRender, 'v3-subagent-time').length === 1 && collect(stripRender, kind('SubagentStateIcon')).length === 1, '标题带含状态图标、带时态的标题、用时')
    const stripBots = collect(stripRender, kind('SubagentBot'))
    ok(stripBots.length === 1 && stripBots[0].props.size === 16 && stripBots[0].props.run.id === strips[1].props.run.id, '标题带左侧是该子代理的 Bot（16px）', stripBots.map((el) => el.props.size))
    ok(byTestId(stripRender, 'v3-subagent-tokens').length === 0 && typeof stripRender.props['aria-label'] === 'string' && stripRender.props['data-tone'] === 'run' && stripRender.props.tabIndex === -1, '标题带不放 token，读屏标签含状态，状态靠圆点色调，不进 Tab 序', stripRender.props['data-tone'])
    ok(isolated(strips[0]).props.inert === true, '当前这张的标题带层失效（只作过渡）')
    const frontRender = isolated(front(line))
    ok(frontRender.props['data-front'] === '1' && byTestId(frontRender, 'v3-subagent-toggle')[0].props['data-nav'] === undefined, '完整卡片标记为最前')

    const upAtFirst = press(line, 'ArrowUp')
    ok(upAtFirst.prevented === false && press(line, 'Home').prevented === false && press(line, 'a').prevented === false, '第一张上翻 / Home / 其它键不拦截，交还页面')
    const down = press(line, 'ArrowDown')
    ok(down.prevented === true, '↓ 翻到下一张并拦截')
    const second = rt.render(bundle.SubagentLine, { turn })
    ok(front(second).props.run.id === 'sub-4' && slotKeys(second) === '-1,0,1,2,3,4', '翻到第二张：上方出现上一张，下方保持 3 条', slotKeys(second))
    const prevStrip = stripsOf(second)[0]
    const prevRender = isolated(prevStrip)
    ok(prevStrip.props.run.id === 'sub-5' && prevRender.props['data-edge'] === 'top' && prevRender.props['data-depth'] === 2 && prevRender.props.inert !== true, '上一张的标题带贴在槽位上沿，比下方第一条略暗，可点', [prevRender.props['data-edge'], prevRender.props['data-depth']])
    ok(byTestId(prevRender, 'v3-subagent-task').length === 1 && collect(prevRender, kind('SubagentStateIcon')).length === 1 && byTestId(prevRender, 'v3-subagent-time').length === 1 && collect(prevRender, kind('SubagentBot')).length === 1, '上一张标题带与下方一致：Bot、状态图标、标题、用时')
    ok(rowsOf(second).map((el) => el.props.run.id).join() === 'sub-5,sub-4,sub-3' && rowsOf(second).filter((el) => !el.props.inert).length === 1, '上一张与下一张的完整卡片层也在，等着过渡')
    ok(textOf(byTestId(second, 'v3-subagent-pos')[0]) === '2 / 6', '位置指示跟随', textOf(byTestId(second, 'v3-subagent-pos')[0]))
    ok(press(second, 'ArrowUp').prevented === true, '↑ 翻回上一张')
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-5', '回到第一张')
    press(rt.render(bundle.SubagentLine, { turn }), 'End')
    const last = rt.render(bundle.SubagentLine, { turn })
    ok(front(last).props.run.id === 'sub-0' && slotKeys(last) === '-2,-1,0', 'End 到最后一张：只剩上方两条', slotKeys(last))
    ok(press(last, 'ArrowDown').prevented === false && press(last, 'PageDown').prevented === false && press(last, 'End').prevented === false, '最后一张下翻不拦截')
    ok(press(last, 'PageUp').prevented === true && front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-1', 'PageUp 翻上一张')
    press(rt.render(bundle.SubagentLine, { turn }), 'Home')
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-5', 'Home 回到第一张')

    const base = rt.render(bundle.SubagentLine, { turn })
    stripsOf(base)[2].props.onPick()
    const clicked = rt.render(bundle.SubagentLine, { turn })
    ok(front(clicked).props.run.id === 'sub-3', '点下方标题带翻到那一张', front(clicked).props.run.id)
    stripsOf(clicked)[1].props.onPick()
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-4', '点上方标题带翻到上一张')
    byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagent-dots')[0].props.children[5].props.onClick()
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-0', '点圆点直达那一张')

    store({ subagents: [...many, subagentRun({ id: 'sub-new', startedAt: 9000 })], models: [] })
    const afterNew = rt.render(bundle.SubagentLine, { turn })
    ok(front(afterNew).props.run.id === 'sub-0' && textOf(byTestId(afterNew, 'v3-subagent-pos')[0]) === '7 / 7', '用户翻过之后新子代理出现不自动跳走', front(afterNew).props.run.id)
    rt.cells = []
    const followed = rt.render(bundle.SubagentLine, { turn })
    ok(front(followed).props.run.id === 'sub-new', '用户没翻过时跟随最新运行的那一个', front(followed).props.run.id)
    store({ subagents: many, models: [] })

    rt.cells = []
    rt.render(bundle.SubagentLine, { turn })
    lib.useUiV3.setState({ workspaceOpen: true, workspaceTab: 'subagent:sub-4', workspacePanes: ['subagent:sub-4'] })
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-4', '当前选中的卡片优先成为最前')
    resetPanes()
    ok(front(rt.render(bundle.SubagentLine, { turn })).props.run.id === 'sub-4', '关掉转录窗格后不自动弹回默认那一张')

    ok(bundle.subagentDefaultFront(mk(3).map((run) => ({ ...run, status: 'done', endedAt: 9000 })), null) === 'sub-2', '没有运行中的：最近启动的在最前')
    ok(bundle.subagentDefaultFront(many, 'sub-1') === 'sub-1' && bundle.subagentDefaultFront(many, 'nope') === 'sub-5', '选中项在本组才优先，否则忽略')

    rt.cells = []
    const fifteen = mk(15)
    store({ subagents: fifteen, models: [] })
    const long = rt.render(bundle.SubagentLine, { turn })
    ok(slotsOf(long).length === 5 && byTestId(long, 'v3-subagent-dots').length === 0 && textOf(byTestId(long, 'v3-subagent-pos')[0]) === '1 / 15', '子代理很多时只渲染窗口内的槽位，不画圆点，只留 n / N', slotsOf(long).length)
    press(long, 'End')
    const longEnd = rt.render(bundle.SubagentLine, { turn })
    ok(slotKeys(longEnd) === '-2,-1,0' && textOf(byTestId(longEnd, 'v3-subagent-pos')[0]) === '15 / 15', '很多时翻到末尾也只留窗口内的槽位', slotKeys(longEnd))

    rt.cells = []
    store({ subagents: many, models: [] })
    const toggled = rt.render(bundle.SubagentLine, { turn })
    byTestId(toggled, 'v3-subagents-sum')[0].props.onPress()
    const flat = rt.render(bundle.SubagentLine, { turn })
    ok(rowsOf(flat).length === 6 && byTestId(flat, 'v3-subagent-deck').length === 0 && rowsOf(flat).every((el) => !el.props.front && !el.props.inert), '点组头后整组平铺成完整卡片，没有翻叠与指示器')
    const less = byTestId(flat, 'v3-subagents-less')[0]
    ok(textOf(less) === 'subagentShowLess', '平铺时按钮是「收起」', textOf(less))
    less.props.onPress()
    ok(byTestId(rt.render(bundle.SubagentLine, { turn }), 'v3-subagent-deck').length === 1, '收起后回到翻叠')

    rt.cells = []
    store({ subagents: many.slice(0, 1), models: [] })
    const one = rt.render(bundle.SubagentLine, { turn })
    ok(rowsOf(one).length === 1 && stripsOf(one).length === 0 && byTestId(one, 'v3-subagent-deck').length === 0 && byTestId(one, 'v3-subagent-nav').length === 0, '单个子代理就是一张完整卡片，没有翻叠与指示器')
    ok(byTestId(one, 'v3-subagents-sum').length === 0 && byTestId(one, 'v3-subagents-progress').length === 0, '单个时没有组头与进度条')
    store({ subagents: many.slice(0, 2), models: [] })
    const two = rt.render(bundle.SubagentLine, { turn })
    ok(slotsOf(two).length === 2 && textOf(byTestId(two, 'v3-subagent-pos')[0]) === '1 / 2', '两个：一张完整卡片 + 一条标题带，带位置指示')
    resetPanes()
  }

  group('子代理翻叠：滚轮、键盘与触摸的节奏')
  {
    const W = bundle.DECK_WHEEL
    ok(W.threshold === 70 && W.lock === 260 && W.gap === 140 && W.hold === 350 && W.touch === 44, '参数与原型一致')
    const st = () => bundle.createDeckWheelState()
    const s1 = st()
    let r = bundle.deckWheelStep(s1, 30, 1000, 2, 10)
    ok(r.prevent && r.target === null, '累积不够 70 不翻，但拦截页面滚动')
    r = bundle.deckWheelStep(s1, 45, 1050, 2, 10)
    ok(r.prevent && r.target === 3, '累积够 70 翻到下一张', r)
    r = bundle.deckWheelStep(s1, 200, 1100, 3, 10)
    ok(r.prevent && r.target === null, '翻张后锁 260ms，期间事件吞掉')
    r = bundle.deckWheelStep(s1, 80, 1300, 3, 10)
    ok(r.prevent && r.target === null, '锁内的事件不累积')
    r = bundle.deckWheelStep(s1, 80, 1400, 3, 10)
    ok(r.target === 4, '锁过后再翻一张', r)
    const s2 = st()
    bundle.deckWheelStep(s2, 40, 1000, 2, 10)
    r = bundle.deckWheelStep(s2, 40, 1200, 2, 10)
    ok(r.target === null, '两次滚轮间隔超过 140ms 累积清零', r)
    const s3 = st()
    bundle.deckWheelStep(s3, 50, 1000, 2, 10)
    r = bundle.deckWheelStep(s3, -50, 1050, 2, 10)
    ok(r.target === null, '反向滚动清零累积', r)
    r = bundle.deckWheelStep(s3, -30, 1080, 2, 10)
    ok(r.target === 1, '反向累积够了向上翻', r)
    const s4 = st()
    r = bundle.deckWheelStep(s4, -120, 1000, 0, 10)
    ok(!r.prevent && r.target === null, '第一张上滚不拦截，页面继续滚')
    r = bundle.deckWheelStep(s4, 120, 1000, 9, 10)
    ok(!r.prevent && r.target === null, '最后一张下滚不拦截，页面继续滚')
    const s5 = st()
    bundle.deckWheelStep(s5, 90, 1000, 8, 10)
    r = bundle.deckWheelStep(s5, 20, 1100, 9, 10)
    ok(r.prevent && r.target === null, '刚翻进边界 350ms 内的惯性尾巴继续吞掉')
    r = bundle.deckWheelStep(s5, 20, 1700, 9, 10)
    ok(!r.prevent, '超过 350ms 之后页面接着滚')
    ok(bundle.deckWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 400) === 48 && bundle.deckWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 400) === 400, '行与页模式换算成像素')
    ok(bundle.deckWheelDelta({ deltaX: 90, deltaY: 20, deltaMode: 0 }, 400) === 0 && bundle.deckWheelDelta({ deltaX: 0, deltaY: 0, deltaMode: 0 }, 400) === 0, '横向为主的滚动不处理')
    ok(bundle.deckKeyTarget('ArrowDown', 0, 5) === 1 && bundle.deckKeyTarget('PageUp', 3, 5) === 2 && bundle.deckKeyTarget('Home', 3, 5) === 0 && bundle.deckKeyTarget('End', 3, 5) === 4, '键盘目标：↑↓ / PageUp / PageDown / Home / End')
    ok(bundle.deckKeyTarget('ArrowUp', 0, 5) === null && bundle.deckKeyTarget('Home', 0, 5) === null && bundle.deckKeyTarget('ArrowDown', 4, 5) === null && bundle.deckKeyTarget('End', 4, 5) === null && bundle.deckKeyTarget('Tab', 2, 5) === null, '边界与无关按键不处理')
    let t = bundle.deckTouchStep(400, 380, 2, 10)
    ok(t.prevent && t.target === null && t.startY === 400, '触摸竖滑不足 44px 不翻', t)
    t = bundle.deckTouchStep(400, 350, 2, 10)
    ok(t.prevent && t.target === 3 && t.startY === 350, '触摸向上滑超过 44px 翻到下一张并重置起点', t)
    t = bundle.deckTouchStep(300, 360, 2, 10)
    ok(t.target === 1, '触摸向下滑翻到上一张', t)
    t = bundle.deckTouchStep(300, 380, 0, 10)
    ok(!t.prevent && t.target === null, '触摸在第一张继续下拉不拦截')
    ok(bundle.deckStripDepth(-1) === 2 && bundle.deckStripDepth(1) === 1 && bundle.deckStripDepth(5) === 4 && bundle.deckVisible(-2) && bundle.deckVisible(4) && !bundle.deckVisible(5) && !bundle.deckVisible(-3), '槽位深度与窗口范围')
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
    ok((byTestId(active, 'v3-error-body')[0].props.children || '').includes('原因：'), '正文含脱敏原因')

    const auth = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('401 unauthorized') })
    ok(byTestId(auth, 'v3-error-retry').length === 0 && byTestId(auth, 'v3-error-model').length === 1, '认证失败不给重试，只给换模型')

    const aborted = rt.render(bundle.ErrorCard, { sourceIds: ['a2'], error: notice('aborted') })
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
