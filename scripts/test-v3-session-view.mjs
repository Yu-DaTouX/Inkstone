#!/usr/bin/env node
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
  const stubMap = new Map(Object.entries(rawMap).map(([rel, src]) => [abs(rel), src]))
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
      'src/renderer/src/features/session/SubagentPanel.tsx': `export function SubagentPanel(){ return null }\nSubagentPanel.__stub='subagent-panel'`,
      'src/renderer/src/features/session/ApprovalCard.tsx': `export function ApprovalCard(){ return null }\nApprovalCard.__stub='approval'`,
      'src/renderer/src/features/session/QuestionCard.tsx': `export function QuestionCard(){ return null }\nQuestionCard.__stub='question'`,
      'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }\nIcon.__stub='icon'`,
      'src/renderer/src/i18n/index.tsx': `export function useT(){ return (k)=>String(k) }\nexport function useI18n(){ return { t:(k)=>String(k) } }\nexport function translate(_l,k){ return String(k) }`,
      'src/renderer/src/ui/index.ts': `export function IconButton(){ return null }\nexport function Button(){ return null }\nexport function Badge(){ return null }\nexport function Tabs(){ return null }\nexport function TabList(){ return null }\nexport function Tab(){ return null }\nexport function Dialog(){ return null }\nexport function Modal(){ return null }\nexport function ModalOverlay(){ return null }`
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
      'src/renderer/src/features/session/Markdown.tsx': `export const Markdown=(props)=>{ Markdown.__calls.push(props); return null }\nMarkdown.__stub='markdown'\nMarkdown.__calls=[]\nexport function PlainText(){ return null }`,
      'src/renderer/src/features/session/MessageParts.tsx': `export function TurnArtifacts(props){ TurnArtifacts.__calls.push(props); return null }\nTurnArtifacts.__stub='turn-artifacts'\nTurnArtifacts.__calls=[]`,
      'src/renderer/src/features/session/Thinking.tsx': `export function ThinkingLine(){ return null }`,
      'src/renderer/src/features/session/ToolSteps.tsx': `export function ToolSteps(){ return null }`,
      'src/renderer/src/features/session/Image.tsx': `export function MessageImage(){ return null }`,
      'src/renderer/src/features/session/TurnChanges.tsx': `export function TurnChanges(){ return null }`,
      'src/renderer/src/features/session/Busy.tsx': `export function Busy(){ return null }`,
      'src/renderer/src/features/session/text.ts': `export function useSessionText(){ return (k)=>String(k) }\nexport function sessionText(_l,k){ return String(k) }`,
      'src/renderer/src/features/session/Icon.tsx': `export function Icon(){ return null }\nIcon.__stub='icon'`,
      'src/renderer/src/i18n/index.tsx': `export function useT(){ return (k)=>String(k) }\nexport function useI18n(){ return { t:(k)=>String(k) } }\nexport function translate(_l,k){ return String(k) }`,
      'src/renderer/src/ui/index.ts': `export function IconButton(){ return null }\nexport function Button(){ return null }\nexport function Badge(){ return null }`,
      'src/renderer/src/components/chat/run-status.ts': `export function useRunProgress(){ return null }\nexport function runPhaseText(){ return '' }`,
      'src/renderer/src/components/chat/turn-model-display.ts': `export function resolveTurnModelDisplay(){ return null }`,
      'src/renderer/src/lib/fork.ts': `export async function forkFromText(){}`
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
    ok(byTypeName(tree, 'PendingActivity').length === 0, 'B 底部没有挂 A 的等待行（A 仍在跑）')
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
    ok(byTypeName(tree, 'PendingActivity').length === 0, 'path-only 视图不显示 A 的等待')
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
    ok(byTypeName(back, 'PendingActivity').length === 1, 'A 仍在跑：回到 A 时等待行重新出现')
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
    ok(!!proc, '带工具的回合把解说收进过程行 TurnProcess')
    const folded = proc ? rt.render(proc.type, proc.props) : null
    ok(folded ? byStub(folded, 'markdown').length === 0 : false, '过程行默认折叠，解说不铺开')
    const toggle = folded ? collect(folded, (el) => el.props?.['data-testid'] === 'v3-process-toggle')[0] : null
    toggle?.props.onClick()
    const expanded = proc ? rt.render(proc.type, proc.props) : null
    const mds = [...byStub(tree, 'markdown'), ...(expanded ? byStub(expanded, 'markdown') : [])]
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
