#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { runSuite } from './lib/test-suite.mjs'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: () => null,
  length: 0
}
globalThis.requestAnimationFrame = (fn) => { fn(0); return 0 }
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
if (!('navigator' in globalThis)) globalThis.navigator = { userAgent: 'node' }
const resyncCalls = []
const api = { resyncView: async (request) => { resyncCalls.push(request); return { ok: true } }, pendingUiRequests: async () => [] }
globalThis.window = {
  yan: new Proxy(api, { get: (target, key) => target[key] ?? (async () => undefined) }),
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const browser = { platform: 'neutral', define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } }

function fakeClock() {
  let now = 1_000_000
  const timers = []
  return {
    now: () => now,
    setTimer: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return timer },
    clearTimer: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1) },
    advance(ms) {
      now += ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const due = timers[0]
        if (!due || due.at > now) return
        timers.shift()
        due.run()
      }
    },
    pending: () => timers.map((timer) => timer.at - now)
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { useStore } = await compile('src/renderer/src/state/store.ts', browser)
  const { createViewResyncScheduler, ViewResyncGuard } = await compile('src/renderer/src/state/view-resync.ts', browser)
  const { reduceSessionRuntime } = await compile('src/renderer/src/state/session-runtime.ts', browser)
  const { applySyncDelta } = await compile('src/renderer/src/state/session-message-merge.ts', browser)
  const { createViewResync, resolveViewResyncTarget } = await compile('src/main/view-resync.ts')
  const { StreamProjection } = await compile('src/main/stream-projection.ts')

  const session = (sessionId, extra = {}) => ({ sessionId, sessionFile: `C:/s/${sessionId}.jsonl`, cwd: 'C:/p', isAgentRunning: true, isStreaming: true, availableThinkingLevels: [], ...extra })
  const runnerOf = (runId, sessionId, generation, extra = {}) => ({ id: runId, runId, sessionId, sessionFile: `C:/s/${sessionId}.jsonl`, generation, running: true, ...extra })
  const cacheOf = (runtime, sess, messages) => ({ runtime, session: sess, messages, messagesLoaded: true, stats: null, queue: { steering: [], followUp: [] }, todos: [], todoHistory: [], uiRequests: [], statuses: {}, widgets: {}, widgetPlacements: {}, draft: '', draftAttachments: [], models: [], thinkingLevels: [], commands: [] })
  const A = { id: 'a', name: 'bash', args: { command: 'ls' }, status: 'ok', output: 'aaaa' }
  const B = { id: 'b', name: 'bash', args: { command: 'pwd' }, status: 'running', output: '' }
  const user = { id: 'm0', role: 'user', text: 'go' }
  const stale = { id: 'm1', role: 'assistant', text: 'step', toolCalls: [A] }
  const fresh = { id: 'm1', role: 'assistant', text: 'step', toolCalls: [A, B] }
  const viewHasB = () => !!useStore.getState().messages.find((m) => m.id === 'm1')?.toolCalls?.some((c) => c.id === 'b')

  console.log('\n## 流式中缺工具：一次重同步后视图收敛，不再反复请求')
  {
    const runtime = { sessionId: 'S', runId: 'r1', generation: 1 }
    const sess = session('S')
    useStore.setState({
      session: sess, runners: [runnerOf('r1', 'S', 1, { isActive: true })], activeRunnerId: 'r1', peekedSessionId: null, peekedPath: null,
      messages: [user, stale], sessionRuntimes: { S: cacheOf(runtime, sess, [user, stale]) }
    })
    const push = (m) => useStore.getState().applyPush({ ...m, runtime, sessionKey: 'r1' })
    resyncCalls.length = 0
    push({ ch: 'tool', payload: { msgId: 'm1', call: { id: 'b', name: 'bash', status: 'running' }, outputDelta: 'x', sameArgs: true } })
    await sleep(420)
    ok(resyncCalls.length === 1, '缺工具时请求一次重同步', JSON.stringify(resyncCalls))
    const first = resyncCalls[0]
    ok(first?.runId === 'r1' && first?.generation === 1 && first?.sessionId === 'S', '请求带上补丁来源的运行实例与会话', JSON.stringify(first))
    ok(first?.missing?.[0]?.kind === 'tool-call' && first.missing[0].messageId === 'm1' && first.missing[0].callId === 'b', '请求带上缺失的消息 id、工具 id 与补丁类型', JSON.stringify(first?.missing))
    push({ ch: 'state', payload: sess })
    push({ ch: 'sync', payload: [user, fresh], resync: true })
    ok(viewHasB(), '重同步快照以主进程为准，补上缺的工具')
    push({ ch: 'runners', payload: [runnerOf('r1', 'S', 1, { isActive: true })] })
    ok(viewHasB(), '运行实例推送回投缓存后工具仍在')
    push({ ch: 'tool', payload: { msgId: 'm1', call: { id: 'b', name: 'bash', status: 'running' }, outputDelta: 'y', sameArgs: true } })
    await sleep(420)
    ok(resyncCalls.length === 1, '之后的增量直接落地，不再请求重同步', String(resyncCalls.length))
    const output = useStore.getState().messages.find((m) => m.id === 'm1')?.toolCalls?.find((c) => c.id === 'b')?.output
    ok(output === 'y', '增量接在快照内容后面', String(output))
  }

  console.log('\n## 普通同步（非重同步）仍保留流式尾部的本地版本')
  {
    const runtime = { sessionId: 'S', runId: 'r1', generation: 1 }
    const sess = session('S')
    const live = { id: 'm2', role: 'assistant', text: '正在输出很多字' }
    useStore.setState({
      session: sess, runners: [runnerOf('r1', 'S', 1, { isActive: true })], activeRunnerId: 'r1', peekedSessionId: null, peekedPath: null, runTail: null,
      messages: [user, fresh, live], sessionRuntimes: { S: cacheOf(runtime, sess, [user, fresh, live]) }
    })
    useStore.getState().applyPush({ ch: 'sync', payload: [user, fresh], runtime, sessionKey: 'r1' })
    ok(useStore.getState().messages.at(-1)?.id === 'm2', '普通同步不丢正在流式的尾消息')
    resyncCalls.length = 0
    useStore.getState().applyPush({ ch: 'msg-update', payload: { id: 'm2', patch: { textDelta: '。' } }, runtime, sessionKey: 'r1' })
    useStore.getState().applyPush({ ch: 'stats', payload: {}, runtime, sessionKey: 'r1' })
    await sleep(420)
    ok(useStore.getState().messages.at(-1)?.text === '正在输出很多字。', '正常补丁照常落地')
    ok(resyncCalls.length === 0, '正常路径不请求重同步', JSON.stringify(resyncCalls))
  }

  console.log('\n## 看的是后台运行实例：请求指向补丁来源，而不是主进程的活动实例')
  {
    const viewed = { sessionId: 'V', runId: 'r5', generation: 7 }
    const sess = session('V')
    useStore.setState({
      session: sess, runners: [runnerOf('r3', 'O', 3, { isActive: true }), runnerOf('r5', 'V', 7)], activeRunnerId: 'r3', peekedSessionId: 'V', peekedPath: 'C:/s/V.jsonl',
      messages: [user], sessionRuntimes: { V: cacheOf(viewed, sess, [user]) }
    })
    resyncCalls.length = 0
    useStore.getState().applyPush({ ch: 'msg-update', payload: { id: 'm9', patch: { textDelta: 'x' } }, runtime: viewed, sessionKey: 'r5' })
    useStore.getState().applyPush({ ch: 'stats', payload: {}, runtime: viewed, sessionKey: 'r5' })
    await sleep(420)
    const request = resyncCalls.at(-1)
    ok(request?.runId === 'r5' && request?.sessionId === 'V', '缺失补丁来自 r5 时请求 r5 的快照', JSON.stringify(request))
    ok(request?.missing?.[0]?.kind === 'msg-update' && request.missing[0].messageId === 'm9' && request.missing[0].fields?.includes('textDelta'), '记下缺失的消息 id 与补丁字段', JSON.stringify(request?.missing))
  }

  console.log('\n## 退避与次数上限')
  {
    const clock = fakeClock()
    const sent = []
    const scheduler = createViewResyncScheduler({ send: (request) => sent.push(request), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const runtime = { sessionId: 'S', runId: 'r1', generation: 2 }
    const need = (id) => ({ reason: 'patch-target-missing', runtime, missing: [{ kind: 'msg-update', messageId: id }] })
    const gaps = []
    for (let i = 0; i < 4; i++) {
      scheduler.request(need(`m${i}`))
      scheduler.request(need(`x${i}`))
      gaps.push(clock.pending()[0])
      clock.advance(clock.pending()[0])
    }
    ok(sent.length === 4 && sent.every((request) => !request.giveUp), '前四次照常发出', JSON.stringify(sent.map((r) => r.attempt)))
    ok(JSON.stringify(gaps) === JSON.stringify([300, 3000, 6000, 12000]), '间隔按指数退避：300ms、3s、6s、12s', JSON.stringify(gaps))
    ok(sent[0].missing.length === 2 && sent[0].missing[1].messageId === 'x0', '等待期间的缺失 id 合进同一次请求', JSON.stringify(sent[0].missing))
    scheduler.request(need('m4'))
    ok(sent.length === 5 && sent[4].giveUp === true && sent[4].missing[0].messageId === 'm4' && sent[4].reason === 'patch-target-missing', '超过上限时发一次停止记录，带原因与缺失 id', JSON.stringify(sent[4]))
    scheduler.request(need('m5'))
    clock.advance(60000)
    ok(sent.length === 5, '停止后不再按秒级频率重同步')
    clock.advance(60000)
    ok(sent.length === 6 && !sent[5].giveUp && sent[5].missing[0].messageId === 'm5', '停止后仍每 2 分钟低频重试一次，带缺失 id', JSON.stringify(sent[5]))
    scheduler.request(need('m7'))
    const retryGap = clock.pending()[0]
    ok(retryGap === 120000, '下一次低频重试仍隔 2 分钟', String(retryGap))
    clock.advance(retryGap)
    ok(sent.length === 7 && sent[6].sessionId === 'S', '长回合里持续缺失时按 2 分钟节奏重试')
    sent.splice(5, 2)
    const other = { sessionId: 'T', runId: 'r2', generation: 1 }
    scheduler.request({ reason: 'tool-target-missing', runtime: other })
    clock.advance(300)
    ok(sent.length === 6 && sent[5].sessionId === 'T', '别的会话不受影响')
    scheduler.settle('S')
    scheduler.request(need('m6'))
    clock.advance(300)
    ok(sent.length === 7 && sent[6].attempt === 1 && !sent[6].giveUp, '正常事件之后恢复，重新从第一次开始', JSON.stringify(sent[6]))
    const view = createViewResyncScheduler({ send: (request) => sent.push(request), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    for (let i = 0; i < 4; i++) {
      view.request({ reason: 'tool-target-missing' })
      clock.advance(clock.pending()[0])
    }
    view.request({ reason: 'tool-target-missing' })
    ok(sent.at(-1).giveUp === true && sent.at(-1).runId === undefined, '没有运行实例信息的请求同样会停止')
    view.settle('view')
    view.request({ reason: 'tool-target-missing' })
    ok(clock.pending()[0] === 300, '没有运行实例信息的请求在正常同步后恢复', JSON.stringify(clock.pending()))
    clock.advance(300)
    const capped = new ViewResyncGuard({ firstDelayMs: 300, baseGapMs: 3000, maxGapMs: 8000, maxAttempts: 9, windowMs: 999999 })
    for (let i = 0; i < 5; i++) capped.sent('K', 0)
    const decision = capped.decide('K', 0)
    ok(decision.kind === 'send' && decision.delayMs === 8000, '退避间隔有上限', JSON.stringify(decision))
    const decaying = new ViewResyncGuard()
    for (let i = 0; i < 4; i++) decaying.sent('K', i)
    ok(decaying.decide('K', 200000).kind === 'send', '窗口外的旧记录不再计数')
  }

  console.log('\n## 快照前先刷出未推增量：快照后紧跟的增量不重复')
  {
    const replay = (flushBeforeSnapshot) => {
      const pushes = []
      let text = ''
      const call = { id: 'c1', name: 'bash', args: { command: 'x' }, status: 'running', output: '' }
      const items = {
        liveAssistantDelta: () => null,
        streamingContent: () => ({ id: 'L', text, thinking: '', calls: [] }),
        call: (id) => (id === 'c1' ? call : undefined),
        ownerOf: (id) => (id === 'c1' ? 'L' : undefined)
      }
      const projection = new StreamProjection({ items, push: (m) => pushes.push(m), clock: { now: () => 0, mono: () => 0, setTimer: () => ({}), clearTimer: () => {} }, modelId: () => undefined, turnStartedAt: () => undefined, idleBacklog: () => 0, checkDelta: () => {} })
      projection.streaming = { id: 'L', responseDetail: 'normal', pushedText: 0, pushedThinking: 0 }
      const grow = (more, out) => { text += more; call.output += out; projection.markDirty(); projection.markToolOutput('c1') }
      const flush = () => { projection.flushNow(); projection.flushTools() }
      grow('abc', '111')
      flush()
      grow('def', '222')
      if (flushBeforeSnapshot) flush()
      pushes.push({ ch: 'sync', resync: true, payload: [user, { id: 'L', role: 'assistant', text, toolCalls: [{ ...call }] }] })
      grow('gh', '333')
      flush()
      return pushes
    }
    const apply = (pushes) => {
      const runtime = { sessionId: 'S', runId: 'r1', generation: 1 }
      const sess = session('S')
      useStore.setState({
        session: sess, runners: [runnerOf('r1', 'S', 1, { isActive: true })], activeRunnerId: 'r1', peekedSessionId: null, peekedPath: null, runTail: null,
        messages: [user, { id: 'L', role: 'assistant', text: '' }], sessionRuntimes: { S: cacheOf(runtime, sess, [user, { id: 'L', role: 'assistant', text: '' }]) }
      })
      for (const m of pushes) {
        useStore.getState().applyPush({ ...m, runtime, sessionKey: 'r1' })
        useStore.getState().applyPush({ ch: 'stats', payload: {}, runtime, sessionKey: 'r1' })
      }
      const live = useStore.getState().messages.find((m) => m.id === 'L')
      return { text: live?.text, output: live?.toolCalls?.find((c) => c.id === 'c1')?.output }
    }
    const before = apply(replay(false))
    ok(before.text === 'abcdefdefgh' && before.output === '111222222333', '不先刷出时快照后的增量会重叠（对照）', JSON.stringify(before))
    const after = apply(replay(true))
    ok(after.text === 'abcdefgh', '先刷出后正文不重复', String(after.text))
    ok(after.output === '111222333', '先刷出后工具输出不重复', String(after.output))
    const source = readFileSync('src/main/index.ts', 'utf8')
    const body = source.slice(source.indexOf('async function pushRunnerSnapshot('))
    const flushAt = body.indexOf('if (opts.resync) ag.flushLiveOutput()')
    ok(flushAt > 0 && flushAt < body.indexOf('ag.getMessages('), '重同步路径在取快照前同步刷出该实例的增量')
    const agent = readFileSync('src/main/agent.ts', 'utf8')
    ok(/flushLiveOutput\(\): void \{\s*this\.stream\.flushNow\(\)\s*this\.stream\.flushTools\(\)/.test(agent), '刷出即 flushNow 加 flushTools')
  }

  console.log('\n## 采用重同步快照后撤掉还在等的那次重同步')
  {
    const runtime = { sessionId: 'S', runId: 'r1', generation: 1 }
    const sess = session('S')
    useStore.setState({
      session: sess, runners: [runnerOf('r1', 'S', 1, { isActive: true })], activeRunnerId: 'r1', peekedSessionId: null, peekedPath: null,
      messages: [user, stale], sessionRuntimes: { S: cacheOf(runtime, sess, [user, stale]) }
    })
    useStore.getState().applyPush({ ch: 'turn-settled', payload: { sessionId: 'S', outcome: 'completed' }, runtime, sessionKey: 'r1' })
    resyncCalls.length = 0
    useStore.getState().applyPush({ ch: 'tool', payload: { msgId: 'm1', call: { id: 'b', name: 'bash' }, outputDelta: 'x', sameArgs: true }, runtime, sessionKey: 'r1' })
    useStore.getState().applyPush({ ch: 'sync', payload: [user, fresh], resync: true, runtime, sessionKey: 'r1' })
    await sleep(420)
    ok(resyncCalls.length === 0 && viewHasB(), '快照已到就不再发那次重同步', JSON.stringify(resyncCalls))
  }

  console.log('\n## 后台缓存：重同步快照直接采用，补丁按最后一个同 id 消息落地')
  {
    const runtime = { sessionId: 'S', runId: 'r1', generation: 1 }
    const sess = session('S')
    const map = { S: cacheOf(runtime, sess, [user, stale]) }
    const merged = reduceSessionRuntime(map, runtime, { ch: 'sync', payload: [user, fresh] })
    ok(!merged.S.messages[1].toolCalls.some((c) => c.id === 'b'), '普通同步在流式中仍按旧规则保留本地版本')
    const adopted = reduceSessionRuntime(map, runtime, { ch: 'sync', payload: [user, fresh], resync: true })
    ok(adopted.S.messages[1].toolCalls.some((c) => c.id === 'b'), '重同步快照覆盖缓存里的旧版本')
    const dup = reduceSessionRuntime({ S: cacheOf(runtime, sess, [{ id: 'm1', role: 'assistant', text: '旧' }, { id: 'm1', role: 'assistant', text: '' }]) }, runtime, { ch: 'msg-update', payload: { id: 'm1', patch: { textDelta: '新' } } })
    ok(dup.S.messages[0].text === '旧' && dup.S.messages[1].text === '新', '缓存与视图一样补到最后一个同 id 消息')
    const art = reduceSessionRuntime({ S: cacheOf(runtime, sess, [{ id: 'm1', role: 'assistant', text: '旧' }, { id: 'm1', role: 'assistant', text: '' }]) }, runtime, { ch: 'artifact', payload: { messageId: 'm1', artifact: { id: 'art1' } } })
    ok(!art.S.messages[0].artifacts && art.S.messages[1].artifacts?.[0]?.id === 'art1', '成果也挂到最后一个同 id 消息')
    const twin = [{ id: 'm1', role: 'assistant', text: '旧' }, { id: 'm1', role: 'assistant', text: '新' }]
    const delta = applySyncDelta(twin, { anchorId: 'm1', anchorIndex: 1, anchorSignature: (await compile('src/shared/session-sync.ts')).messageSyncSignature(twin[1]), messages: [{ id: 'm2', role: 'assistant', text: '后' }] })
    ok(delta?.length === 3 && delta[2].id === 'm2', '增量锚点按最后一个同 id 消息定位')
  }

  console.log('\n## 主进程：按请求里的运行实例重同步并核对归属，日志带缺失 id')
  {
    const runtimes = { r1: { sessionId: 'O', runId: 'r1', generation: 3 }, r5: { sessionId: 'V', runId: 'r5', generation: 7 } }
    const registry = { activeRunnerId: 'r1', runtimeOf: (id) => runtimes[id] ?? null, hasAgent: (id) => !!runtimes[id] }
    ok(resolveViewResyncTarget(registry, { reason: 'x', runId: 'r5', generation: 7, sessionId: 'V' }).runnerId === 'r5', '指定 r5 时重同步 r5')
    ok(resolveViewResyncTarget(registry, { reason: 'x' }).runnerId === 'r1', '旧请求没有实例信息时回到活动实例')
    ok(resolveViewResyncTarget(registry, { reason: 'x', runId: 'r5', generation: 6 }).why === 'generation-changed', '代次变了不重同步')
    ok(resolveViewResyncTarget(registry, { reason: 'x', runId: 'r5', sessionId: 'Q' }).why === 'session-changed', '会话归属变了不重同步')
    ok(resolveViewResyncTarget(registry, { reason: 'x', runId: 'r9' }).why === 'runner-gone', '实例不在了不重同步')
    const logs = []
    const pushed = []
    const handle = createViewResync({ registry: () => registry, pushSnapshot: async (id) => { pushed.push(id) }, log: (text) => logs.push(text) })
    const res = await handle({ reason: 'tool-target-missing', runId: 'r5', generation: 7, sessionId: 'V', attempt: 2, missing: [{ kind: 'tool-call', messageId: 'm7', callId: 'call_1' }] })
    ok(res.ok && pushed.join() === 'r5', '推送 r5 的快照')
    ok(/tool-target-missing attempt=2 runner=r5 session=V missing=tool-call:m7\/call_1/.test(logs[0]), '日志带原因、实例、缺失 id 与补丁类型', logs[0])
    const stop = await handle({ reason: 'patch-target-missing', runId: 'r5', generation: 7, sessionId: 'V', giveUp: true, attempt: 5, missing: [{ kind: 'msg-update', messageId: 'm8', fields: ['textDelta'] }] })
    ok(!stop.ok && pushed.length === 1, '停止记录不再推快照')
    ok(/^stop-auto-resync reason=patch-target-missing attempt=5 runner=r5 session=V missing=msg-update:m8\{textDelta\}/.test(logs[1]), '停止日志带原因与缺失 id', logs[1])
    const legacy = await handle('patch-target-missing')
    ok(legacy.ok && pushed.at(-1) === 'r1' && /^patch-target-missing runner=r1 session=O missing=-/.test(logs[2]), '兼容只传原因字符串的旧调用', logs[2])
  }
}, { isolate: true })
