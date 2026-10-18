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
    `export { SubagentLine, subagentTitle, subagentStackOrder, subagentDefaultFront, subagentDeck, SUBAGENT_STRIP_MAX } from '${posix(abs('src/renderer/src/features/session/SubagentLine.tsx'))}'`,
    `export { ErrorCard } from '${posix(abs('src/renderer/src/features/session/ErrorCard.tsx'))}'`,
    `export { CompactionMarker } from '${posix(abs('src/renderer/src/features/session/CompactionMarker.tsx'))}'`,
    `export { BranchSummary } from '${posix(abs('src/renderer/src/features/session/BranchSummary.tsx'))}'`,
    `export { modelErrorNotice } from '${posix(abs('src/shared/model-errors.ts'))}'`,
    `export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'`,
    `export { useRunsV3 } from '${posix(abs('src/renderer/src/state/runs-v3.ts'))}'`,
    `export { useSubagentPanel } from '${posix(abs('src/renderer/src/features/session/subagent-panel-state.ts'))}'`
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

  group('SubagentLine：消息里一行摘要，点开右侧详情')
  {
    lib.useRunsV3.setState({ runs: [runSnapshot()], revision: 1, syncing: false, error: null, buffer: [] })
    lib.useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
    store({ subagents: [subagentRun({ status: 'done', endedAt: 5_000, result: { summary: '补齐了 PKCE 测试', summaryTruncated: false, summaryFrom: 'last-message', sources: ['src/a.ts'], artifacts: ['test/a.test.ts'], openQuestions: [], at: 5_000 } })] })
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const line = rt.render(bundle.SubagentLine, { turn })
    ok(line && byTestId(line, 'v3-subagents').length === 1, '挂在这一轮上的子 Agent 渲染出来')
    ok(byTestId(line, 'v3-subagents-sum').length === 0, '只有一条时不加汇总行')
    const rowEl = collect(line, (el) => typeof el.type === 'function' && el.type.name === 'SubagentRow')[0]
    ok(!!rowEl, '行组件存在')
    const row = rt.render(rowEl.type, rowEl.props)
    ok(row.props['data-terminal'] === '0', '运行投影仍 running：行标记为非终态', row.props['data-terminal'])
    ok(textOf(byTestId(row, 'v3-subagent-status')[0]) === '运行中', '状态词来自运行投影阶段', textOf(byTestId(row, 'v3-subagent-status')[0]))
    ok(textOf(byTestId(row, 'v3-subagent-code')[0]) === 'S12·1', '显示编号', textOf(byTestId(row, 'v3-subagent-code')[0]))
    ok(byTestId(row, 'v3-subagent-open').length === 0, '分屏入口不挤在消息行里')
    ok(byTestId(row, 'v3-subagent-model').length === 0 && collect(row, (el) => el.props?.className === 'v3-subagent-kind').length === 1, '没有模型时元信息行仍写「子代理」')
    ok(byTestId(row, 'v3-subagent-summary').length === 0, '摘要不在消息流里展开')

    const toggle = byTestId(row, 'v3-subagent-toggle')[0]
    ok(toggle && toggle.props['aria-haspopup'] === 'dialog', '整行是打开详情的按钮')
    toggle.props.onClick({ currentTarget: null })
    const panel = lib.useSubagentPanel.getState()
    ok(panel.runId === 'sub-1' && panel.owner === rowEl.props.owner, '点击后详情面板指向这条运行与当前视图', { runId: panel.runId, owner: panel.owner })
    toggle.props.onClick({ currentTarget: null })
    ok(lib.useSubagentPanel.getState().runId === null, '再点一次收起')
  }

  group('SubagentLine：模型显示名、思考档位与上下文圆环')
  {
    lib.useRunsV3.setState({ runs: [], revision: 3, syncing: false, error: null, buffer: [] })
    lib.useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const renderRow = () => {
      const line = rt.render(bundle.SubagentLine, { turn })
      const rowEl = collect(line, (el) => typeof el.type === 'function' && el.type.name === 'SubagentRow')[0]
      return rt.render(rowEl.type, rowEl.props)
    }
    const flash = 'commandcode/deepseek/deepseek-v4.1-flash'
    store({
      subagents: [subagentRun({
        model: flash,
        thinkingLevel: 'medium',
        contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20, availability: 'known', estimated: false }
      })],
      models: [{ provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
    })
    const row = renderRow()
    const name = byTestId(row, 'v3-subagent-model')[0]
    ok(textOf(name) === 'DeepSeek V4.1 Flash', '元信息行开头用模型菜单名', name && textOf(name))
    ok(name?.props.title === flash, '悬停保留完整模型身份', name?.props.title)
    ok(collect(row, (el) => el.props?.className === 'v3-subagent-kind').length === 0, '有模型时不再写「子代理」')
    const think = byTestId(row, 'v3-subagent-thinking')[0]
    ok(think?.props.level === 'medium', '模型后跟思考档位短标签', think?.props.level)
    const ctx = byTestId(row, 'v3-subagent-context')[0]
    ok(!!ctx && Math.round(ctx.props.usage.percent) === 20 && ctx.props.usage.tokens === 40_000 && ctx.props.usage.windowSize === 200_000, '行尾圆环取子代理自己的上下文用量', ctx?.props.usage)
    ok(byTestId(row, 'v3-subagent-status').length === 1 && byTestId(row, 'v3-subagent-time').length === 1, '状态与用时仍保留')

    store({
      subagents: [subagentRun({ model: flash, thinkingLevel: 'off', contextUsage: { tokens: 40_000, contextWindow: 0, percent: null } })],
      models: []
    })
    const bare = renderRow()
    ok(textOf(byTestId(bare, 'v3-subagent-model')[0]) === 'deepseek/deepseek-v4.1-flash', '目录查不到时退回模型 id', textOf(byTestId(bare, 'v3-subagent-model')[0] ?? {}))
    ok(byTestId(bare, 'v3-subagent-thinking').length === 0, '思考档位为 off 时不显示')
    ok(byTestId(bare, 'v3-subagent-context').length === 0, '上下文窗口未知时不画圆环')
  }

  group('SubagentLine：多开时堆叠，标题取第一句')
  {
    ok(bundle.subagentTitle('用联网搜索找「体育」领域最近 3 天的新闻：先运行 yan search query') === '用联网搜索找「体育」领域最近 3 天的新闻', '中文冒号前作短标题')
    const pathTask = 'Fix C:\\repo\\a.ts now'
    ok(bundle.subagentTitle(pathTask) === pathTask, '路径里的冒号不截断', bundle.subagentTitle(pathTask))
    ok(bundle.subagentTitle('修：x') === '修：x', '冒号前太短时保留整句')
    lib.useRunsV3.setState({ runs: [], revision: 4, syncing: false, error: null, buffer: [] })
    lib.useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
    const turn = { kind: 'assistant', id: 'a1', sourceIds: ['a1'] }
    const kind = (name) => (el) => typeof el.type === 'function' && el.type.name === name
    const mk = (n) => Array.from({ length: n }, (_, i) => subagentRun({ id: 'sub-' + i, startedAt: 1000 + i, status: i < 2 ? 'done' : 'running', endedAt: i < 2 ? 5000 + i : undefined }))
    const many = mk(6)
    store({ subagents: many, models: [] })
    const line = rt.render(bundle.SubagentLine, { turn })
    const strips = collect(line, kind('SubagentStrip'))
    const fronts = collect(line, kind('SubagentRow'))
    ok(fronts.length === 1 && fronts[0].props.front === true, '多个子代理时只有一张完整卡片，在最前面', fronts.length)
    ok(strips.length === 5 && byTestId(line, 'v3-subagents-more').length === 0, '6 个时 1 张完整卡片 + 5 条标题条，没有「另外 N 个」', strips.length)
    ok(fronts[0].props.run.id === 'sub-5', '默认最前：正在运行的里最新启动的', fronts[0].props.run.id)
    ok(strips.map((el) => el.props.run.id).join() === 'sub-4,sub-3,sub-2,sub-1,sub-0', '露标题的卡片压在完整卡片下面，离得近的是最近启动的', strips.map((el) => el.props.run.id))
    ok(strips.map((el) => el.props.depth).join() === '1,2,3,3,3', '越往下层级越深，最深封顶 3', strips.map((el) => el.props.depth))
    ok(strips.map((el) => el.props.layer).join() === '6,5,4,3,2', '越往下叠放层级越低，被上一张压住', strips.map((el) => el.props.layer))
    ok(byTestId(line, 'v3-subagents-legend').length === 1 && textOf(byTestId(line, 'v3-subagents-sum')[0]) === 'subagentCount', '组头只写总数，进行中与失败放进图例', textOf(byTestId(line, 'v3-subagents-sum')[0]))
    ok(byTestId(line, 'v3-subagents-progress').length === 1 && byTestId(line, 'v3-subagents-sum').length === 1, '组头与进度条保留')
    ok(byTestId(line, 'v3-subagent-stack').length === 0 && byTestId(line, 'v3-subagent-pile').length === 0, '没有组内滚动窗口与旧叠层')
    const deckEl = byTestId(line, 'v3-subagent-deck')[0]
    ok(deckEl?.props.role === 'group' && typeof deckEl.props.onKeyDown === 'function', '叠层是带键盘导航的分组')

    const stripRender = rt.render(strips[0].type, strips[0].props)
    ok(stripRender.type === 'button' && stripRender.props.type === 'button' && stripRender.props['data-nav'] === '1', '标题条是可聚焦按钮')
    ok(byTestId(stripRender, 'v3-subagent-task').length === 1 && byTestId(stripRender, 'v3-subagent-status').length === 1 && byTestId(stripRender, 'v3-subagent-time').length === 1 && byTestId(stripRender, 'v3-subagent-dot').length === 1, '标题条含角标状态点、标题、状态、用时')
    const stripBots = collect(stripRender, kind('SubagentBot'))
    ok(stripBots.length === 1 && stripBots[0].props.size === 22 && stripBots[0].props.run.id === strips[0].props.run.id, '标题条左侧是该子代理的 Bot（22px），状态点退为角标', stripBots.map((el) => el.props.size))
    ok(byTestId(stripRender, 'v3-subagent-tokens').length === 0 && typeof stripRender.props['aria-label'] === 'string' && stripRender.props['data-tone'] === 'run', '标题条不放 token，读屏标签含状态，状态靠圆点色调', stripRender.props['data-tone'])
    const frontRender = rt.render(fronts[0].type, fronts[0].props)
    ok(frontRender.props['data-front'] === '1' && byTestId(frontRender, 'v3-subagent-toggle')[0].props['data-nav'] === '1', '完整卡片标记为最前并参与键盘导航')

    rt.cells = []
    const fresh = rt.render(bundle.SubagentLine, { turn })
    collect(fresh, kind('SubagentStrip'))[2].props.onPick()
    const picked = rt.render(bundle.SubagentLine, { turn })
    const pickedFront = collect(picked, kind('SubagentRow'))[0]
    ok(pickedFront.props.run.id === 'sub-2' && pickedFront.props.lift === true, '点标题条把它置到最前并带过渡标记', pickedFront.props.run.id)
    ok(collect(picked, kind('SubagentStrip')).map((el) => el.props.run.id).join() === 'sub-5,sub-4,sub-3,sub-1,sub-0', '原来的最前回到按启动先后排定的位置，其余顺序不变')
    lib.useSubagentPanel.setState({ runId: 'sub-4', owner: fronts[0].props.owner, returnFocus: null })
    const bySelected = rt.render(bundle.SubagentLine, { turn })
    const selectedFront = collect(bySelected, kind('SubagentRow'))[0]
    ok(selectedFront.props.run.id === 'sub-4' && selectedFront.props.lift !== true, '当前选中的卡片优先成为最前', selectedFront.props.run.id)
    lib.useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })

    ok(bundle.subagentDefaultFront(mk(3).map((run) => ({ ...run, status: 'done', endedAt: 9000 })), null) === 'sub-2', '没有运行中的：最近启动的在最前')
    ok(bundle.subagentDefaultFront(many, 'sub-1') === 'sub-1' && bundle.subagentDefaultFront(many, 'nope') === 'sub-5', '选中项在本组才优先，否则忽略')
    const withError = many.map((run) => (run.id === 'sub-1' ? { ...run, status: 'error', endedAt: 9000 } : run))
    ok(bundle.subagentStackOrder(withError)[0].id === 'sub-1', '出错的插到最前面', bundle.subagentStackOrder(withError).map((run) => run.id))
    ok(bundle.subagentStackOrder(many).map((run) => run.id).join() === 'sub-5,sub-4,sub-3,sub-2,sub-1,sub-0', '其余按启动时间新到旧')

    const nine = mk(9)
    ok(bundle.SUBAGENT_STRIP_MAX === 6, '标题条最多露 6 条')
    const deck9 = bundle.subagentDeck(nine, 'sub-8')
    ok(deck9.front.id === 'sub-8' && deck9.strips.length === 6 && deck9.hidden === 2, '9 个：1 张完整 + 6 条标题条 + 另外 2 个', { strips: deck9.strips.length, hidden: deck9.hidden })
    ok(deck9.strips.map((run) => run.id).join() === 'sub-7,sub-6,sub-5,sub-4,sub-3,sub-2', '超出时优先留下最近的，从近到远排列', deck9.strips.map((run) => run.id))
    const deck9Err = bundle.subagentDeck(nine.map((run) => (run.id === 'sub-0' ? { ...run, status: 'error', endedAt: 9000 } : run)), 'sub-8')
    ok(deck9Err.strips[0].id === 'sub-0', '超出时出错的优先留下', deck9Err.strips.map((run) => run.id))

    rt.cells = []
    store({ subagents: nine, models: [] })
    const overflow = rt.render(bundle.SubagentLine, { turn })
    const more = byTestId(overflow, 'v3-subagents-more')[0]
    const moreLabel = more && collect(more, (el) => el.props?.className === 'v3-sa-strip-task')[0]
    ok(collect(overflow, kind('SubagentStrip')).length === 6 && !!moreLabel && textOf(moreLabel) === 'subagentMoreRuns', '9 个时露 6 条标题条与一条「另外 N 个」')
    more.props.onClick()
    const flat = rt.render(bundle.SubagentLine, { turn })
    ok(collect(flat, kind('SubagentRow')).length === 9 && collect(flat, kind('SubagentStrip')).length === 0, '点开后整组平铺成完整卡片')
    ok(collect(flat, kind('SubagentRow')).every((el) => !el.props.front), '平铺时没有层叠标记')
    const less = byTestId(flat, 'v3-subagents-more')[0]
    ok(textOf(less) === 'subagentShowLess', '平铺时按钮是「收起」', textOf(less))
    less.props.onPress()
    const back = rt.render(bundle.SubagentLine, { turn })
    ok(collect(back, kind('SubagentRow')).length === 1 && collect(back, kind('SubagentStrip')).length === 6, '收起后回到层叠')

    rt.cells = []
    store({ subagents: many.slice(0, 1), models: [] })
    const one = rt.render(bundle.SubagentLine, { turn })
    ok(collect(one, kind('SubagentRow')).length === 1 && collect(one, kind('SubagentStrip')).length === 0 && byTestId(one, 'v3-subagent-deck').length === 0, '单个子代理就是一张完整卡片，没有层叠')
    ok(byTestId(one, 'v3-subagents-sum').length === 0 && byTestId(one, 'v3-subagents-progress').length === 0, '单个时没有组头与进度条')
    store({ subagents: many.slice(0, 2), models: [] })
    const two = rt.render(bundle.SubagentLine, { turn })
    ok(collect(two, kind('SubagentStrip')).length === 1 && collect(two, kind('SubagentRow')).length === 1, '两个：一条标题条 + 一张完整卡片')
    lib.useSubagentPanel.setState({ runId: null, owner: null, returnFocus: null })
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
