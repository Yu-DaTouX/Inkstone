#!/usr/bin/env node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const __EXTRA = {'Collapsible': 'export function Collapsible(p){ return p.children ?? null }', 'CollapsibleHeader': 'export function CollapsibleHeader(p){ return p.children ?? null }', 'CollapsiblePanel': 'export function CollapsiblePanel(p){ return p.children ?? null }', 'DiffStat': 'export function DiffStat(){ return null }', 'DialogFooter': 'export function DialogFooter(p){ return p.children ?? null }', 'FindBar': 'export function FindBar(){ return null }', 'ListRow': 'export function ListRow(p){ return p.children ?? null }', 'Spinner': 'export function Spinner(){ return null }', 'CollapsibleChevron': 'export function CollapsibleChevron(){ return null }', 'TermSpinner': 'export function TermSpinner(){ return null }', 'AsciiRule': 'export function AsciiRule(){ return null }'}
function __patch(key, src){ if (!/[\\/]ui[\\/]index\.ts$/.test(key)) return src; let out = src; for (const [n, code] of Object.entries(__EXTRA)) { if (!new RegExp('export (function|const|class) '+n+'\\b').test(out) && !new RegExp('export \\{[^}]*\\b'+n+'\\b').test(out)) out += '\n' + code } return out }
function __findHeader(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = __findHeader(item)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (typeof node.type === 'function' && /^CollapsibleHeader\d*$/.test(node.type.name)) return node
  if (node.props && 'isExpanded' in node.props) return null
  return node.props?.children !== undefined ? __findHeader(node.props.children) : null
}
function __wireCollapsibles(node) {
  if (Array.isArray(node)) {
    for (const item of node) __wireCollapsibles(item)
    return node
  }
  if (!node || typeof node !== 'object') return node
  const props = node.props
  if (props && 'isExpanded' in props && typeof props.onExpandedChange === 'function') {
    const head = __findHeader(props.children)
    if (head) {
      head.type = 'button'
      head.props = { ...head.props, 'aria-expanded': !!props.isExpanded, onClick: () => props.onExpandedChange(!props.isExpanded) }
    }
  }
  if (props?.children !== undefined) __wireCollapsibles(props.children)
  return node
}

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
  const mark = pass ? '  ✓' : '  ✗'
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${mark} ${label}${extra}\n`)
  void currentGroup
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
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    location: { href: 'http://localhost/' }
  }
}

const REACT_SHIM = `/* v3 会话视图回归的 React 浅渲染替身：状态放在 globalThis.__V3_HOOKS。 */
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

const VIRTUA_STUB = `export function VList(){ return null }
VList.__stub = 'vlist'
export const Virtualizer = VList
`

function abs(rel) {
  return normalize(resolve(ROOT, rel))
}

function makeStubPlugin(rawMap, extraResolve = {}) {
  const stubMap = new Map(Object.entries({ 'src/renderer/src/features/session/web-search/citations.tsx': 'export function WebSearchTurnProvider(p){ return p.children }\nexport function CitationLink(){ return null }\nexport function useCitation(){ return null }\nexport function useCitationIndex(){ return null }', 'src/renderer/src/features/session/web-search/SearchStep.tsx': 'export function SearchStepView(p){ return p.children }', 'src/renderer/src/ui/FileTypeIcon.tsx': 'export function FileTypeIcon(){ return null }','src/renderer/src/ui/FileCard.tsx': 'export function FileCard(){ return null }', ...rawMap }).map(([rel, src]) => [abs(rel), src]))
  const virtual = new Map(Object.entries(extraResolve))
  return {
    name: 'v3-session-view-stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (virtual.has(args.path)) return { path: `v3stub:${args.path}`, namespace: 'v3stub' }
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
        if (virtual.has(key)) return { contents: virtual.get(key), loader: 'js' }
        return { contents: __patch(key, stubMap.get(key) ?? 'export {}'), loader: 'js' }
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

async function buildOne(outdir, name, entrySource, rawStubMap, shims) {
  const entry = join(outdir, `${name}-entry.ts`)
  await writeFile(entry, entrySource)
  const out = join(outdir, `${name}-bundle.mjs`)
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    logLevel: 'silent',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    define: DEFINE,
    alias: { react: shims.react, 'react/jsx-runtime': shims.jsx, 'react/jsx-dev-runtime': shims.jsx },
    plugins: [makeStubPlugin(rawStubMap, { virtua: VIRTUA_STUB })]
  })
  return out
}

async function buildAll(outdir) {
  const reactShim = join(outdir, 'react-shim.mjs')
  const jsxShim = join(outdir, 'jsx-shim.mjs')
  await writeFile(reactShim, REACT_SHIM)
  await writeFile(jsxShim, JSX_SHIM)
  const shims = { react: reactShim, jsx: jsxShim }

  const logicOut = await buildOne(
    outdir,
    'logic',
    `export { createTurnProjector, groupIntoTurns } from '${posix(abs('src/shared/turns.ts'))}'\n`,
    {},
    shims
  )

  const viewstateOut = await buildOne(
    outdir,
    'viewstate',
    `export { sessionViewIdentity, viewMatchesProjectedSession, approvalMatchesView, sameViewPath } from '${posix(abs('src/renderer/src/features/session/view-state.ts'))}'\n`,
    {},
    shims
  )

  const sessionOut = await buildOne(
    outdir,
    'session',
    `export { SessionView } from '${posix(abs('src/renderer/src/features/session/SessionView.tsx'))}'
export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'
export { sessionViewIdentity, viewMatchesProjectedSession, approvalMatchesView } from '${posix(abs('src/renderer/src/features/session/view-state.ts'))}'
`,
    {
      'src/renderer/src/features/session/TurnView.tsx': `export function TurnView(){ return null }\nTurnView.__stub='turnview'`,
      'src/renderer/src/features/session/ApprovalCard.tsx': `export function ApprovalCard(){ return null }\nApprovalCard.__stub='approval'`,
      'src/renderer/src/features/session/QuestionCard.tsx': `export function QuestionCard(){ return null }\nQuestionCard.__stub='question'`,
      'src/renderer/src/features/session/MessageMenu.tsx': `export function MessageMenuHost(){ return null }`,
      'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }\nIcon.__stub='icon'`,
      'src/renderer/src/i18n/index.tsx': `export const currentLang = 'zh-CN'\nexport function useT(){ return (k)=>String(k) }\nexport function useI18n(){ return { t:(k)=>String(k) } }\nexport function translate(_l,k){ return String(k) }`,
      'src/renderer/src/ui/index.ts': `export function IconButton(){ return null }\nexport function Button(){ return null }\nexport function Badge(){ return null }\nexport function Tabs(){ return null }\nexport function TabList(){ return null }\nexport function Tab(){ return null }\nexport function Dialog(){ return null }\nexport function Modal(){ return null }\nexport function ModalOverlay(){ return null }\nexport function ShimmerText(props){ return [props.lead ?? null, props.children] }\nexport function CompletionSweep(){ return null }\nexport function Notice(props){ return props.children ?? null }\nexport function ProgressBar(){ return null }\nexport function Card(props){ return props.children ?? null }\nexport function SegmentedControl(){ return null }\nexport function StatusDot(){ return null }\nexport function StatusSlot(props){ return props.children ?? null }`
    },
    shims
  )

  const turnOut = await buildOne(
    outdir,
    'turn',
    `export { TurnView } from '${posix(abs('src/renderer/src/features/session/TurnView.tsx'))}'
export { useStore } from '${posix(abs('src/renderer/src/state/store.ts'))}'
`,
    {
      'src/renderer/src/features/session/Markdown.tsx': `export const Markdown=(props)=>{ Markdown.__calls.push(props); return null }\nMarkdown.__stub='markdown'\nMarkdown.__calls=[]`,
      'src/renderer/src/features/session/MessageParts.tsx': `export function TurnArtifacts(props){ TurnArtifacts.__calls.push(props); return null }\nTurnArtifacts.__stub='turn-artifacts'\nTurnArtifacts.__calls=[]`,
      'src/renderer/src/features/session/Thinking.tsx': `export function ThinkingLine(){ return null }\nexport function ThinkingAside(){ return null }`,
      'src/renderer/src/features/session/ToolSteps.tsx': `import { createContext } from 'react'\nexport function ToolSteps(){ return null }\nexport const ToolTallyScope = createContext(false)`,
      'src/renderer/src/features/session/Image.tsx': `export function MessageImage(){ return null }`,
      'src/renderer/src/features/session/UserText.tsx': `export function UserText(props){ return props.text }`,
      'src/renderer/src/features/session/TurnChanges.tsx': `export function TurnChanges(){ return null }`,
      'src/renderer/src/features/session/Busy.tsx': `export function Busy(){ return null }`,
      'src/renderer/src/features/session/text.ts': `export function useSessionText(){ return (k)=>String(k) }\nexport function sessionText(_l,k){ return String(k) }`,
      'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }\nIcon.__stub='icon'`,
      'src/renderer/src/i18n/index.tsx': `export const currentLang = 'zh-CN'\nexport function useT(){ return (k)=>String(k) }\nexport function useI18n(){ return { t:(k)=>String(k) } }\nexport function translate(_l,k){ return String(k) }`,
      'src/renderer/src/ui/index.ts': `export function IconButton(){ return null }\nexport function Button(){ return null }\nexport function Badge(){ return null }\nexport function ShimmerText(props){ return [props.lead ?? null, props.children] }\nexport function CompletionSweep(){ return null }\nexport function Notice(props){ return props.children ?? null }\nexport function ProgressBar(){ return null }\nexport function Card(props){ return props.children ?? null }\nexport function SegmentedControl(){ return null }\nexport function StatusDot(){ return null }\nexport function StatusSlot(props){ return props.children ?? null }`,
      'src/renderer/src/features/session/run-status.ts': `export function useRunProgress(){ return null }\nexport function useWorkingLine(){ return null }\nexport function runPhaseText(){ return '' }`,
      'src/renderer/src/lib/fork.ts': `export async function forkFromText(){}\nexport async function forkAt(){}`
    },
    shims
  )

  return { logicOut, viewstateOut, sessionOut, turnOut }
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
      return __wireCollapsibles(tree)
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

const byStub = (tree, name) => collect(tree, (el) => el.type && el.type.__stub === name)
const byTypeName = (tree, name) => collect(tree, (el) => typeof el.type === 'function' && el.type.name === name)

const approval = (over = {}) => ({
  id: 'ap',
  kind: 'danger',
  tool: 'bash',
  title: '批准',
  detail: 'rm -rf',
  reasons: [],
  cwd: 'C:/a',
  canRemember: false,
  createdAt: 1,
  ...over
})

const SESSION_A = {
  sessionId: 'sess-a',
  conversationId: 'sess-a',
  sessionFile: 'A',
  conversationFile: 'A',
  sessionName: 'A',
  cwd: 'C:/a',
  isStreaming: true,
  isAgentRunning: true
}

const msg = (id, role, text, extra = {}) => ({ id, role, text, ...extra })

function resetSessionStore(store, overrides = {}) {
  store.setState({
    session: null,
    messages: [],
    questionLog: [],
    questionLogSession: null,
    runTail: null,
    peekedSessionId: null,
    peekedPath: null,
    approvals: [],
    subagents: [],
    uiRequests: [],
    models: [],
    ...overrides
  })
}

async function main() {
  installGlobals()
  installWindow()

  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-session-view-'))
  let logic
  let viewstate
  let sessionBundle
  let turnBundle
  try {
    const built = await buildAll(outdir)
    logic = await import(pathToFileURL(built.logicOut).href)
    viewstate = await import(pathToFileURL(built.viewstateOut).href)
    sessionBundle = await import(pathToFileURL(built.sessionOut).href)
    turnBundle = await import(pathToFileURL(built.turnOut).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { createTurnProjector } = logic
  const { sessionViewIdentity, viewMatchesProjectedSession, approvalMatchesView } = viewstate
  const { SessionView, useStore } = sessionBundle
  const { TurnView, useStore: turnStore } = turnBundle

  group('view-state：peek 优先、逐字段回退，不冒认活动会话')
  {
    const session = { sessionId: 'sess-a', conversationId: 'sess-a', sessionFile: 'A', conversationFile: 'A' }
    const peekB = sessionViewIdentity({ peekedSessionId: 'sess-b', peekedPath: 'B', session })
    ok(peekB.sessionId === 'sess-b' && peekB.sessionFile === 'B' && peekB.key === 'B', '有 peek：身份取 peek 的 id 与路径', peekB)

    const pathOnly = sessionViewIdentity({ peekedSessionId: null, peekedPath: 'B', session })
    ok(pathOnly.sessionId === null, 'path-only peek：sessionId 保持 null，不回退活动会话 A', pathOnly)
    ok(pathOnly.sessionFile === 'B' && pathOnly.key === 'B', 'path-only peek：路径仍是 B 的稳定键', pathOnly)

    const active = sessionViewIdentity({ peekedSessionId: null, peekedPath: null, session })
    ok(active.sessionId === 'sess-a' && active.key === 'A', '无 peek：回退运行实例投影的会话身份', active)

    const churn = sessionViewIdentity({ peekedSessionId: null, peekedPath: null, session: { inbox: true } })
    ok(churn.sessionId === null && churn.key === '', '会话还没有身份时保持空，不猜', churn)

    ok(viewMatchesProjectedSession(peekB, session) === false, 'peek 另一条会话：视图不是实例投影的会话')
    ok(viewMatchesProjectedSession(pathOnly, session) === false, 'path-only peek 别人：视图不是实例投影的会话')
    ok(viewMatchesProjectedSession(active, session) === true, '无 peek：视图就是实例投影的会话')
    ok(viewMatchesProjectedSession(sessionViewIdentity({ peekedSessionId: 'sess-a', peekedPath: null, session }), session) === true, 'peek 回活动会话自己：算已激活')

    const sub = [{ id: 'sub-1', parentSessionId: 'sess-a' }]
    ok(approvalMatchesView({ sessionId: 'sess-a' }, [], peekB) === false, '批准来源 A、视图 B：不匹配')
    ok(approvalMatchesView({ sessionId: 'sess-b' }, [], peekB) === true, '批准来源 B、视图 B：匹配')
    ok(approvalMatchesView({ sessionId: 'sub-x', subagentId: 'sub-1' }, sub, active) === true, '子代理批准按父会话归属到视图 A')
    ok(approvalMatchesView({ subagentId: 'missing' }, sub, active) === false, '来源解析不出时不强行匹配')
  }

  const rt = makeHookRuntime()
  globalThis.__V3_HOOKS = rt
  const renderSession = (overrides) => {
    resetSessionStore(useStore, overrides)
    return rt.render(SessionView, {})
  }

  group('A 流中看历史 B：B 不背 A 的等待 / 批准 / 提问')
  {
    const tree = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'B 的问题', { timestamp: 10 })],
      peekedPath: 'B',
      peekedSessionId: 'sess-b',
      questionLog: [{ id: 'ql-a', at: 5, question: 'A 的问题' }],
      questionLogSession: 'sess-a',
      approvals: [approval({ id: 'ap-a', sessionId: 'sess-a' })],
      uiRequests: [{ id: 'q-a', method: 'input', title: 'A 的提问' }]
    })
    const turns = byStub(tree, 'turnview')
    ok(turns.length === 1, 'B 的消息仍然显示出来', turns.length)
    ok(turns.every((el) => el.props.sessionId === 'sess-b'), 'TurnView 拿到的是 B 的视图身份，不是 A', turns.map((el) => el.props.sessionId))
    ok(byTypeName(tree, 'PendingRunNotice').length === 0, 'B 底部没有挂 A 的等待行（A 仍在跑）')
    ok(byStub(tree, 'approval').length === 0, 'B 底部没有挂来源 A 的批准卡（热键随之不注册）')
    ok(byStub(tree, 'question').length === 0, 'B 底部没有挂来源不明的提问卡')
    ok(turns.every((el) => String(el.key).startsWith('B|')), '列表 key 带视图身份 B', turns.map((el) => el.key))
    ok(tree.props['data-view-key'] === 'B' && tree.props['data-view-active'] === '0', '根节点视图键为 B、标记为未激活', { key: tree.props['data-view-key'], active: tree.props['data-view-active'] })
  }

  group('B 只拿到路径、身份未知：不冒认 A 的会话 id 与 A 的提问')
  {
    const tree = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'B 的问题', { timestamp: 10 })],
      peekedPath: 'B',
      peekedSessionId: null,
      questionLog: [{ id: 'ql-a', at: 5, question: 'A 的问题' }],
      questionLogSession: 'sess-a',
      approvals: [approval({ id: 'ap-a', sessionId: 'sess-a' })],
      uiRequests: [{ id: 'q-a', method: 'input' }]
    })
    const turns = byStub(tree, 'turnview')
    ok(turns.length === 1 && turns[0].props.sessionId === null, 'path-only 视图把 sessionId 传 null，不冒认 sess-a', turns.map((el) => el.props.sessionId))
    ok(byTypeName(tree, 'PendingRunNotice').length === 0, 'path-only 视图不显示 A 的等待')
    ok(byStub(tree, 'approval').length === 0, 'path-only 视图不显示来源 A 的批准')
    ok(byStub(tree, 'question').length === 0, 'path-only 视图不显示 A 的提问')
    ok(tree.props['data-view-active'] === '0', 'path-only 视图不算已激活')
  }

  group('回到 A：保留原滚动身份，A 的等待 / 卡片重新出现')
  {
    const onA = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'A 的问题', { timestamp: 10 })],
      approvals: [approval({ id: 'ap-a', sessionId: 'sess-a' })],
      uiRequests: [{ id: 'q-a', method: 'input' }]
    })
    const aKey = onA.props['data-view-key']
    ok(aKey === 'A', 'A 的视图键取活动会话文件 A', aKey)

    const onB = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'B 的问题', { timestamp: 10 })],
      peekedPath: 'B',
      peekedSessionId: 'sess-b'
    })
    ok(onB.props['data-view-key'] === 'B', '切到 B 后视图键变成 B')
    const back = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'A 的问题', { timestamp: 10 })],
      approvals: [approval({ id: 'ap-a', sessionId: 'sess-a' })],
      uiRequests: [{ id: 'q-a', method: 'input' }]
    })
    ok(back.props['data-view-key'] === aKey, '回到 A 视图键与之前一致（滚动记录可恢复）', back.props['data-view-key'])
    ok(back.props['data-view-active'] === '1', '回到 A 算已激活')
    ok(byTypeName(back, 'PendingRunNotice').length === 1, 'A 仍在跑：回到 A 时等待行重新出现')
    ok(byStub(back, 'approval').length === 1, '回到 A：来源 A 的批准卡重新出现')
    ok(byStub(back, 'question').length === 1, '回到 A：A 的提问卡重新出现')

    const keyA = byStub(onA, 'turnview')[0]?.key
    const keyB = byStub(onB, 'turnview')[0]?.key
    ok(keyA === 'A|m0' && keyB === 'B|m0' && keyA !== keyB, '跨会话相同短消息 id：key 带视图身份，切视图重挂安全', { keyA, keyB })
  }

  group('两个 path-only 视图：相同短消息 id 的列表 key 仍不同')
  {
    const b = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'B 的问题', { timestamp: 10 })],
      peekedPath: 'B',
      peekedSessionId: null
    })
    const c = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'C 的问题', { timestamp: 10 })],
      peekedPath: 'C',
      peekedSessionId: null
    })
    const keyB = byStub(b, 'turnview')[0]?.key
    const keyC = byStub(c, 'turnview')[0]?.key
    ok(keyB === 'B|m0' && keyC === 'C|m0' && keyB !== keyC, '同短消息 id、不同 path-only 视图：key 不同，切视图强制重挂', { keyB, keyC })
    ok(byStub(b, 'turnview')[0].props.sessionId === null && byStub(c, 'turnview')[0].props.sessionId === null, '两份 path-only 视图的 sessionId 都是 null，不伪造身份')
  }

  group('请求来源明确属于 B：B 底部显示 B 自己的批准')
  {
    const tree = renderSession({
      session: SESSION_A,
      messages: [msg('m0', 'user', 'B 的问题', { timestamp: 10 })],
      peekedPath: 'B',
      peekedSessionId: 'sess-b',
      approvals: [approval({ id: 'ap-b', sessionId: 'sess-b' })],
      uiRequests: [{ id: 'q-a', method: 'input' }]
    })
    ok(byStub(tree, 'approval').length === 1, '批准来源是 B：按正式数据在 B 视图显示')
    ok(byStub(tree, 'question').length === 0, '提问没有来源身份：仍不冒认到 B 视图')
  }

  const project = createTurnProjector()
  const baseMessages = () => [
    msg('u1', 'user', 'hi', { timestamp: 1 }),
    msg('a1', 'assistant', '先读文件', {
      timestamp: 2,
      sourceCwd: 'C:/proj/a',
      toolCalls: [{ id: 't1', name: 'read', args: {}, status: 'done', output: 'x' }]
    }),
    msg('a2', 'assistant', '这是回答', {
      timestamp: 3,
      sourceCwd: 'C:/proj/b',
      artifacts: [
        { id: 'art1', sourceId: 's1', filename: 'x.html', bytes: 12, kind: 'html', previewable: true, path: 'C:/a/x.html', description: '', unavailable: false }
      ]
    })
  ]
  const assistantOf = (messages) => project(messages).find((t) => t.kind === 'assistant')

  const renderTurn = (turn, props = {}) => {
    turnStore.setState({ session: SESSION_A, messages: [], subagents: [], models: [] })
    const el = TurnView({ turn, ...props })
    rt.seq = 0
    return rt.render(el.type, el.props)
  }

  group('TurnView → Markdown / TurnArtifacts：真实消息身份与逐段 sourceCwd')
  {
    const turn = assistantOf(baseMessages())
    ok(turn.commentary.length === 1 && turn.commentary[0].id === 'a1#0', 'computed commentary 的来源 id 是真实消息段 a1#0', turn.commentary.map((p) => p.id))
    ok(turn.response && turn.response.id === 'a2#1', 'computed response 的来源 id 是真实消息段 a2#1', turn.response && turn.response.id)
    ok(turn.id === 'a1', 'AssistantTurn.id 是首条 assistant 消息 id a1', turn.id)

    const tree = renderTurn(turn, { sessionId: 'sess-a', streaming: false })
    const proc = byTypeName(tree, 'TurnProcess')[0]
    ok(!!proc, '带工具的回合把解说收进 TurnProcess')
    const isToggle = (el) => el.props?.['data-testid'] === 'v3-process-toggle'
    const folded = proc ? rt.render(proc.type, proc.props) : null
    const toggle = folded ? collect(folded, isToggle)[0] : null
    ok(!!toggle && toggle.props['aria-expanded'] === false, '完成后过程在原位收成一行入口（简洁视图默认收起）', toggle?.props['aria-expanded'])
    ok(folded ? byTypeName(folded, 'ProcessSegment').length === 0 : false, '收起时不铺开过程内容')
    toggle?.props.onClick()
    const expanded = proc ? rt.render(proc.type, proc.props) : null
    ok(expanded ? collect(expanded, isToggle)[0]?.props['aria-expanded'] === true : false, '点开入口后展开，阅读状态存在展开存储里')
    const segments = expanded ? byTypeName(expanded, 'ProcessSegment').map((el) => rt.render(el.type, el.props)) : []
    ok(segments.some((seg) => byStub(seg, 'markdown').length > 0), '展开后解说在工具组旁按原顺序铺开')
    const mds = [...byStub(tree, 'markdown'), ...segments.flatMap((seg) => byStub(seg, 'markdown'))]
    const commentary = mds.find((el) => el.props.messageId === turn.commentary[0].id)
    const response = mds.find((el) => el.props.messageId === turn.response.id)
    ok(!!commentary, '解说段落拿到自己的消息身份', mds.map((el) => el.props.messageId))
    ok(commentary?.props.sessionId === 'sess-a', '解说段落带上视图 sessionId', commentary?.props.sessionId)
    ok(commentary?.props.sourceCwd === 'C:/proj/a', '解说段落用逐段 sourceCwd，而不是当前 cwd', commentary?.props.sourceCwd)
    ok(!!response, '正式回复拿到自己的消息身份', mds.map((el) => el.props.messageId))
    ok(response?.props.sourceCwd === 'C:/proj/b', '正式回复保留自己的 sourceCwd', response?.props.sourceCwd)

    const arts = byStub(tree, 'turn-artifacts')
    ok(arts.length === 1, '成果列表照常渲染（已完成成果不退回 placeholder）', arts.length)
    ok(arts[0].props.sessionId === 'sess-a' && arts[0].props.messageId === turn.id, '成果用 AssistantTurn.id 做整回合组身份', { sessionId: arts[0].props.sessionId, messageId: arts[0].props.messageId })
    ok(byTypeName(tree, 'ImageProgressFallbackNote').length === 0, '全部生图已 done：不显示生图回退提示')

    const nullTree = renderTurn(turn, { sessionId: null, streaming: false })
    const nullMds = byStub(nullTree, 'markdown')
    ok(nullMds.length > 0 && nullMds.every((el) => el.props.sessionId === null), '身份未知时 sessionId 传 null，保持 U3 安全回退', nullMds.map((el) => el.props.sessionId))
    ok(nullMds.every((el) => typeof el.props.messageId === 'string' && el.props.messageId.length > 0), '身份未知时仍传真实 messageId', nullMds.map((el) => el.props.messageId))
  }

  group('TurnView 元信息：每轮统一为「时间 · 模型 · 复制」，末轮与换模型的回合常驻，其余悬停显示')
  {
    const turn = assistantOf(baseMessages())
    const metaOf = (props, source = turn) => {
      const tree = renderTurn(source, { sessionId: 'sess-a', streaming: false, ...props })
      const el = byTypeName(tree, 'TurnMeta')[0]
      return { el, root: el ? rt.render(el.type, el.props) : null }
    }
    const parts = (root) => [root?.props.children].flat(Infinity).filter((child) => child && typeof child === 'object')
    const model = (root) => parts(root).find((child) => child.props?.className === 'v3-act-model')
    const clock = (root) => parts(root).find((child) => child.props?.className === 'v3-msg-meta-part')
    const order = (root) => parts(root).map((child) => child.props?.className ?? child.props?.['data-testid'])
    const last = metaOf({ tail: true }, { ...turn, model: 'prov/model-x' })
    ok(last.el?.props.tail === true && last.root?.props['data-testid'] === 'v3-turn-meta' && last.root.props['data-reveal'] === undefined, '最后一轮：元信息行常驻', last.root?.props['data-reveal'])
    ok(parts(last.root).every((child) => child.props?.['data-reveal'] === undefined), '最后一轮：各项一起显示，不再只剩模型名', parts(last.root).map((child) => child.props?.['data-reveal']))
    ok(!clock(last.root) || !model(last.root) || order(last.root).indexOf('v3-msg-meta-part') < order(last.root).indexOf('v3-act-model'), '时间排在模型名之前', order(last.root))
    ok(!model(last.root) || model(last.root).props.className === 'v3-act-model', '模型名仍在', model(last.root)?.props)
    const history = metaOf({ tail: false })
    ok(history.el?.props.tail === false && history.root?.props['data-reveal'] === 'hover', '历史轮：元信息改为悬停显示（仍渲染，占位保留）', history.root?.props['data-reveal'])
    const shifted = metaOf({ tail: false, modelShift: true })
    ok(shifted.root?.props['data-reveal'] === undefined, '换模型的历史轮：整行常驻', shifted.root?.props['data-reveal'])
    const unordered = metaOf({})
    ok(unordered.el?.props.tail === true, '调用方不区分末轮时：按末轮处理', unordered.el?.props.tail)
    for (const reason of ['stopped', 'interrupted']) {
      const tree = renderTurn({ ...turn, terminalReason: reason }, { sessionId: 'sess-a', streaming: false, tail: false })
      const el = byTypeName(tree, 'TurnMeta')[0]
      const root = el ? rt.render(el.type, el.props) : null
      ok(root?.props['data-reveal'] === undefined, `历史轮以 ${reason} 结束：元信息带终止状态，保持常驻`, root?.props['data-reveal'])
    }
    const completed = renderTurn({ ...turn, terminalReason: 'completed' }, { sessionId: 'sess-a', streaming: false, tail: false })
    const completedEl = byTypeName(completed, 'TurnMeta')[0]
    ok((completedEl ? rt.render(completedEl.type, completedEl.props) : null)?.props['data-reveal'] === 'hover', '历史轮正常收尾：仍然悬停才显示')
    const live = renderTurn(turn, { sessionId: 'sess-a', streaming: true, tail: true })
    ok(byTypeName(live, 'TurnMeta').length === 0, '运行中的回合不渲染元信息行（保持现状）')
  }

  group('进度叙述：运行中照常露出，结束后收进过程摘要，最终答复始终露出')
  {
    const narrated = () => [
      msg('u1', 'user', '去撤下来', { timestamp: 1 }),
      msg('a1', 'assistant', '', { timestamp: 2, toolCalls: [{ id: 'n1', name: 'bash', args: { command: 'git push' }, status: 'ok', output: '' }] }),
      msg('a2', 'assistant', '远端已更新。还有一处残留。', { timestamp: 3 }),
      msg('a3', 'assistant', '', { timestamp: 4, toolCalls: [{ id: 'n2', name: 'read', args: { path: 'a.md' }, status: 'ok', output: '' }] }),
      msg('a4', 'assistant', '已从远端撤下。', { timestamp: 5 })
    ]
    const turn = assistantOf(narrated())
    const shownTexts = (tree) => byTypeName(tree, 'Markdown').map((el) => el.props.text)
    const done = renderTurn(turn, { sessionId: 'sess-a', streaming: false, tail: true })
    ok(shownTexts(done).join('|') === '已从远端撤下。', '结束后：只露出最终答复', shownTexts(done))
    const proc = byTypeName(done, 'TurnProcess')[0]
    ok(!!proc && proc.props.process.some((segment) => segment.commentary.some((part) => part.text.includes('还有一处残留'))), '结束后：叙述进入过程摘要', proc?.props.process.map((segment) => segment.id))
    const running = renderTurn({ ...turn, streaming: true }, { sessionId: 'sess-a', streaming: true, tail: true })
    ok(shownTexts(running).includes('远端已更新。还有一处残留。'), '运行中：叙述照常露出', shownTexts(running))
  }

  group('过程行：不写「过程」前缀，失败计数按回合最终状态着色')
  {
    const failedMessages = () => [
      msg('u1', 'user', '跑检查', { timestamp: 1 }),
      msg('a1', 'assistant', '先跑类型检查', {
        timestamp: 2,
        toolCalls: [
          { id: 'f1', name: 'bash', args: { command: 'npm run typecheck' }, status: 'error', output: 'TS2322' },
          { id: 'f2', name: 'bash', args: { command: 'npm run typecheck' }, status: 'done', output: 'ok' }
        ]
      }),
      msg('a2', 'assistant', '改好了', { timestamp: 3 })
    ]
    const base = assistantOf(failedMessages())
    const processOf = (turn, streaming = false) => {
      const tree = renderTurn(turn, { sessionId: 'sess-a', streaming, tail: true })
      const el = byTypeName(tree, 'TurnProcess')[0]
      const body = el ? rt.render(el.type, el.props) : null
      const failed = body ? collect(body, (node) => node.props?.['data-testid'] === 'v3-process-failed')[0] : null
      const toggle = body ? collect(body, (node) => node.props?.['data-testid'] === 'v3-process-toggle')[0] : null
      return { el, body, failed, toggle }
    }
    const done = processOf({ ...base, terminalReason: 'completed' })
    ok(!!done.toggle && collect(done.toggle, (node) => String(node.props?.className ?? '').includes('v3-process-label')).length === 0, '过程入口不再带「过程」前缀')
    const partsLine = done.toggle ? collect(done.toggle, (node) => node.props?.className === 'v3-process-line')[0] : null
    const firstPart = partsLine ? [].concat(partsLine.props.children).flat().find((child) => child && typeof child === 'object') : null
    ok(firstPart?.props?.className === 'v3-process-count', '入口第一项就是计数', firstPart?.props?.className)
    ok(done.el?.props.alertFailures === false && !!done.failed && !String(done.failed.props.className).includes('err'), '正常收尾：失败计数用次级文字色，不标红', done.failed?.props.className)
    const failed = processOf({ ...base, terminalReason: 'failed' })
    ok(failed.el?.props.alertFailures === true && String(failed.failed?.props.className).includes('err'), '以失败结束：失败计数标红', failed.failed?.props.className)
    const stopped = processOf({ ...base, terminalReason: 'stopped' })
    ok(String(stopped.failed?.props.className).includes('err'), '被中止：失败计数标红', stopped.failed?.props.className)
    const errored = processOf({ ...base, error: '模型报错' })
    ok(String(errored.failed?.props.className).includes('err'), '以错误结束：失败计数标红', errored.failed?.props.className)
  }

  group('TurnView 生图进度：只有仍在生成的图片用回退提示')
  {
    const live = baseMessages()
    live[2] = { ...live[2], imageProgress: [{ id: 'img1', stage: 'generating', startedAt: 1, updatedAt: 2 }] }
    const turn = assistantOf(live)
    const tree = renderTurn(turn, { sessionId: 'sess-a', streaming: true })
    ok(byTypeName(tree, 'ImageProgressFallbackNote').length === 1, '有未完成的生图：显示回退提示')
    ok(byStub(tree, 'turn-artifacts').length === 1, '已完成成果卡与生图进度并存，不被回退提示遮掉')
  }

  process.stdout.write(`\n${report.fail === 0 ? '全部通过' : '有失败项'}：${report.pass} 通过 / ${report.fail} 失败\n`)
  await rm(outdir, { recursive: true, force: true })
  process.exit(report.fail === 0 ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
