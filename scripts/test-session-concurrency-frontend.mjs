/**
 * 会话并发前端回归（渲染端身份 + 实时投影）。
 *
 * 覆盖用户报的两条现象与主审补的三处边界：
 *   · 同项目新建会话仍显示「生成中」——`newSession` 没清 `session` / 旧 `peeked` 身份，
 *     旧身份把新会话的推送挡在了归属判定之外；
 *   · 新建响应晚于新会话的 state/sync 到达时，响应不能把已经收到的状态清掉；
 *   · 切回正在运行的会话界面不更新——切回时只铺了消息，没恢复 `session` 实时状态；
 *     而且只读预览不会把该实例设成 active，`routePush` 会把它的实时帧当成后台帧丢掉；
 *   · peek 文件历史落后于流式缓存时不能删掉流式尾部，也不能用旧缓存覆盖较新的历史；
 *   · `queue-reclaimed` 收回的后台会话队列快照要清掉，否则草稿与缓存队列重复。
 *
 * 不启动 Electron、不连接 pi：用全局桩替代 `window.yan` / localStorage / rAF，
 * 把 store 单独 bundle 出来直接驱动真实状态机；push-routing 的纯函数另跑一组。
 *
 * 导出 `runSessionConcurrencyFrontendTests(ok)` 供 `test-unit.mjs` 接线；
 * 直接 `node scripts/test-session-concurrency-frontend.mjs` 也能独立运行。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await sleep(0)
}

export async function runSessionConcurrencyFrontendTests(ok) {
  const section = (name) => console.log(`\n## ${name}`)

  /* 保存现场：别的定向脚本 / 测试进程可能已经装过同名全局 */
  const savedGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  }
  /* 新版 Node 的 `navigator` 只有 getter，不能直接写回；只在原本没有时才补，并记录 */
  const hadNavigator = typeof globalThis.navigator !== 'undefined'

  /* ---------------- 渲染端全局桩 ---------------- */
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
  /* 同步执行：store 里嵌套两层 rAF，异步桩会在脚本收尾后迟到。 */
  globalThis.requestAnimationFrame = (fn) => {
    fn(0)
    return 0
  }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
  if (!hadNavigator) globalThis.navigator = { userAgent: 'node' }

  /* ---------------- 宿主 mock ---------------- */
  const calls = []
  const host = {
    sessions: [],
    newSessionDelay: 0,
    newSessionResult: { ok: true, id: 'r-new', runId: 'r-new', sessionId: 'sess-new', generation: 1 },
    peekDelays: new Map(),
    peekResults: new Map(),
    selectDelays: new Map(),
    selectDeferred: true,
    sessionIdFor: { A: 'sess-a', B: 'sess-b' },
    /* 运行实例状态：默认空，避免 syncRunners 抢改 activeRunnerId 干扰断言 */
    runnerStatuses: []
  }

  const defaultPeek = (path) => ({
    messages: [{ id: `msg-${path}`, role: 'user', text: path, timestamp: 1 }],
    sessionId: host.sessionIdFor[path] ?? path,
    truncated: 0,
    total: 1
  })

  const yan = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'peekSession') {
          return async (path) => {
            calls.push(`peek:${path}`)
            await sleep(host.peekDelays.get(path) ?? 0)
            return host.peekResults.get(path) ?? defaultPeek(path)
          }
        }
        if (prop === 'selectSession') {
          return async (target) => {
            calls.push(`select:${target.sessionFile ?? target.sessionId}`)
            await sleep(host.selectDelays.get(target.sessionId) ?? 0)
            if (host.selectDeferred) return { ok: true, deferred: true, sessionId: target.sessionId }
            return { ok: true, runId: `run-${target.sessionId}`, sessionId: target.sessionId }
          }
        }
        if (prop === 'newSession') {
          return async (target) => {
            calls.push(`new:${target?.scope ?? ''}`)
            await sleep(host.newSessionDelay)
            return { ...host.newSessionResult }
          }
        }
        if (prop === 'listSessions') return async () => host.sessions
        if (prop === 'runnerStatuses') return async () => host.runnerStatuses
        if (prop === 'listModels' || prop === 'listThinkingLevels' || prop === 'listCommands') return async () => []
        if (prop === 'getGoal') return async () => ({ goal: null })
        /* 会显式记录停止类调用：切换会话不允许停任何实例 */
        if (prop === 'stopRunner' || prop === 'abort' || prop === 'abortSession' || prop === 'stop') {
          return async (...args) => {
            calls.push(`${String(prop)}:${JSON.stringify(args)}`)
            return { ok: true }
          }
        }
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

  /* ---------------- 构建 ---------------- */
  const temp = await mkdtemp(join(tmpdir(), 'yan-session-concurrency-'))
  async function bundle(entry, name, define) {
    const outfile = join(temp, name)
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      logLevel: 'silent',
      define
    })
    return import(pathToFileURL(outfile).href)
  }

  try {
    const routing = await bundle('src/renderer/src/state/push-routing.ts', 'push-routing.mjs')
    const { useStore, mergePeekedHistory } = await bundle('src/renderer/src/state/store.ts', 'store.mjs', {
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      requestAnimationFrame: 'globalThis.requestAnimationFrame',
      cancelAnimationFrame: 'globalThis.cancelAnimationFrame'
    })

    /* ---------------- push-routing 纯逻辑 ---------------- */
    section('push-routing：谁的帧能改当前视图')
    {
      const runtimeA = { sessionId: 'sess-a', runId: 'r1', projectId: 'p', generation: 3 }
      const runtimeB = { sessionId: 'sess-b', runId: 'r2', projectId: 'p', generation: 1 }
      const frame = (runtime, ch = 'state') => ({
        ch,
        runtime,
        payload:
          ch === 'state'
            ? { sessionId: runtime.sessionId, isAgentRunning: true }
            : { id: 'x', role: 'assistant', text: 'x' }
      })
      const base = {
        runners: [
          { id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 3, isActive: false },
          { id: 'r2', runId: 'r2', sessionId: 'sess-b', generation: 1, isActive: true }
        ],
        activeRunnerId: 'r2',
        sessionRuntimes: {},
        peekedSessionId: 'sess-a',
        peekedPath: 'A',
        session: { sessionId: 'sess-a' },
        visibleSessionIds: []
      }

      const viewed = routing.routePush(base, frame(runtimeA))
      ok(
        viewed.project === true && !!viewed.patch?.sessionRuntimes?.['sess-a'],
        '正在看的后台会话（active 是另一个实例）的实时帧仍然投影，并写缓存',
        JSON.stringify(viewed)
      )

      const other = routing.routePush(base, frame(runtimeB))
      ok(
        other.project === false && !!other.patch?.sessionRuntimes?.['sess-b'],
        '别的会话的帧只进缓存，不改当前视图',
        JSON.stringify(other)
      )

      const pendingPath = routing.routePush(
        { ...base, peekedSessionId: null, session: null },
        frame(runtimeA)
      )
      ok(
        pendingPath.project === false && !!pendingPath.patch?.sessionRuntimes?.['sess-a'],
        '只有路径、身份还没落定时不投影任何带身份的帧（先缓存）',
        JSON.stringify(pendingPath)
      )

      const stale = routing.routePush(base, frame({ ...runtimeA, generation: 2 }))
      ok(stale.project === false && stale.patch === null, '比当前实例更旧的代次直接丢弃')

      const reused = routing.routePush(
        { ...base, peekedSessionId: 'sess-b', session: { sessionId: 'sess-b' } },
        frame(runtimeA)
      )
      ok(reused.project === false, '实例被复用到别的新会话时，旧会话迟到的帧不投影')
    }

    /* ---------------- store：状态工厂 ---------------- */
    const EMPTY_QUEUE = { steering: [], followUp: [] }
    const msg = (id, text = id) => ({ id, role: 'assistant', text, timestamp: 1 })
    const statePayload = (sessionId, running, file) => ({
      sessionId,
      sessionFile: file,
      cwd: 'C:/proj',
      isAgentRunning: running,
      isStreaming: running,
      isCompacting: false,
      availableThinkingLevels: []
    })
    const snapshot = (sessionId, { runId = `run-${sessionId}`, generation = 1, session = null, messages = [], queue = EMPTY_QUEUE } = {}) => ({
      runtime: { sessionId, runId, generation },
      session,
      messages,
      stats: null,
      queue,
      todos: [],
      todoHistory: [],
      uiRequests: [],
      statuses: {},
      widgets: {},
      widgetPlacements: {},
      draft: '',
      workMode: null,
      agentProfile: null,
      goal: null,
      models: [],
      thinkingLevels: [],
      commands: [],
      touchedAt: 1
    })

    const sessionA = { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' }
    const sessionB = { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' }

    function resetView(overrides = {}) {
      host.sessions = [sessionA, sessionB]
      host.peekDelays.clear()
      host.peekResults.clear()
      host.selectDelays.clear()
      host.selectDeferred = true
      host.newSessionDelay = 0
      host.runnerStatuses = []
      calls.length = 0
      useStore.setState({
        sessions: [sessionA, sessionB],
        settings: { cwd: 'C:/proj', projects: [] },
        session: null,
        messages: [],
        activeRunnerId: null,
        runners: [],
        sessionRuntimes: {},
        peekedPath: null,
        peekedSessionId: null,
        peekNote: null,
        pendingActivation: null,
        queue: EMPTY_QUEUE,
        todos: [],
        todoHistory: [],
        uiRequests: [],
        statuses: {},
        widgets: {},
        widgetPlacements: {},
        workMode: null,
        agentProfile: null,
        goal: null,
        handoff: null,
        stats: null,
        notices: [],
        ...overrides
      })
    }

    /* ---------------- 场景 1：A 正在跑 → 新建 B ---------------- */
    section('运行 A → 新建 B：旧身份/旧状态必须一起清掉')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r1',
        runners: [{ id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: true }],
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('a1')]
          })
        }
      })
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2' }

      const made = await useStore.getState().newSession({ cwd: 'C:/proj' })
      await settle()
      const after = useStore.getState()
      ok(made.ok === true && made.runId === 'r2', '新建返回新实例身份')
      ok(after.session === null, '新建后清空上一条会话的状态（不再显示「生成中」）', JSON.stringify(after.session))
      ok(after.peekedSessionId === null && after.peekedPath === null, '新建后清空旧视图身份（不再挡新会话推送）')
      ok(after.messages.length === 0, '新建后消息清空')
      ok(after.activeRunnerId === 'r2', '新建后对齐新实例 id', after.activeRunnerId)

      /* 新会话的第一帧必须能投影上来 */
      useStore.getState().applyPush({
        ch: 'state',
        runtime: { sessionId: 'sess-b', runId: 'r2', generation: 1 },
        payload: statePayload('sess-b', false, 'B')
      })
      const b = useStore.getState()
      ok(b.session?.sessionId === 'sess-b' && b.session?.isAgentRunning === false, '新会话状态能投影，不再被旧身份挡掉', JSON.stringify(b.session))

      /* 旧会话迟到的帧只能进缓存 */
      useStore.getState().applyPush({
        ch: 'msg-add',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 2 },
        payload: msg('a-late')
      })
      const late = useStore.getState()
      ok(!late.messages.some((m) => m.id === 'a-late'), '旧会话迟到帧不覆盖新会话视图')
      ok(
        (late.sessionRuntimes['sess-a']?.messages ?? []).some((m) => m.id === 'a-late'),
        '旧会话迟到帧继续进各自缓存'
      )
    }

    /* ---------------- 场景 1b：新会话 state/sync 早于 IPC 响应到达 ---------------- */
    section('新建响应前已收到新会话 state/sync：响应不能清掉')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r1',
        runners: [{ id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: true }],
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('a1')]
          })
        }
      })
      /* 主进程先 pushRunnerSnapshot 再返回响应：这里模拟响应之前帧先到 */
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2', sessionId: 'sess-b', generation: 1 }
      host.newSessionDelay = 60

      const created = useStore.getState().newSession({ cwd: 'C:/proj' })
      await sleep(10)
      useStore.getState().applyPush({
        ch: 'state',
        runtime: { sessionId: 'sess-b', runId: 'r2', generation: 1 },
        payload: statePayload('sess-b', true, 'B')
      })
      useStore.getState().applyPush({
        ch: 'sync',
        runtime: { sessionId: 'sess-b', runId: 'r2', generation: 1 },
        payload: [msg('b-live')]
      })
      const made = await created
      await settle()
      const view = useStore.getState()
      ok(made.ok === true && made.sessionId === 'sess-b', '新建结果按实返回新会话身份')
      ok(
        view.session?.sessionId === 'sess-b' && view.session?.isAgentRunning === true,
        '响应不清掉响应前已到的新会话状态（不再等一条可能不来的推送）',
        JSON.stringify(view.session)
      )
      ok(view.messages.some((m) => m.id === 'b-live'), '响应不清掉响应前已到的新会话消息', JSON.stringify(view.messages))
      ok(view.activeRunnerId === 'r2', '响应把运行身份对齐到新实例', view.activeRunnerId)

      /* 已经铺上的消息仍能接收按 id 的增量补丁 */
      useStore.getState().applyPush({
        ch: 'msg-update',
        runtime: { sessionId: 'sess-b', runId: 'r2', generation: 1 },
        payload: { id: 'b-live', patch: { textDelta: '!' } }
      })
      ok(
        useStore.getState().messages.find((m) => m.id === 'b-live')?.text === 'b-live!',
        '响应后按 id 的补丁仍能落到已铺上的消息'
      )
    }

    /* ---------------- 场景 1c：复用运行实例时要核对代次 ---------------- */
    section('新建复用运行实例：不能把旧会话快照当成本次结果')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r0',
        /* `run:r2` 是同一实例上一次服务 sess-old 留下的缓存（代次 1） */
        sessionRuntimes: {
          'run:r2': snapshot('sess-old', {
            runId: 'r2',
            generation: 1,
            session: { sessionId: 'sess-old', sessionFile: 'old', cwd: 'C:/proj', isAgentRunning: false },
            messages: [msg('old-msg')]
          })
        }
      })
      /* 响应没给 sessionId，且实例已被复用（generation 2）：不能投影代次 1 的旧快照 */
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2', generation: 2 }
      await useStore.getState().newSession({ cwd: 'C:/proj' })
      await settle()
      const view = useStore.getState()
      ok(!view.messages.some((m) => m.id === 'old-msg'), '复用实例时旧会话快照不被当成本次新建内容', JSON.stringify(view.messages))
      ok(view.session === null, '复用实例且新帧未到时保持空白，不显示旧会话状态')
      ok(view.activeRunnerId === 'r2', '运行身份仍对齐到目标实例')
    }

    /* ---------------- 场景 1d：响应缺 generation 时不按 runId 认旧快照 ---------------- */
    section('新建缺 generation：sessionId 未命中时不能用同 runId 兜底')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r0',
        sessionRuntimes: {
          'run:r2': snapshot('sess-old', {
            runId: 'r2',
            generation: 1,
            session: { sessionId: 'sess-old', sessionFile: 'old', cwd: 'C:/proj', isAgentRunning: false },
            messages: [msg('old-msg')]
          })
        }
      })
      /* 响应给了 sessionId / runId 但没给 generation，且缓存里没有 'sess-new' */
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2', sessionId: 'sess-new' }
      const made = await useStore.getState().newSession({ cwd: 'C:/proj' })
      await settle()
      const view = useStore.getState()
      ok(made.ok === true && made.sessionId === 'sess-new', '新建结果按实返回新会话身份')
      ok(
        !view.messages.some((m) => m.id === 'old-msg'),
        'generation 缺失时不能把同 runId 的旧快照当新会话内容',
        JSON.stringify(view.messages)
      )
      ok(view.session === null, 'generation 缺失且 sessionId 未命中时保持空白')
    }

    /* ---------------- 场景 1e：sessionId / generation 都缺时不能凭 runId 认旧快照 ---------------- */
    section('新建缺 sessionId / generation：不能凭 runId 认旧快照')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r0',
        sessionRuntimes: {
          'run:r2': snapshot('sess-old', {
            runId: 'r2',
            generation: 1,
            session: { sessionId: 'sess-old', sessionFile: 'old', cwd: 'C:/proj', isAgentRunning: false },
            messages: [msg('old-msg')]
          })
        }
      })
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2' }
      await useStore.getState().newSession({ cwd: 'C:/proj' })
      await settle()
      const view = useStore.getState()
      ok(
        !view.messages.some((m) => m.id === 'old-msg'),
        '同时缺 sessionId / generation 时不认缓存里的同 runId 旧快照',
        JSON.stringify(view.messages)
      )
      ok(view.session === null, '缺身份信息时保持空白，不显示旧会话状态')
    }

    /* ---------------- 场景 1f：generation 明确时支持 pending→uuid 同代匹配 ---------------- */
    section('新建 generation 明确：支持 pending→uuid 同代匹配')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r0',
        sessionRuntimes: {
          'pending:r2': snapshot('pending:r2', {
            runId: 'r2',
            generation: 3,
            session: { sessionId: 'pending:r2', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('b-live')]
          })
        }
      })
      /* 响应给真实 uuid，缓存里是 pending:<runId>：同一实例同一代就是这条新会话 */
      host.newSessionResult = { ok: true, id: 'r2', runId: 'r2', sessionId: 'sess-new', generation: 3 }
      await useStore.getState().newSession({ cwd: 'C:/proj' })
      await settle()
      const view = useStore.getState()
      ok(
        view.messages.some((m) => m.id === 'b-live'),
        'generation 一致时按 runId 找回 pending→uuid 的新会话快照',
        JSON.stringify(view.messages)
      )
      ok(view.session?.isAgentRunning === true, '找回的快照状态一并投影', JSON.stringify(view.session))
    }

    /* ---------------- 场景 2：切回后台正在跑的 A ---------------- */
    section('切回后台在跑的 A：立刻恢复实时状态并继续更新')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false, isStreaming: false },
        messages: [msg('b1')],
        activeRunnerId: 'r2',
        runners: [
          { id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: false, running: true },
          { id: 'r2', runId: 'r2', sessionId: 'sess-b', generation: 1, isActive: true, running: false }
        ],
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('a-live')]
          })
        }
      })

      await useStore.getState().switchSession('A')
      await settle()
      const view = useStore.getState()
      ok(view.peekedSessionId === 'sess-a', '切回后视图身份钉到 A', view.peekedSessionId)
      ok(
        view.session?.sessionId === 'sess-a' && view.session?.isAgentRunning === true,
        '切回后立刻从缓存恢复 A 的实时运行状态（不再停在旧状态）',
        JSON.stringify(view.session)
      )
      ok(view.pendingActivation?.sessionFile === 'A', '只读预览记为待激活目标，等待发消息时再激活')
      ok(
        calls.every((call) => !/^(stopRunner|abort|abortSession)$/.test(call.split(':')[0])),
        '切换过程没有停止任何旧会话',
        calls.join(',')
      )

      /* 正在看的这条后台会话的完成帧要更新界面 */
      useStore.getState().applyPush({
        ch: 'state',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 2 },
        payload: statePayload('sess-a', false, 'A')
      })
      const finished = useStore.getState()
      ok(
        finished.session?.sessionId === 'sess-a' && finished.session?.isAgentRunning === false,
        '正在看的后台会话的完成帧会更新界面，不会永远停在「生成中」'
      )

      /* 别的会话（active 的 B）的帧不能改当前视图 */
      useStore.getState().applyPush({
        ch: 'state',
        runtime: { sessionId: 'sess-b', runId: 'r2', generation: 1 },
        payload: statePayload('sess-b', true, 'B')
      })
      const isolated = useStore.getState()
      ok(
        isolated.session?.sessionId === 'sess-a' && isolated.session?.isAgentRunning === false,
        '别的会话的帧只进缓存，不改当前视图'
      )
      ok(
        isolated.sessionRuntimes['sess-b']?.session?.isAgentRunning === true,
        '别的会话的实时状态落进自己的缓存'
      )
    }

    /* ---------------- 场景 3：缓存先铺、peek 历史后到 ---------------- */
    section('缓存与历史竞态：peek 历史不能删掉流式尾部')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false },
        messages: [msg('b1')],
        activeRunnerId: 'r2',
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('cache-a')]
          })
        }
      })
      host.peekDelays.set('A', 60)
      const pending = useStore.getState().switchSession('A')
      /* await 之前就应该已经铺上缓存，不等文件读取 */
      const immediate = useStore.getState()
      ok(immediate.messages[0]?.id === 'cache-a', '切换瞬间先铺运行缓存的消息', immediate.messages[0]?.id)
      ok(immediate.session?.sessionId === 'sess-a', '缓存里的会话状态同时切换', JSON.stringify(immediate.session))
      await pending
      await settle()
      const afterPeek = useStore.getState()
      ok(afterPeek.messages[0]?.id === 'msg-A', 'peek 文件历史铺在骨架（前面）', afterPeek.messages[0]?.id)
      ok(
        afterPeek.messages.some((m) => m.id === 'cache-a'),
        'peek 不删掉同时存在于缓存里的消息（内存更新要保住）',
        JSON.stringify(afterPeek.messages)
      )
    }

    /* ---------------- 场景 4：await peek 期间增量发生 ---------------- */
    section('await peek 期间流式增量：后续按 id 的补丁仍有落点')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false },
        messages: [msg('b1')],
        activeRunnerId: 'r2',
        runners: [
          { id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: false, running: true },
          { id: 'r2', runId: 'r2', sessionId: 'sess-b', generation: 1, isActive: true, running: false }
        ],
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('m-user'), msg('m-live', 'hel')]
          })
        }
      })
      /* 文件还没写完，只到 m-user；内存里已经有正在流式的 m-live */
      host.peekResults.set('A', { messages: [msg('m-user')], sessionId: 'sess-a', truncated: 0, total: 1 })
      host.peekDelays.set('A', 60)

      const pending = useStore.getState().switchSession('A')
      await sleep(10)
      /* await 期间流式增量到达（timestamp 不变，只有文本变长） */
      useStore.getState().applyPush({
        ch: 'msg-update',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 2 },
        payload: { id: 'm-live', patch: { textDelta: 'lo' } }
      })
      await pending
      await settle()
      const view = useStore.getState()
      ok(
        view.messages.find((m) => m.id === 'm-live')?.text === 'hello',
        'peek 不能让文件里的半截覆盖内存里更完整的流式版本',
        JSON.stringify(view.messages)
      )
      /* 后续按 id 的补丁必须还有落点 */
      useStore.getState().applyPush({
        ch: 'msg-update',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 2 },
        payload: { id: 'm-live', patch: { textDelta: '!' } }
      })
      ok(
        useStore.getState().messages.find((m) => m.id === 'm-live')?.text === 'hello!',
        'peek 之后按 id 的补丁仍能落到流式消息上'
      )
    }

    /* ---------------- 场景 4b：只含用户历史的权威 sync 不能删掉流式尾部 ---------------- */
    section('权威 sync 只有用户历史：保住正在流式的助手尾部')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [{ id: 'm-user', role: 'user', text: 'u', timestamp: 1 }, msg('m-live', '已流式两百多字')],
        activeRunnerId: 'r1',
        runners: [{ id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: true }]
      })
      const runtime = { sessionId: 'sess-a', runId: 'r1', generation: 2 }
      useStore.getState().applyPush({ ch: 'state', runtime, payload: statePayload('sess-a', true, 'A') })
      useStore.getState().applyPush({ ch: 'sync', runtime, payload: [{ id: 'm-user', role: 'user', text: 'u', timestamp: 1 }] })
      ok(
        useStore.getState().messages.some((m) => m.id === 'm-live'),
        '权威 sync 只有用户历史时不删掉流式助手尾部',
        JSON.stringify(useStore.getState().messages.map((m) => m.id))
      )
      useStore.getState().applyPush({
        ch: 'msg-update',
        runtime,
        payload: { id: 'm-live', patch: { textDelta: '！' } }
      })
      ok(
        useStore.getState().messages.find((m) => m.id === 'm-live')?.text === '已流式两百多字！',
        'sync 之后按 id 的增量仍有落点'
      )
      /* 回合结束后不再流式：空快照仍能清 */
      useStore.getState().applyPush({ ch: 'state', runtime, payload: statePayload('sess-a', false, 'A') })
      useStore.getState().applyPush({ ch: 'sync', runtime, payload: [] })
      ok(useStore.getState().messages.length === 0, '清空会话后空 sync 生效，不复活旧历史')
    }

    /* ---------------- 场景 5：文件确实更新时旧缓存不能盖新历史 ---------------- */
    section('文件历史确实更新：旧缓存的独有消息不补回')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false },
        messages: [msg('b1')],
        activeRunnerId: 'r2',
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: false },
            messages: [msg('m-stale'), msg('m-1')]
          })
        }
      })
      /* 文件里有更新（时间戳更大）的新消息，说明内存缓存整份落后 */
      host.peekResults.set('A', {
        messages: [msg('m-1'), { ...msg('m-new'), timestamp: 5 }],
        sessionId: 'sess-a',
        truncated: 0,
        total: 2
      })

      await useStore.getState().switchSession('A')
      await settle()
      const view = useStore.getState()
      ok(!view.messages.some((m) => m.id === 'm-stale'), '文件明显更新时，旧缓存的独有消息不补在末尾', JSON.stringify(view.messages))
      ok(view.messages.some((m) => m.id === 'm-new'), '文件里较新的历史保留')
    }

    /* ---------------- 场景 6：mergePeekedHistory 纯函数 ---------------- */
    section('mergePeekedHistory：同 id 取更完整、内存尾部保留')
    {
      const file = [{ id: 'x', role: 'assistant', text: 'he', timestamp: 1 }]
      const live = [{ id: 'x', role: 'assistant', text: 'hello', timestamp: 1 }]
      ok(mergePeekedHistory(file, live)[0]?.text === 'hello', '同 id 同 timestamp 取内容更完整的内存版本')
      ok(
        mergePeekedHistory([], live) === live && mergePeekedHistory(file, []) === file,
        '一侧为空时直接返回另一侧'
      )
      const merged = mergePeekedHistory(
        [{ id: 'a', role: 'user', text: 'a', timestamp: 1 }],
        [{ id: 'a', role: 'user', text: 'a', timestamp: 1 }, { id: 'b', role: 'assistant', text: 'tail', timestamp: 1 }]
      )
      ok(merged.map((m) => m.id).join(',') === 'a,b', '内存里多出来的尾部按原顺序补在末尾', JSON.stringify(merged.map((m) => m.id)))
      ok(
        mergePeekedHistory([{ id: 'a', role: 'user', text: 'a', timestamp: 9 }], [{ id: 'b', role: 'assistant', text: 'old', timestamp: 1 }])[0]?.id === 'a',
        '文件明显更新时整份以文件为准，不混入旧缓存'
      )
      ok(
        mergePeekedHistory(
          [{ id: 'x', role: 'assistant', text: 'he', timestamp: 1, entryId: 'entry-x' }],
          [{ id: 'x', role: 'assistant', text: 'hello', timestamp: 1 }]
        )[0]?.entryId === 'entry-x',
        '取内存更完整版本时仍保留文件侧的 fork 锚点 entryId'
      )
    }

    /* ---------------- 场景 7：queue-reclaimed 清掉后台缓存队列 ---------------- */
    section('queue-reclaimed：后台缓存队列被清掉，不与草稿重复')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false },
        activeRunnerId: 'r2',
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            queue: { steering: [{ id: 'q1', text: '排队的话' }], followUp: [] }
          })
        }
      })
      useStore.getState().applyPush({
        ch: 'queue-reclaimed',
        payload: { sessionId: 'sess-a', steering: ['排队的话'], followUp: [] }
      })
      const view = useStore.getState()
      ok(
        view.sessionRuntimes['sess-a']?.queue.steering.length === 0 && view.sessionRuntimes['sess-a']?.queue.followUp.length === 0,
        '收回后台会话队列后，缓存队列清空，不与草稿重复',
        JSON.stringify(view.sessionRuntimes['sess-a']?.queue)
      )
      ok(
        (view.sessionRuntimes['sess-a']?.draft ?? '').includes('排队的话'),
        '收回的文本进入该会话草稿'
      )
      ok(view.queue === EMPTY_QUEUE || view.queue.steering.length === 0, '当前视图不是该会话时不误改它的队列')
    }

    /* ---------------- 场景 8：快速切换，迟到的 peek 不覆盖新选择 ---------------- */
    section('快速切换：迟到的 peek 不覆盖较新选择')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false },
        messages: [],
        activeRunnerId: 'r2'
      })
      host.peekDelays.set('A', 150)
      host.peekDelays.set('B', 20)
      const first = useStore.getState().switchSession('A')
      await sleep(30)
      const second = useStore.getState().switchSession('B')
      await Promise.all([first, second])
      await settle()
      const view = useStore.getState()
      ok(view.messages[0]?.id === 'msg-B', '后点的会话胜出', view.messages[0]?.id)
      ok(view.pendingActivation?.sessionFile === 'B', '待激活目标是最后一次点击', view.pendingActivation?.sessionFile)
      ok(
        calls.filter((call) => call === 'peek:A').length === 1 && !calls.includes('select:A'),
        '过期的点击不再向主进程请求激活',
        calls.join(',')
      )
    }

    /* ---------------- 场景 9：迟到的新建响应不覆盖较新选择 ---------------- */
    section('迟到的新建响应不覆盖较新选择')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [msg('a1')],
        activeRunnerId: 'r0',
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 2,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [msg('a1')]
          })
        }
      })
      host.newSessionResult = { ok: true, id: 'r-late', runId: 'r-late' }
      host.newSessionDelay = 120

      const created = useStore.getState().newSession({ scope: 'global' })
      await sleep(20)
      const switched = useStore.getState().switchSession('A')
      const made = await created
      await switched
      await settle()
      const view = useStore.getState()
      ok(view.activeRunnerId !== 'r-late', '迟到的新建响应不把运行身份改回新实例', view.activeRunnerId)
      ok(view.session?.sessionId === 'sess-a', '迟到的响应不覆盖新选择的会话状态', JSON.stringify(view.session))
      ok(view.peekedSessionId === 'sess-a', '迟到的响应不清掉新选择的视图身份', view.peekedSessionId)
      ok(made.ok === true && made.runId === 'r-late', '新建结果仍按实返回给调用方（工作树登记等副作用需要）')
    }
  } finally {
    for (const [key, value] of Object.entries(savedGlobals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    if (!hadNavigator) delete globalThis.navigator
  }
}

async function main() {
  let passed = 0
  let failed = 0
  await runSessionConcurrencyFrontendTests((cond, label, detail) => {
    if (cond) {
      passed += 1
      console.log(`  [ok] ${label}`)
    } else {
      failed += 1
      console.error(`  [FAIL] ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
    }
  })
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
