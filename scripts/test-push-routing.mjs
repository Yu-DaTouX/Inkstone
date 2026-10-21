export function runPushRoutingTests(ok, { routePush, viewingSessionId }) {
  const runtimeA = { sessionId: 'session-a', runId: 'r1', projectId: 'p', generation: 2 }
  const base = {
    runners: [{ id: 'r1', runId: 'r1', generation: 2 }],
    activeRunnerId: 'r1',
    sessionRuntimes: {},
    peekedSessionId: null,
    session: { sessionId: 'session-a' }
  }
  const msg = (runtime) => ({ ch: 'msg-add', runtime, payload: { id: 'm1', role: 'assistant', text: 'x' } })

  const own = routePush(base, msg(runtimeA))
  ok(own.project === true && !!own.patch?.sessionRuntimes?.['session-a'], '当前实例、当前会话的推送：写缓存并投影到视图')

  const stale = routePush(base, msg({ ...runtimeA, generation: 1 }))
  ok(stale.project === false && stale.patch === null, '比当前运行实例更旧的代次直接丢弃')

  const background = routePush(base, msg({ sessionId: 'session-b', runId: 'r2', projectId: 'p', generation: 1 }))
  ok(background.project === false && !!background.patch?.sessionRuntimes?.['session-b'], '后台实例的推送只进缓存，不改当前视图')

  const reused = routePush({ ...base, peekedSessionId: 'session-new' }, msg(runtimeA))
  ok(reused.project === false && !!reused.patch?.sessionRuntimes, '实例被复用到新会话时，旧会话迟到的帧只进缓存')

  const first = routePush({ ...base, activeRunnerId: null, runners: [] }, msg(runtimeA))
  ok(first.project === true && first.patch?.activeRunnerId === 'r1', '还没对齐身份时以第一条推送的实例为当前视图')

  const global = routePush(base, { ch: 'runners', payload: [] })
  ok(global.project === true && global.patch === null, '不带身份的全局推送直接投影')

  ok(viewingSessionId({ peekedSessionId: 'peek', session: { sessionId: 'a' } }) === 'peek', '正在看的会话优先取待确认的 peek')
  ok(viewingSessionId({ peekedSessionId: null, session: { sessionId: 'a' } }) === 'a', '没有 peek 时取已确认的会话')
}
