/**
 * 切会话时用量（stats）不串会话的回归。
 *
 * 缺陷本体：`stats` 是会话级事实，但切会话只清了 goal / handoff。于是
 *   · 只读预览（deferred）永远等不到新 stats，旧会话的大额累计一直留在屏幕上，
 *     看起来像刚点开的小会话自己花了这么多；
 *   · `peekSession` / `selectSession` 都要 await，这段间隙里旧实例（可能正被复用
 *     到新会话）迟到的 stats 会被 routePush 当成当前视图的推送投影上来。
 *
 * 修法：点新会话时**同步**清 stats 并把 `peekedSessionId` 提前钉到新会话，让
 * routePush 的 belongsToView 判定在间隙里就能拒绝旧身份；权威 runtime 快照到达
 * 后仍按 projectSnapshot 逻辑把新 stats 接回。
 *
 * 这里把渲染端 store 单独 bundle 出来，用全局桩替代 `window.yan` / localStorage /
 * requestAnimationFrame，真实走 applyPush → routePush → 顶层投影：不开 Electron、
 * 不连接 pi、不读真实会话。
 */
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const OLD_STATS = {
  tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 999999 },
  cost: 42,
  toolCalls: 30,
  userMessages: 30,
  assistantMessages: 30
}

const stats = (total) => ({ ...OLD_STATS, tokens: { ...OLD_STATS.tokens, total } })

export async function runSessionStatsIsolationTests(ok) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const savedGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  }

  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  /* 同步执行：store 里嵌套了两层 rAF，异步实现会在测试收尾之后才触发。 */
  globalThis.requestAnimationFrame = (fn) => {
    fn(0)
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }

  const peekDelays = new Map()
  const sessionIdFor = (path) => (path === 'A' ? 'sess-a' : path === 'B' ? 'sess-b' : path)
  let runnerStatusList = []

  const yan = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'peekSession') {
          return async (path) => {
            await sleep(peekDelays.get(path) ?? 0)
            return {
              messages: [{ id: `msg-${path}`, role: 'user', text: path }],
              sessionId: sessionIdFor(path),
              truncated: 0,
              total: 1
            }
          }
        }
        if (prop === 'selectSession') {
          return async (target) => {
            /* sessionFile 存在 = 只读预览：pi 侧不激活，不会有新 stats */
            if (target.sessionFile) return { ok: true, deferred: true, sessionId: target.sessionId }
            return { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
          }
        }
        if (prop === 'newSession') {
          return async () => ({ ok: true, id: 'run-new', runId: 'run-new', sessionId: 'sess-new' })
        }
        if (prop === 'runnerStatuses') return async () => runnerStatusList
        if (prop === 'listSessions') return async () => []
        if (prop === 'listModels') return async () => []
        if (prop === 'listThinkingLevels') return async () => []
        if (prop === 'listCommands') return async () => []
        if (prop === 'getGoal') return async () => ({ goal: null })
        /* 其余宿主能力：返回空实现，本测试不依赖它们的具体行为 */
        return async () => undefined
      }
    }
  )
  globalThis.window = {
    yan,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' }
  }

  const temp = await mkdtemp(join(tmpdir(), 'yan-session-stats-'))
  const outfile = join(temp, 'store.mjs')
  await build({
    entryPoints: ['src/renderer/src/state/store.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    define: {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    }
  })
  const { useStore } = await import(pathToFileURL(outfile).href)

  const sessions = [
    { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' },
    { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' }
  ]

  const resetView = (overrides = {}) => useStore.setState({
    sessions,
    settings: { cwd: 'C:/proj', projects: [] },
    session: { sessionId: 'sess-a', cwd: 'C:/proj' },
    messages: [{ id: 'mA', role: 'user', text: 'A' }],
    stats: OLD_STATS,
    runners: [{ id: 'r1', runId: 'r1', generation: 1, sessionId: 'sess-a', isActive: true }],
    activeRunnerId: 'r1',
    sessionRuntimes: {},
    peekedPath: 'A',
    peekedSessionId: 'sess-a',
    peekNote: null,
    pendingActivation: null,
    goal: null,
    handoff: null,
    notices: [],
    ...overrides
  })

  try {
    /* ---- 1. 只读预览（deferred）没有新 stats：不残留旧会话累计 ---- */
    runnerStatusList = []
    resetView()
    await useStore.getState().switchSession('B')
    {
      const st = useStore.getState()
      ok(st.stats === null, 'preview（deferred）没有新 stats 时不残留旧会话用量', st.stats?.tokens?.total)
      ok(st.pendingActivation?.sessionFile === 'B', 'preview 记下待激活目标')
      ok(st.messages[0]?.id === 'msg-B', 'preview 正常铺上新会话内容', st.messages[0]?.id)
    }

    /* ---- 2. await 间隙里旧实例的 stats 不能投影到当前视图 ---- */
    runnerStatusList = []
    resetView()
    peekDelays.set('B', 80)
    {
      const pending = useStore.getState().switchSession('B')
      const mid = useStore.getState()
      ok(mid.stats === null, '点击新会话后同步清空 stats', mid.stats?.tokens?.total)
      ok(mid.peekedSessionId === 'sess-b', '点击新会话后同步钉住新 peek 身份', mid.peekedSessionId)
      /* 这段间隙里，旧会话（同一 runId 可能已被复用到新会话）迟到的 stats 到达 */
      useStore.getState().applyPush({
        ch: 'stats',
        runtime: { sessionId: 'sess-a', runId: 'r1', projectId: 'C:/proj', generation: 1 },
        payload: stats(999999)
      })
      ok(useStore.getState().stats === null, '间隙内旧会话 runtime stats 不投影到当前视图', useStore.getState().stats?.tokens?.total)
      await pending
      ok(useStore.getState().stats === null, '切会话收尾后仍无旧 stats', useStore.getState().stats?.tokens?.total)
      /* 旧会话自己的缓存必须保留，切回去还能用（不能为了清顶层而清缓存） */
      ok(useStore.getState().sessionRuntimes['sess-a']?.stats?.tokens?.total === 999999, '旧会话自己的缓存 stats 保留，未被误清')
    }
    peekDelays.delete('B')

    /* ---- 3. 新会话的 runtime stats 正常投影 ---- */
    resetView({ session: { sessionId: 'sess-b' }, peekedSessionId: 'sess-b', peekedPath: null, stats: null })
    useStore.getState().applyPush({
      ch: 'stats',
      runtime: { sessionId: 'sess-b', runId: 'r1', projectId: 'C:/proj', generation: 1 },
      payload: stats(7)
    })
    ok(useStore.getState().stats?.tokens?.total === 7, '新会话的 runtime stats 正常投影到当前视图', useStore.getState().stats?.tokens?.total)

    /* ---- 4. 权威 runtime 快照（runners 投影）仍把新 stats 接回 ---- */
    const snapshotB = {
      runtime: { sessionId: 'sess-b', runId: 'r1', projectId: 'C:/proj', generation: 1 },
      session: null,
      messages: [],
      stats: stats(11),
      queue: { steering: [], followUp: [] },
      todos: [],
      todoHistory: [],
      uiRequests: [],
      statuses: {},
      widgets: {},
      goal: null,
      draft: '',
      models: [],
      thinkingLevels: [],
      commands: [],
      workMode: null,
      agentProfile: null
    }
    resetView({
      session: { sessionId: 'sess-b' },
      peekedSessionId: 'sess-b',
      peekedPath: null,
      stats: null,
      sessionRuntimes: { 'sess-b': snapshotB }
    })
    runnerStatusList = [{ id: 'r1', runId: 'r1', generation: 1, sessionId: 'sess-b', isActive: true }]
    await useStore.getState().syncRunners()
    ok(useStore.getState().stats?.tokens?.total === 11, '权威 runtime 快照把新会话 stats 接回', useStore.getState().stats?.tokens?.total)
    runnerStatusList = []

    /* ---- 5. newSession 是会话级重置：旧用量不跟过去 ---- */
    resetView()
    await useStore.getState().newSession({ scope: 'global' })
    ok(useStore.getState().stats === null, 'newSession 清掉上一条会话的用量', useStore.getState().stats?.tokens?.total)
    ok(useStore.getState().messages.length === 0, 'newSession 同时清空消息', useStore.getState().messages.length)

    /* ---- 6. 托盘无路径选择会话：没有缓存快照时也要清旧用量 ---- */
    resetView()
    useStore.getState().applyPush({ ch: 'tray-select-session', payload: { sessionId: 'tray-b', cwd: 'C:/proj' } })
    await sleep(30)
    ok(useStore.getState().stats === null, '托盘无路径选择会话时清掉旧用量', useStore.getState().stats?.tokens?.total)

    await sleep(30)
  } finally {
    for (const [key, value] of Object.entries(savedGlobals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}

async function main() {
  let pass = 0
  let fail = 0
  const ok = (cond, label, actual) => {
    if (cond) {
      pass += 1
      console.log(`  ✓ ${label}`)
    } else {
      fail += 1
      console.error(`  ✗ ${label}${actual === undefined ? '' : `（实际：${String(actual)}）`}`)
    }
  }
  await runSessionStatsIsolationTests(ok)
  console.log(`\n会话 stats 隔离：${pass} 通过 / ${fail} 失败`)
  if (fail) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
