import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await sleep(0)
}

export async function runSessionSyncRaceTests(ok) {
  const section = (name) => console.log(`\n## ${name}`)

  const savedGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  }
  const hadNavigator = typeof globalThis.navigator !== 'undefined'

  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: (key) => storage.delete(String(key)),
    clear: () => storage.clear(),
    key: () => null,
    length: 0
  }
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
    documentElement: { lang: 'zh-CN' },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} })
  }
  if (!hadNavigator) globalThis.navigator = { userAgent: 'node' }

  const calls = []
  const host = {
    sessions: [],
    selectDelays: new Map(),
    selectResults: new Map(),
    peekResults: new Map(),
    sendArgs: [],
    bashArgs: [],
    steerArgs: [],
    runnerStatuses: []
  }

  const yan = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'send') {
          return async (...args) => {
            calls.push(`send:${args[0]}`)
            host.sendArgs.push(args)
            return { ok: true }
          }
        }
        if (prop === 'runBash') {
          return async (...args) => {
            calls.push(`runBash:${args[0]}`)
            host.bashArgs.push(args)
            return { ok: true }
          }
        }
        if (prop === 'steerQueued') {
          return async (...args) => {
            calls.push(`steerQueued:${args[0]}`)
            host.steerArgs.push(args)
            return { ok: true }
          }
        }
        if (prop === 'selectSession') {
          return async (target) => {
            calls.push(`select:${target.sessionFile ?? target.sessionId}`)
            const base = target.sessionFile ?? target.sessionId
            const prefixed = `${target.preview ? 'preview' : 'activate'}:${base}`
            const key = host.selectResults.has(prefixed) ? prefixed : base
            await sleep(host.selectDelays.get(prefixed) ?? host.selectDelays.get(base) ?? 0)
            const result = host.selectResults.has(key)
              ? { ...host.selectResults.get(key) }
              : { ok: true, deferred: true, sessionId: target.sessionId, runId: undefined }
            if (!target.preview && result.ok && !result.deferred) {
              const runId = result.runId ?? result.id
              if (runId) {
                host.runnerStatuses = [{
                  id: runId,
                  runId,
                  sessionId: result.sessionId ?? target.sessionId,
                  sessionFile: target.sessionFile,
                  generation: result.generation ?? 1,
                  isActive: true
                }]
              }
            }
            return result
          }
        }
        if (prop === 'peekSession') {
          return async (path) => {
            await sleep(0)
            return (
              host.peekResults.get(path) ?? {
                messages: [{ id: `msg-${path}`, role: 'user', text: path, timestamp: 1 }],
                sessionId: host.sessions.find((s) => s.path === path)?.id ?? path,
                truncated: 0,
                total: 1
              }
            )
          }
        }
        if (prop === 'listSessions') return async () => host.sessions
        if (prop === 'runnerStatuses') return async () => host.runnerStatuses
        if (prop === 'listModels' || prop === 'listThinkingLevels' || prop === 'listCommands') return async () => []
        if (prop === 'getGoal') return async () => ({ goal: null })
        if (prop === 'sources') return { verifyFiles: async () => [] }
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

  const temp = await mkdtemp(join(tmpdir(), 'yan-sync-race-'))
  const bundle = async (entry, name) => {
    const outfile = join(temp, name)
    await build({
      entryPoints: [entry],
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
    return import(pathToFileURL(outfile).href)
  }

  try {
    const merge = await bundle('src/renderer/src/state/session-message-merge.ts', 'merge.mjs')
    const runtimeMod = await bundle('src/renderer/src/state/session-runtime.ts', 'runtime.mjs')
    const { useStore } = await bundle('src/renderer/src/state/store.ts', 'store.mjs')

    const msg = (id, text = id, extra = {}) => ({ id, role: 'assistant', text, timestamp: 1, ...extra })
    const user = (id, text = id) => ({ id, role: 'user', text, timestamp: 1 })
    const statePayload = (sessionId, running, file) => ({
      sessionId,
      sessionFile: file,
      cwd: 'C:/proj',
      isAgentRunning: running,
      isStreaming: running,
      isCompacting: false,
      availableThinkingLevels: []
    })
    const snapshot = (
      sessionId,
      { runId = `run-${sessionId}`, generation = 1, session = null, messages = [], draft = '', draftAttachments = [] } = {}
    ) => ({
      runtime: { sessionId, runId, generation },
      session,
      messages,
      stats: null,
      queue: { steering: [], followUp: [] },
      todos: [],
      todoHistory: [],
      uiRequests: [],
      statuses: {},
      widgets: {},
      widgetPlacements: {},
      draft,
      draftAttachments,
      workMode: null,
      agentProfile: null,
      goal: null,
      models: [],
      thinkingLevels: [],
      commands: [],
      touchedAt: 1
    })
    const img = (id) => ({
      id,
      kind: 'image',
      name: `${id}.png`,
      mimeType: 'image/png',
      size: 4,
      data: 'AAAA',
      preview: 'data:image/png;base64,AAAA'
    })

    const sessionA = { path: 'A', id: 'sess-a', cwd: 'C:/proj', scope: 'global', title: 'A' }
    const sessionB = { path: 'B', id: 'sess-b', cwd: 'C:/proj', scope: 'global', title: 'B' }
    const EMPTY_QUEUE = { steering: [], followUp: [] }

    function resetView(overrides = {}) {
      host.sessions = [sessionA, sessionB]
      host.selectDelays.clear()
      host.selectResults.clear()
      host.peekResults.clear()
      host.sendArgs.length = 0
      host.bashArgs.length = 0
      host.steerArgs.length = 0
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
        attachments: [],
        queueRestore: null,
        ...overrides
      })
    }

    section('mergeSyncHistory：只保护流式尾部，内容更完整者胜出')
    {
      const partial = msg('m1', '263 字…')
      const full = msg('m1', '263 字…以及已经完成的完整正文')
      ok(
        merge.mergeSyncHistory([user('m0')], [user('m0'), partial], 'm1').map((m) => m.id).join(',') === 'm0,m1',
        '有 protectedTailId 时拟合并快照缺失的流式尾部',
        JSON.stringify(merge.mergeSyncHistory([user('m0')], [user('m0'), partial], 'm1'))
      )
      ok(
        merge.mergeSyncHistory([user('m0')], [user('m0'), partial]).length === 1,
        '没有 protectedTailId 时按快照整份替换（清空语义）'
      )
      const completed = merge.mergeSyncHistory([user('m0'), full], [user('m0'), partial])
      ok(completed[1].text === full.text, '快照里的完成版本覆盖旧的流式文本', completed[1].text)
      const noDup = merge.mergeSyncHistory([user('m0'), full], [user('m0'), partial], 'm1')
      ok(noDup.length === 2 && noDup[1].text === full.text, '快照已含尾部时不重复追加', JSON.stringify(noDup.map((m) => m.id)))
      ok(merge.mergeSyncHistory([], [user('m0'), partial], 'm1').length === 0, '空快照仍然清空（清会话依旧能清）')
      const toolSnapshot = msg('m1', 'txt', { toolCalls: [{ id: 't1', name: 'bash', args: {}, status: 'running', output: 'one' }] })
      const toolLive = msg('m1', 'txt', { toolCalls: [{ id: 't1', name: 'bash', args: {}, status: 'running', output: 'onetwo' }] })
      ok(
        merge.mergeSyncHistory([user('m0'), toolSnapshot], [user('m0'), toolLive], 'm1')[1].toolCalls[0].output === 'onetwo',
        '同 id 消息取更完整的工具输出（保护更晚的 tool 状态）'
      )
      const withImage = msg('m1', 'x', { images: [{ mimeType: 'image/png', data: 'AAAA' }] })
      ok(
        merge.mergeSyncHistory([user('m0'), msg('m1', 'x')], [user('m0'), withImage])[1].images?.length === 1,
        '整份替换仍保住本地图片预览'
      )
    }

    section('F01：流式中的 A 收到权威 sync，尾部与后续增量不丢')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        messages: [user('m0'), msg('m1', '已经写了两百多字的正文')],
        activeRunnerId: 'r1',
        runners: [{ id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 2, isActive: true }]
      })
      const runtime = { sessionId: 'sess-a', runId: 'r1', generation: 2 }
      useStore.getState().applyPush({ ch: 'state', runtime, payload: statePayload('sess-a', true, 'A') })
      useStore.getState().applyPush({ ch: 'sync', runtime, payload: [user('m0')] })
      const afterSync = useStore.getState()
      ok(
        afterSync.messages.some((m) => m.id === 'm1'),
        '权威 sync 只有用户历史时保住正在流式的助手尾部（正文不再变 0）',
        JSON.stringify(afterSync.messages.map((m) => m.id))
      )
      useStore.getState().applyPush({ ch: 'msg-update', runtime, payload: { id: 'm1', patch: { textDelta: '，继续输出' } } })
      ok(
        useStore.getState().messages.find((m) => m.id === 'm1')?.text === '已经写了两百多字的正文，继续输出',
        'sync 之后按 id 的流式增量仍有落点'
      )

      useStore.getState().applyPush({ ch: 'state', runtime: { ...runtime, generation: 2 }, payload: statePayload('sess-a', false, 'A') })
      useStore.getState().applyPush({
        ch: 'sync',
        runtime,
        payload: [user('m0'), msg('m1', '最终完整正文')]
      })
      ok(useStore.getState().messages.find((m) => m.id === 'm1')?.text === '最终完整正文', '完成后更新的 pi sync 覆盖旧完成历史')

      useStore.getState().applyPush({ ch: 'sync', runtime, payload: [] })
      ok(useStore.getState().messages.length === 0, '清空会话后空 sync 生效，不复活旧历史', JSON.stringify(useStore.getState().messages))
    }

    section('F01：后台会话缓存收到 sync 也保护尾部')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false, isStreaming: false },
        messages: [user('b0')],
        activeRunnerId: 'r2',
        runners: [
          { id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 1, isActive: false, running: true },
          { id: 'r2', runId: 'r2', sessionId: 'sess-b', generation: 1, isActive: true, running: false }
        ],
        sessionRuntimes: {
          'sess-a': snapshot('sess-a', {
            runId: 'r1',
            generation: 1,
            session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
            messages: [user('u0'), msg('a1', '后台流式正文')]
          })
        }
      })
      useStore.getState().applyPush({
        ch: 'sync',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 1 },
        payload: [user('u0')]
      })
      const cached = useStore.getState().sessionRuntimes['sess-a']
      ok(
        cached.messages.some((m) => m.id === 'a1'),
        '后台缓存收到 sync 时也保住流式尾部',
        JSON.stringify(cached.messages.map((m) => m.id))
      )
      ok(
        !useStore.getState().messages.some((m) => m.id === 'a1'),
        '后台会话的帧不污染当前视图'
      )
    }

    section('F01：导入 / 分叉出来的新历史整份替换，不混入旧尾部')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj', isAgentRunning: false, isStreaming: false },
        messages: [user('old-user'), msg('old-a', '旧历史')],
        activeRunnerId: 'r1',
        runners: [{ id: 'r1', runId: 'r1', sessionId: 'sess-a', generation: 1, isActive: true }]
      })
      useStore.getState().applyPush({
        ch: 'sync',
        runtime: { sessionId: 'sess-a', runId: 'r1', generation: 1 },
        payload: [user('imported-user'), msg('imported-a', '导入的新历史')]
      })
      const view = useStore.getState()
      ok(
        view.messages.map((m) => m.id).join(',') === 'imported-user,imported-a',
        '不流式时导入的新历史整份替换',
        JSON.stringify(view.messages.map((m) => m.id))
      )
    }

    section('F02：ensureActivated 迟到响应被丢弃')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        pendingActivation: { sessionFile: 'A', sessionId: 'sess-a', cwd: 'C:/proj', scope: 'global' },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 1 }]
      })
      host.selectDelays.set('A', 60)
      host.selectResults.set('A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })

      const pending = useStore.getState().ensureActivated()
      await sleep(10)
      useStore.setState({
        peekedPath: 'B',
        peekedSessionId: 'sess-b',
        pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj', scope: 'global' }
      })
      const activated = await pending
      await settle()
      const after = useStore.getState()
      ok(activated === false, '视图已换到 B 时旧 ensureActivated 返回 false', String(activated))
      ok(after.pendingActivation?.sessionFile === 'B', '不清掉新的 pendingActivation', JSON.stringify(after.pendingActivation))
      ok(after.activeRunnerId === 'rB', '不把旧 runner-A 写回 activeRunnerId', String(after.activeRunnerId))
    }

    section('F02：send 等待激活期间切走，不把消息发到新视图')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        pendingActivation: { sessionFile: 'A', sessionId: 'sess-a', cwd: 'C:/proj', scope: 'global' },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 1 }]
      })
      host.selectDelays.set('A', 60)
      host.selectResults.set('A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })

      const sending = useStore.getState().send('ORIGINAL-A-MESSAGE')
      await sleep(10)
      useStore.setState({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj' },
        peekedPath: 'B',
        peekedSessionId: 'sess-b',
        pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj', scope: 'global' }
      })
      const sent = await sending
      await settle()
      ok(sent === false, '目标变化时 send 返回 false（调用方把草稿还回原会话）', String(sent))
      ok(host.sendArgs.length === 0, '没有把 A 的消息交给宿主 send', JSON.stringify(host.sendArgs))
    }

    section('F02 根因：乐观切换在飞时立即 send，绝不落到上一条活动会话 B')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false, isStreaming: false },
        messages: [user('b0')],
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]
      })
      host.selectDelays.set('A', 80)
      host.selectResults.set('activate:A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })
      host.runnerStatuses = [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]

      const switching = useStore.getState().switchSession('A')
      ok(useStore.getState().peekedPath === 'A', '乐观视图已在第一个 await 前切到 A', String(useStore.getState().peekedPath))
      const sending = useStore.getState().send('RACE-A-MESSAGE')
      const sent = await sending
      await switching
      await settle()

      const owner = host.sendArgs[0]?.[3]
      ok(sent === true && host.sendArgs.length === 1, '在飞期间发送等激活后成功发出（不是静默失败）', `${sent}/${host.sendArgs.length}`)
      ok(host.sendArgs[0]?.[0] === 'RACE-A-MESSAGE', '发出的是 A 的那条消息', JSON.stringify(host.sendArgs[0]))
      ok(
        owner === undefined || owner.sessionId === 'sess-a',
        'owner 绝不是上一条活动会话 B（不再回退 activeRunnerId）',
        JSON.stringify(owner)
      )
      ok(owner?.sessionId !== 'sess-b', '明确证明没有钉住 B 的 owner', JSON.stringify(owner))
      ok(useStore.getState().activeRunnerId === 'rA', '激活完成后运行身份指向 A', String(useStore.getState().activeRunnerId))
    }

    section('F02 同根：乐观切换在飞时立即 runBash，绝不在上一条活动会话 B 的 cwd 执行')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: false, isStreaming: false },
        messages: [user('b0')],
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]
      })
      host.selectDelays.set('A', 80)
      host.selectResults.set('activate:A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })
      host.runnerStatuses = [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]

      const switching = useStore.getState().switchSession('A')
      ok(useStore.getState().peekedPath === 'A', 'runBash 前乐观视图已切到 A', String(useStore.getState().peekedPath))
      const running = useStore.getState().runBash('rm -rf important.txt')
      const result = await running
      await switching
      await settle()

      ok(result.ok === true && host.bashArgs.length === 1, '在飞期间 runBash 等激活后执行（不是静默失败）', `${result.ok}/${host.bashArgs.length}`)
      ok(host.bashArgs[0]?.[0] === 'rm -rf important.txt', '执行的是原命令', JSON.stringify(host.bashArgs[0]))
      const bashOwner = host.bashArgs[0]?.[2]
      ok(bashOwner === undefined || bashOwner.sessionId === 'sess-a', 'owner 绝不是上一条活动会话 B', JSON.stringify(bashOwner))
      ok(bashOwner?.sessionId !== 'sess-b', '明确证明没有把命令钉到 B 的实例', JSON.stringify(bashOwner))
      const runBashIndex = calls.findIndex((c) => c.startsWith('runBash:'))
      const activateIndex = calls.lastIndexOf('select:A')
      ok(runBashIndex > activateIndex, 'runBash 在 A 激活落定之后才交给宿主', `${runBashIndex}/${activateIndex} ${calls.join(',')}`)
      ok(useStore.getState().activeRunnerId === 'rA', '切换落定后活动身份是 A', String(useStore.getState().activeRunnerId))
    }

    section('F02：等激活完成后 runBash 正常发 A')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        pendingActivation: { sessionFile: 'A', sessionId: 'sess-a', cwd: 'C:/proj', scope: 'global' },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]
      })
      host.selectResults.set('activate:A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })
      const result = await useStore.getState().runBash('echo A')
      const bashOwner = host.bashArgs[0]?.[2]
      ok(result.ok === true && host.bashArgs.length === 1, '激活后 runBash 成功', `${result.ok}/${host.bashArgs.length}`)
      ok(bashOwner === undefined || bashOwner.sessionId === 'sess-a', '激活后 owner 指向 A（或交给宿主按 active=A 处理）', JSON.stringify(bashOwner))
      ok(bashOwner?.sessionId !== 'sess-b', '激活后不会落到 B', JSON.stringify(bashOwner))
      ok(useStore.getState().activeRunnerId === 'rA', '激活后运行身份是 A', String(useStore.getState().activeRunnerId))
    }

    section('F02：runBash 等待激活期间切走，安全失败不执行')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        pendingActivation: { sessionFile: 'A', sessionId: 'sess-a', cwd: 'C:/proj', scope: 'global' },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 1 }]
      })
      host.selectDelays.set('A', 60)
      host.selectResults.set('A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })

      const running = useStore.getState().runBash('echo ORIGINAL-A')
      await sleep(10)
      useStore.setState({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj' },
        peekedPath: 'B',
        peekedSessionId: 'sess-b',
        pendingActivation: { sessionFile: 'B', sessionId: 'sess-b', cwd: 'C:/proj', scope: 'global' }
      })
      const result = await running
      await settle()
      ok(result.ok === false, '视图换走时 runBash 返回 ok:false（命令原文与附件由调用方还回草稿）', JSON.stringify(result))
      ok(host.bashArgs.length === 0, '没有把 A 的命令交给宿主执行', JSON.stringify(host.bashArgs))
    }

    section('F02 同根：乐观切换在飞时 steerQueued 不作用于旧实例 B')
    {
      resetView({
        session: { sessionId: 'sess-b', sessionFile: 'B', cwd: 'C:/proj', isAgentRunning: true, isStreaming: true },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]
      })
      host.selectDelays.set('A', 80)
      host.selectResults.set('activate:A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })
      host.runnerStatuses = [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]

      const switching = useStore.getState().switchSession('A')
      const steering = useStore.getState().steerQueued('q-old')
      await steering
      await switching
      await settle()

      const steerIndex = calls.findIndex((c) => c === 'steerQueued:q-old')
      const activateIndex = calls.lastIndexOf('select:A')
      ok(steerIndex >= 0, 'steerQueued 已调用', calls.join(','))
      ok(steerIndex > activateIndex, 'steer 发生在 A 激活落定之后，不是切换在飞时作用于旧实例 B', `${steerIndex}/${activateIndex}`)
      ok(useStore.getState().activeRunnerId === 'rA', '切换落定后活动身份是 A', String(useStore.getState().activeRunnerId))
    }

    section('F02：等激活完成后 send 正常发 A')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        pendingActivation: { sessionFile: 'A', sessionId: 'sess-a', cwd: 'C:/proj', scope: 'global' },
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 7, isActive: true }]
      })
      host.selectResults.set('activate:A', { ok: true, runId: 'rA', sessionId: 'sess-a', generation: 1 })
      const sent = await useStore.getState().send('AFTER-ACTIVATION')
      const owner = host.sendArgs[0]?.[3]
      ok(sent === true && host.sendArgs.length === 1, '激活后 send 成功', `${sent}/${host.sendArgs.length}`)
      ok(
        owner === undefined || owner.sessionId === 'sess-a',
        '激活后 owner 指向 A（或交给宿主按 active=A 处理）',
        JSON.stringify(owner)
      )
      ok(owner?.sessionId !== 'sess-b', '激活后不会落到 B', JSON.stringify(owner))
      ok(useStore.getState().activeRunnerId === 'rA', '激活后运行身份是 A', String(useStore.getState().activeRunnerId))
    }

    section('F02：send / runBash 带 expectedRuntime')
    {
      resetView({
        session: { sessionId: 'sess-a', sessionFile: 'A', cwd: 'C:/proj' },
        peekedPath: 'A',
        peekedSessionId: 'sess-a',
        activeRunnerId: 'rA',
        runners: [{ id: 'rA', runId: 'rA', sessionId: 'sess-a', sessionFile: 'A', generation: 3 }]
      })
      const sent = await useStore.getState().send('hi')
      ok(sent === true && host.sendArgs.length === 1, '正常 send 成功且只发一次', JSON.stringify(host.sendArgs))
      const owner = host.sendArgs[0][3]
      ok(
        !!owner && owner.sessionId === 'sess-a' && owner.runId === 'rA' && owner.generation === 3,
        'send 第 4 个参数是提交时钉住的 owner（session/run/generation）',
        JSON.stringify(owner)
      )
      const bash = await useStore.getState().runBash('echo hi')
      ok(bash.ok === true && host.bashArgs.length === 1, 'runBash 正常返回', JSON.stringify(host.bashArgs))
      const bashOwner = host.bashArgs[0][2]
      ok(
        !!bashOwner && bashOwner.sessionId === 'sess-a' && bashOwner.runId === 'rA' && bashOwner.generation === 3,
        'runBash 第 3 个参数同样是 owner',
        JSON.stringify(bashOwner)
      )
    }

    section('F02：尚未落定身份时 send 仍可发（不因同视图校验误拦）')
    {
      resetView({ session: null, peekedPath: null, peekedSessionId: null, activeRunnerId: null, runners: [] })
      const sent = await useStore.getState().send('early message')
      ok(sent === true && host.sendArgs.length === 1, '无身份时 send 正常发出', `${sent}/${host.sendArgs.length}`)
      ok(host.sendArgs[0][3] === undefined, '无实例时不带 owner', JSON.stringify(host.sendArgs[0][3]))
    }

    section('F08：file:<path> 草稿迁移到稳定 sessionId')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: null,
        activeRunnerId: 'rB',
        runners: [{ id: 'rB', runId: 'rB', sessionId: 'sess-b', sessionFile: 'B', generation: 1 }]
      })
      useStore.getState().setSessionDraft('path only draft')
      useStore.getState().addAttachments([img('p1')])
      const seeded = useStore.getState().sessionRuntimes['file:a']
      ok(seeded?.draft === 'path only draft' && (seeded.draftAttachments ?? []).some((a) => a.id === 'p1'), 'path-only 时草稿写在薄键 file:<path>', JSON.stringify(seeded))

      useStore.setState({ peekedSessionId: 'sess-a' })
      useStore.getState().applyPush({
        ch: 'state',
        runtime: { sessionId: 'sess-a', runId: 'rA', generation: 1 },
        payload: statePayload('sess-a', false, 'A')
      })
      const migrated = useStore.getState().sessionRuntimes
      ok(migrated['file:a'] === undefined, '迁移后薄路径键被删掉', Object.keys(migrated).join(','))
      const stable = migrated['sess-a']
      ok(stable?.draft === 'path only draft', '文字迁移到稳定键', JSON.stringify(stable?.draft))
      ok((stable?.draftAttachments ?? []).some((a) => a.id === 'p1'), '完整附件迁移到稳定键', JSON.stringify((stable?.draftAttachments ?? []).map((a) => a.id)))

      useStore.getState().hydrateComposerDraft('sess-a')
      ok(useStore.getState().attachments.some((a) => a.id === 'p1'), '按稳定键 hydrate 取回附件')
      useStore.getState().clearAttachments()
      useStore.getState().hydrateComposerDraft('sess-a')
      ok(useStore.getState().attachments.length === 0, '成功清空附件后 hydrate 不复活，薄键也不复活', JSON.stringify(useStore.getState().attachments.map((a) => a.id)))
    }

    section('F08：switchSession 的 peek 给出 sessionId 后迁移薄键')
    {
      resetView({
        session: null,
        peekedPath: 'A',
        peekedSessionId: null,
        activeRunnerId: null,
        runners: []
      })
      useStore.getState().setSessionDraft('peek 迁移草稿')
      useStore.getState().addAttachments([img('p2')])
      ok(!!useStore.getState().sessionRuntimes['file:a'], '切换前草稿在薄键')
      await useStore.getState().switchSession('A')
      await settle()
      const after = useStore.getState().sessionRuntimes
      ok(after['file:a'] === undefined, 'peek 给出稳定 id 后薄键被清掉', Object.keys(after).join(','))
      ok(after['sess-a']?.draft === 'peek 迁移草稿', 'peek 后文字迁到稳定键', JSON.stringify(after['sess-a']?.draft))
      ok((after['sess-a']?.draftAttachments ?? []).some((a) => a.id === 'p2'), 'peek 后附件迁到稳定键')
    }

    section('F08：不同路径与实例复用（代次不同）不迁移')
    {
      const pathMap = { 'file:a': snapshot('', { runId: 'file:a', draft: 'A 的草稿' }) }
      const samePathMap = runtimeMod.migratePathDraft(pathMap, 'A', 'sess-a')
      ok(samePathMap['sess-a']?.draft === 'A 的草稿' && samePathMap['file:a'] === undefined, '同一稳定路径才迁移', JSON.stringify(samePathMap['sess-a']?.draft))
      const otherPath = runtimeMod.migratePathDraft(pathMap, 'C', 'sess-c')
      ok(otherPath['file:a']?.draft === 'A 的草稿' && otherPath['sess-c'] === undefined, '不同路径不迁移')

      const pendingMap = {
        'pending:r1': snapshot('pending:r1', { runId: 'r1', generation: 1, draft: 'pending 草稿' }),
        'pending:r9': snapshot('pending:r9', { runId: 'r9', generation: 1, draft: '旧代次草稿' })
      }
      const sameGen = runtimeMod.migrateSessionRuntime(pendingMap, { sessionId: 'sess-x', runId: 'r1', generation: 1 })
      ok(sameGen['sess-x']?.draft === 'pending 草稿' && sameGen['pending:r1'], '同实例同代次：pending 草稿迁到稳定键', JSON.stringify(sameGen['sess-x']?.draft))
      const newGen = runtimeMod.migrateSessionRuntime(pendingMap, { sessionId: 'sess-y', runId: 'r9', generation: 2 })
      ok(newGen['sess-y'] === undefined || newGen['sess-y']?.draft === '', '代次不同（实例被复用）：旧 pending 草稿不迁到新会话', JSON.stringify(newGen['sess-y']?.draft))
    }

    section('缓存裁剪：冷草稿数量有限')
    {
      const map = {}
      for (let i = 0; i < 40; i += 1) {
        map[`sess-${i}`] = snapshot(`sess-${i}`, { runId: `r${i}`, generation: 1, draft: `d${i}` })
      }
      const pruned = runtimeMod.pruneSessionRuntimes(map, new Set())
      const draftKeys = Object.keys(pruned).filter((key) => (pruned[key].draft ?? '').length > 0)
      ok(draftKeys.length <= 16, '冷会话草稿最多保留 16 份，不无限增长', `kept=${draftKeys.length}`)
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
  await runSessionSyncRaceTests((cond, label, detail) => {
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
