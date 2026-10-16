#!/usr/bin/env node
/**
 * v3 path-only 视图身份回归：peek 身份成对取值 / 旧 sync 不覆盖新视图。
 *
 * 现场编译**真实生产模块**，不用源码字符串断言：
 *   · 纯逻辑 bundle：`state/view-identity.ts` + `features/workbench/ownership.ts`
 *     + `features/browser/ownership.ts` + `state/workspace-key.ts`；
 *   · 真实 store bundle：`state/store.ts`（带可控 `window.yan` 桥）+ 提交归属 helper。
 *
 * 钉住的缺陷（V4 只读审确认正式可达）：
 *   1. `switchSession` 列表外会话 `sum` 缺失、旧读取器只给 messages 不给 sessionId 时，
 *      会写成 peekedPath=B / peekedSessionId=null / session 仍 A；旧身份取值把 null id
 *      补成 A，`sessionIsView` 自比 A → 归属成「A id + B path」、cwd/active 借 A。
 *   2. 同步归属只认 peeked id，A 迟到的 sync 会覆盖刚铺上的 B。
 *
 * 期望：peek 任一身份存在时 id / 文件成对只取 peek；未知 path-only 按 B path、
 * active=false、cwd 只可 B 的待激活 / 摘要 / 运行实例或空；A 的 sync 不得覆盖 B；
 * 正式 B 激活成功后能接住它自己的消息并退出 peek；提交归属不借 A。
 *
 * 用法：node scripts/test-v3-path-identity.mjs
 * 不启动 Electron、不连 pi、不读用户数据、不调用真实模型、不建 PTY / 浏览器。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, normalize } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

/* ------------------------------------------------------------------ 断言 */

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
  const extra = pass ? '' : `  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}`
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${extra}\n`)
  return pass
}

/* -------------------------------------------------------- 全局/定时桩 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function flush() {
  await sleep(0)
  await sleep(0)
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
      /* 无真实帧 */
    }
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { lang: 'zh-CN' },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
}

function defer() {
  let resolveFn
  const promise = new Promise((r) => {
    resolveFn = r
  })
  return { promise, resolve: resolveFn }
}

/* ------------------------------------------------------------ bundle */

const A = 'C:/data/a.jsonl'
const B = 'C:/data/b.jsonl'

async function buildPure(outdir) {
  const entry = join(outdir, 'pure-entry.ts')
  await writeFile(
    entry,
    `export { viewIdentityOf, viewKeyRef, viewingSessionIdOf, incomingProvesPath, pushBelongsToView } from '${posix(resolve(ROOT, 'src/renderer/src/state/view-identity'))}'
export { deriveWorkspaceOwner, viewIdentity } from '${posix(resolve(ROOT, 'src/renderer/src/features/workbench/ownership'))}'
export { browserControlAllowed } from '${posix(resolve(ROOT, 'src/renderer/src/features/browser/ownership'))}'
export { workspaceKeyFor } from '${posix(resolve(ROOT, 'src/renderer/src/state/workspace-key'))}'
`
  )
  const out = join(outdir, 'pure-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  return out
}

/** 可控 `window.yan`：明确的返回值 / 延迟，其余返回空实现。 */
function makeYan({ peek } = {}) {
  const calls = { selectSession: [], peekSession: [], send: [] }
  const pending = { select: null, peek: null }
  const real = {
    peekSession: async (path) => {
      calls.peekSession.push(path)
      if (pending.peek) await pending.peek.promise
      return peek ? peek(path) : { messages: [], sessionId: undefined, truncated: 0, total: 0 }
    },
    selectSession: async (target) => {
      calls.selectSession.push(target)
      if (pending.select) return await pending.select.promise
      return { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
    },
    send: async (text, images, mode) => {
      calls.send.push({ text, images, mode })
      return { ok: true }
    },
    runBash: async () => ({ ok: true }),
    runnerStatuses: async () => [],
    listRunners: async () => [],
    agentStatus: async () => ({ state: 'idle', detail: '' }),
    listModels: async () => [],
    listCommands: async () => [],
    sources: { verifyFiles: async () => [], addImage: async () => undefined },
    getSettings: async () => ({}),
    getZoom: async () => 1,
    browser: {
      open: async () => ({ open: true, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
      close: async () => ({ open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }),
      setVisible: async () => undefined
    }
  }
  const yan = new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return async () => undefined
    }
  })
  return { yan, calls, pending }
}

async function buildStore(outdir) {
  const entry = join(outdir, 'store-entry.ts')
  await writeFile(
    entry,
    `export { useStore } from '${posix(resolve(ROOT, 'src/renderer/src/state/store'))}'
export { viewingSubmitSessionId } from '${posix(resolve(ROOT, 'src/renderer/src/lib/v3-submit-ownership'))}'
`
  )
  const out = join(outdir, 'store-bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'process.env.NODE_ENV': '"production"',
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })
  return out
}

/* ------------------------------------------------- 把 store 状态喂给推导 */

const SESSION_A = { sessionId: 'sess-a', sessionFile: A, conversationId: 'conv-a', conversationFile: A, cwd: 'C:/proj/a' }

function ownerInput(state, over = {}) {
  return {
    peekedSessionId: state.peekedSessionId ?? null,
    peekedPath: state.peekedPath ?? null,
    session: state.session
      ? {
          sessionId: state.session.sessionId,
          sessionFile: state.session.sessionFile,
          conversationId: state.session.conversationId,
          conversationFile: state.session.conversationFile,
          cwd: state.session.cwd
        }
      : null,
    pendingActivation: state.pendingActivation,
    activeRunnerId: state.activeRunnerId,
    runners: (state.runners ?? []).map((r) => ({
      id: r.id,
      runId: r.runId,
      sessionId: r.sessionId,
      sessionFile: r.sessionFile,
      cwd: r.cwd,
      generation: r.generation,
      isActive: r.isActive
    })),
    sessions: (state.sessions ?? []).map((s) => ({ id: s.id, path: s.path, cwd: s.cwd })),
    ...over
  }
}

function resetStore(useStore, overrides = {}) {
  useStore.setState({
    sessions: [],
    settings: { cwd: 'C:/proj', projects: [] },
    session: { ...SESSION_A },
    messages: [],
    attachments: [],
    peekedPath: null,
    peekedSessionId: null,
    pendingActivation: null,
    activeRunnerId: 'run-a',
    runners: [{ id: 'run-a', runId: 'run-a', sessionId: 'sess-a', sessionFile: A, cwd: 'C:/proj/a', generation: 0, isActive: true }],
    sessionRuntimes: {},
    notices: [],
    queue: [],
    ...overrides
  })
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'yan-v3-path-identity-'))
  let pure
  let storeMod
  try {
    pure = await import(pathToFileURL(await buildPure(outdir)).href)
    storeMod = await import(pathToFileURL(await buildStore(outdir)).href)
  } catch (err) {
    process.stderr.write(`\n[bundle 失败] ${err && err.stack ? err.stack : err}\n`)
    await rm(outdir, { recursive: true, force: true })
    process.exit(1)
  }

  const { viewIdentityOf, viewKeyRef, viewingSessionIdOf, incomingProvesPath, pushBelongsToView, deriveWorkspaceOwner, viewIdentity, browserControlAllowed, workspaceKeyFor } = pure
  const { useStore, viewingSubmitSessionId } = storeMod

  const keyA = workspaceKeyFor({ sessionId: 'sess-a', path: A })
  const keyB = workspaceKeyFor({ path: B })
  const keyBWithId = workspaceKeyFor({ sessionId: 'sess-b', path: B })

  /* ================================================= 组 1：生产 helper */
  group('view-identity 纯逻辑：peek 任一身份存在时 id / 文件成对只取 peek')
  {
    const pathOnly = viewIdentityOf({ peekedSessionId: null, peekedPath: B, session: SESSION_A })
    ok(pathOnly.peeked === true && pathOnly.sessionId === null && pathOnly.sessionFile === B, 'path-only B：id 留空、路径只取 B，不补 A 的 id', pathOnly)
    ok(JSON.stringify(viewKeyRef({ peekedSessionId: null, peekedPath: B, session: SESSION_A })) === JSON.stringify({ sessionId: undefined, path: B }), 'workspace 键输入只含 B 路径')
    ok(viewingSessionIdOf({ peekedSessionId: null, peekedPath: B, session: SESSION_A }) === undefined, 'path-only 的视图 id 为 undefined，不回落旧会话')

    const idOnly = viewIdentityOf({ peekedSessionId: 'sess-b', peekedPath: null, session: SESSION_A })
    ok(idOnly.sessionId === 'sess-b' && idOnly.sessionFile === null, 'id-only peek：文件留空，不补 A 的文件', idOnly)

    const idPeek = viewIdentityOf({ peekedSessionId: 'sess-b', peekedPath: B, session: SESSION_A })
    ok(idPeek.sessionId === 'sess-b' && idPeek.sessionFile === B, 'id + 路径的 peek 原样成对', idPeek)

    const noPeek = viewIdentityOf({ peekedSessionId: null, peekedPath: null, session: SESSION_A })
    ok(noPeek.peeked === false && noPeek.sessionId === 'sess-a' && noPeek.sessionFile === A, '无 peek：才回落到 session 投影', noPeek)

    ok(incomingProvesPath('sess-b', B, { pendingActivation: { sessionId: 'sess-b', sessionFile: B } }) === true, '待激活目标可证明 incoming 是 B 文件')
    ok(incomingProvesPath('sess-b', B, { runners: [{ sessionId: 'sess-b', sessionFile: B }] }) === true, '运行实例可证明 incoming 是 B 文件')
    ok(incomingProvesPath('sess-b', B, { sessions: [{ id: 'sess-b', path: B }] }) === true, '会话摘要可证明 incoming 是 B 文件')
    ok(incomingProvesPath('sess-a', B, { session: SESSION_A, runners: [{ sessionId: 'sess-a', sessionFile: A }] }) === false, 'A 的正式身份不能证明它是 B 文件')

    const base = { peekedSessionId: null, peekedPath: B, session: SESSION_A }
    ok(pushBelongsToView(base, 'sess-a') === false, 'path-only B：A 的 sync 不属于当前视图（fail closed）')
    ok(pushBelongsToView({ ...base, pendingActivation: { sessionId: 'sess-b', sessionFile: B } }, 'sess-b') === true, 'path-only B：有文件证据的 B sync 属于当前视图')
    ok(pushBelongsToView({ peekedSessionId: 'sess-b', peekedPath: B, session: SESSION_A }, 'sess-a') === false, '有 id 的 peek：A 的 sync 被挡')
    ok(pushBelongsToView({ peekedSessionId: 'sess-b', peekedPath: B, session: SESSION_A }, 'sess-b') === true, '有 id 的 peek：B 的 sync 放行')
    ok(pushBelongsToView({ peekedSessionId: null, peekedPath: null, session: SESSION_A }, 'sess-a') === true, '无 peek：行为不变，正常放行')
    ok(pushBelongsToView({ peekedSessionId: null, peekedPath: null, session: SESSION_A }, undefined) === true, '没有 runtime 身份时不误杀')
  }

  /* ============================================ 组 2：工作区归属推导 */
  group('deriveWorkspaceOwner：path-only B 不再借 A 的 cwd / active')
  {
    const runnersA = [{ id: 'run-a', runId: 'run-a', sessionId: 'sess-a', sessionFile: A, cwd: 'C:/proj/a', generation: 0, isActive: true }]
    const base = {
      peekedSessionId: null,
      peekedPath: B,
      session: SESSION_A,
      pendingActivation: null,
      activeRunnerId: 'run-a',
      runners: runnersA,
      sessions: []
    }
    const owner = deriveWorkspaceOwner(base)
    ok(owner.sessionId === null, '未知 path-only 的 sessionId 为 null，不冒充 A', owner.sessionId)
    ok(owner.sessionFile === B, 'sessionFile 保留 B', owner.sessionFile)
    ok(owner.key === keyB, '归属键按 B 路径', { got: owner.key, want: keyB })
    ok(owner.key !== keyA, '归属键不是 A 的', owner.key)
    ok(owner.cwd === '', '没有 B 的已验证 cwd 时留空，不取 A 的 session.cwd', owner.cwd)
    ok(owner.active === false && owner.runId === undefined, '未激活：active=false 且不给 runId', { active: owner.active, runId: owner.runId })

    ok(
      browserControlAllowed({ owner, visible: true, browserOpen: true, browserOwnerKey: keyA }) === false,
      '资源归 A 时，未激活的 B owner 不能开 A 的浏览器'
    )
    ok(browserControlAllowed({ owner, visible: true, browserOpen: true, browserOwnerKey: owner.key }) === false, '未激活的 owner 即使键一致也不能控制浏览器')

    const withPending = deriveWorkspaceOwner({ ...base, pendingActivation: { sessionFile: B, cwd: 'C:/proj/b' } })
    ok(withPending.cwd === 'C:/proj/b', 'B 的待激活目标 cwd 优先（不是 A 的）', withPending.cwd)
    ok(withPending.active === false, '有待激活目标时仍不算已激活')

    const noPendingStillInactive = deriveWorkspaceOwner({ ...base, pendingActivation: null })
    ok(noPendingStillInactive.active === false && noPendingStillInactive.cwd === '', '无 pending 仍 inactive、cwd 空')

    const idPeek = deriveWorkspaceOwner({
      ...base,
      peekedSessionId: 'sess-b',
      sessions: [{ id: 'sess-b', path: B, cwd: 'C:/proj/b' }]
    })
    ok(idPeek.sessionId === 'sess-b' && idPeek.cwd === 'C:/proj/b' && idPeek.active === false, '有 id 的 peek 正常：按会话摘要取 B 的 cwd', idPeek)

    const activated = deriveWorkspaceOwner({
      ...base,
      peekedSessionId: 'sess-b',
      activeRunnerId: 'run-b',
      runners: [...runnersA, { id: 'run-b', runId: 'run-b', sessionId: 'sess-b', sessionFile: B, cwd: 'C:/proj/b', generation: 1, isActive: true }]
    })
    ok(activated.active === true && activated.cwd === 'C:/proj/b' && activated.runId === 'run-b', 'B 的运行实例匹配视图后，归属转为已激活', activated)

    ok(JSON.stringify(viewIdentity(base)) === JSON.stringify({ sessionId: null, sessionFile: B }), 'ownership.viewIdentity 与实际身份成对一致')
  }

  /* ======================================== 组 3：真实 store 的同步归属 */
  group('真实 store：path-only B 铺上后，旧 A sync 不覆盖；B 激活后能接住自己的消息')
  {
    const { yan, calls, pending } = makeYan({
      peek: () => ({ messages: [{ id: 'm-b1', role: 'user', text: 'B history' }], sessionId: undefined, truncated: 0, total: 1 })
    })
    globalThis.window = { yan, addEventListener: () => {}, removeEventListener: () => {}, location: { href: 'http://localhost/' } }

    resetStore(useStore)

    pending.select = defer()
    const switching = useStore.getState().switchSession(B)
    await flush()
    /* 宿主只读预览：没有反悔出正式 sessionId（path-only） */
    pending.select.resolve({ ok: true, deferred: true })
    await switching
    await flush()
    pending.select = null

    let state = useStore.getState()
    ok(state.peekedPath === B, 'switchSession 后视图铺上 B 的路径', state.peekedPath)
    ok(state.peekedSessionId === null, '旧读取器没给 id：peekedSessionId 为空，不补 A', state.peekedSessionId)
    ok(state.pendingActivation?.sessionFile === B, '登记了 B 的待激活目标', state.pendingActivation)
    ok(state.messages[0]?.text === 'B history', 'peek 的内容已经铺在视图上')
    ok(viewingSubmitSessionId(state) === null, '提交归属为未知（null），不借 A 的 sessionId', viewingSubmitSessionId(state))

    const ownerBefore = deriveWorkspaceOwner(ownerInput(state))
    ok(ownerBefore.sessionId === null && ownerBefore.active === false, '归属仍未激活、不冒充 A', ownerBefore)
    ok(ownerBefore.key === keyB, '归属键仍是 B', ownerBefore.key)

    /* A 迟到的权威 sync：routePush 会放行（viewing 仍回落到 A），store 守卫必须挡下 */
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 },
      payload: [{ id: 'm-a2', role: 'assistant', text: 'A late sync' }]
    })
    state = useStore.getState()
    ok(state.messages[0]?.text === 'B history', 'A 迟到的 sync 没有覆盖 B', state.messages.map((m) => m.text))
    ok(state.peekedPath === B && state.peekedSessionId === null, '视图仍停在 B（peek 未被清）', { p: state.peekedPath, id: state.peekedSessionId })

    /* 正式激活 B：宿主给出正式 id → 视图身份成对补上，可继续接收 B 的消息 */
    pending.select = defer()
    const activating = useStore.getState().ensureActivated()
    await flush()
    ok(calls.selectSession.at(-1)?.sessionFile === B, 'ensureActivated 向宿主请求激活 B', calls.selectSession.at(-1))
    pending.select.resolve({ ok: true, sessionId: 'sess-b', runId: 'run-b' })
    ok((await activating) === true, 'B 正式激活成功')
    await flush()
    pending.select = null
    state = useStore.getState()
    ok(state.pendingActivation === null, '激活成功后清掉待激活目标')
    ok(state.peekedSessionId === 'sess-b', '正式 id 成对补上，视图身份不再是 path-only', state.peekedSessionId)
    ok(viewingSubmitSessionId(state) === 'sess-b', '提交归属跟随正式 B 的 id', viewingSubmitSessionId(state))

    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'sess-b', runId: 'run-b', generation: 0 },
      payload: [{ id: 'm-b2', role: 'assistant', text: 'B live' }]
    })
    state = useStore.getState()
    ok(state.messages[0]?.text === 'B live', 'B 激活后的权威 sync 被接收', state.messages.map((m) => m.text))
    ok(state.peekedPath === null && state.peekedSessionId === null, '收到 B 的权威 sync 后正常退出 peek', { p: state.peekedPath, id: state.peekedSessionId })
  }

  /* ======================================= 组 4：常规路径不回退 */
  group('真实 store：无 peek / 有 id 的 peek 常规行为不变')
  {
    const { yan } = makeYan()
    globalThis.window = { yan, addEventListener: () => {}, removeEventListener: () => {}, location: { href: 'http://localhost/' } }

    resetStore(useStore)
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 },
      payload: [{ id: 'm-a3', role: 'assistant', text: 'A normal' }]
    })
    ok(useStore.getState().messages[0]?.text === 'A normal', '无 peek：当前会话的 sync 正常投影')

    resetStore(useStore, {
      peekedSessionId: 'sess-b',
      peekedPath: B,
      activeRunnerId: 'run-b',
      runners: [{ id: 'run-b', runId: 'run-b', sessionId: 'sess-b', sessionFile: B, cwd: 'C:/proj/b', generation: 0, isActive: true }],
      messages: [{ id: 'm-b0', role: 'user', text: 'B peek' }]
    })
    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'sess-a', runId: 'run-a', generation: 0 },
      payload: [{ id: 'm-a4', role: 'assistant', text: 'A must not' }]
    })
    ok(useStore.getState().messages[0]?.text === 'B peek', '有 id 的 peek：A 的 sync 被挡（既有行为保持）')

    useStore.getState().applyPush({
      ch: 'sync',
      runtime: { sessionId: 'sess-b', runId: 'run-b', generation: 0 },
      payload: [{ id: 'm-b5', role: 'assistant', text: 'B sync' }]
    })
    ok(useStore.getState().messages[0]?.text === 'B sync', '有 id 的 peek：B 的 sync 正常收下')
    ok(useStore.getState().peekedSessionId === null && useStore.getState().peekedPath === null, '收下后清掉 peek 标记')

    const pureSubmit = viewingSubmitSessionId({ peekedSessionId: 'sess-b', peekedPath: B, session: { sessionId: 'sess-a' } })
    ok(pureSubmit === 'sess-b', '有 id 的 peek：提交归属取 B', pureSubmit)
    ok(viewingSubmitSessionId({ peekedSessionId: null, peekedPath: null, session: { sessionId: 'sess-a' } }) === 'sess-a', '无 peek：提交归属取当前会话')
    ok(viewingSubmitSessionId({ peekedSessionId: null, peekedPath: B, session: { sessionId: 'sess-a' } }) === null, 'path-only：提交归属不借 A')
  }

  await rm(outdir, { recursive: true, force: true })

  process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
  if (report.fail > 0) process.exitCode = 1
}

main().catch((err) => {
  process.stderr.write(`\n[运行失败] ${err && err.stack ? err.stack : err}\n`)
  process.exitCode = 1
})
