import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { messageIndex, replaceIndexedMessage, reduceSessionRuntime } = await compile('', {
    stdin: {
      contents: `
        export * from './src/renderer/src/state/message-index'
        export { reduceSessionRuntime } from './src/renderer/src/state/session-runtime'
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    }
  })
  const user = { id: 'u', role: 'user', text: 'prompt' }
  const history = Array.from({ length: 2000 }, (_, i) => ({ id: `history-${i}`, role: 'assistant', text: 'old' }))
  const tail = { id: 'tail', role: 'assistant', text: 'a' }
  const messages = [user, ...history, tail]
  const tailPosition = messages.length - 1
  const deltas = Array.from({ length: 24 }, (_, i) => ({ ...tail, text: `chunk-${i}` }))
  const snapshots = deltas.reduce((all, patch) => [...all, replaceIndexedMessage(all.at(-1), tailPosition, patch)], [messages])
  const layout = messageIndex(snapshots.at(-1))
  ok(snapshots.every((snapshot) => messageIndex(snapshot) === layout), '文本增量链共用同一份长历史索引，即使首次读取发生在最后一帧')
  ok(messages.at(-1).text === 'a' && snapshots.at(-1).at(-1).text === 'chunk-23' && snapshots.at(-1)[1] === history[0], '增量保留历史消息引用和旧快照内容')
  ok(layout.firstAssistantId === 'history-0' && layout.lastMessageId === 'tail' && layout.pos.get('tail') === tailPosition, '共用索引的首末回合与位置正确')
  const withIdChange = messageIndex(replaceIndexedMessage(messages, tailPosition, { ...tail, id: 'u' }))
  ok(withIdChange !== layout && withIdChange.pos.get('u') === 0 && !withIdChange.pos.has('tail') && withIdChange.lastMessageId === 'u', 'ID 变化重建索引，保留重复 ID 的首次位置语义')
  const withRoleChange = messageIndex(replaceIndexedMessage(messages, 0, { ...user, role: 'assistant' }))
  ok(withRoleChange !== layout && withRoleChange.firstAssistantId === 'u', '角色变化重建首条回答位置')
  const reordered = messageIndex([tail, user])
  ok(reordered !== layout && reordered.firstAssistantId === 'tail' && reordered.lastMessageId === 'u', '新会话或完整快照不沿用其他列表的布局')

  const runtime = { runId: 'test-run', generation: 1, sessionId: 'test-session' }
  const initial = reduceSessionRuntime({}, runtime, { ch: 'sync', payload: messages })
  const changed = reduceSessionRuntime(initial, runtime, { ch: 'msg-update', payload: { id: 'tail', patch: { textDelta: 'b' } } })
  const previousMessages = Object.values(initial)[0].messages
  const changedMessages = Object.values(changed)[0].messages
  ok(changedMessages.at(-1).text === 'ab' && messageIndex(changedMessages) === messageIndex(previousMessages), '运行时会话实际处理文本增量时共用索引')

  const { viewSubagentMetrics } = await compile('src/renderer/src/state/subagent-view.ts')
  const runner = { id: 'runner', runId: 'run-a', sessionId: 'a', sessionFile: 'C:/proj/a.jsonl' }
  const run = { id: 'child', parentSessionId: 'a', status: 'running', usage: { input: 5, output: 3, cost: 0.5 } }
  const childByRunner = { id: 'detached', parentRunId: 'run-a', status: 'done', usage: { totalTokens: 2, cost: 0.25 } }
  const other = { id: 'foreign', parentSessionId: 'b', status: 'done', usage: { totalTokens: 100, cost: 100 } }
  const state = { peekedSessionId: null, peekedPath: null, session: { sessionId: 'a', sessionFile: runner.sessionFile }, runners: [runner], subagents: [{ ...run, status: 'done' }, run, childByRunner, other] }
  const metrics = viewSubagentMetrics(state)
  ok(metrics.total === 2 && metrics.live === 1 && metrics.tokens === 10 && metrics.cost === 0.75, '右栏仅汇总当前会话归属的任务，重复任务以后一个快照为准')
  const liveState = { ...state, messages: snapshots[1], session: { ...state.session, isStreaming: true } }
  ok(viewSubagentMetrics(liveState) === metrics, '消息与运行标志改变时复用右栏任务派生对象')
  const otherMetrics = viewSubagentMetrics({ ...state, peekedSessionId: 'b' })
  ok(otherMetrics !== metrics && otherMetrics.total === 1 && otherMetrics.live === 0 && otherMetrics.tokens === 100, '浏览其他会话时立即失效')
  ok(viewSubagentMetrics({ ...state, peekedPath: runner.sessionFile }).tokens === 2, '仅按路径浏览时只计入匹配运行实例的无会话任务')
  ok(viewSubagentMetrics({ ...state, runners: [{ ...runner, runId: 'new-run' }] }).total === 1, '运行实例切换时重新匹配归属')
  ok(viewSubagentMetrics({ ...state, session: { ...state.session, conversationId: 'b' } }).total === 3, '会话的对话 ID 变化时重新匹配归属')
  const settled = viewSubagentMetrics({ ...state, subagents: [{ ...run, status: 'done' }, childByRunner, other] })
  ok(settled.total === 2 && settled.live === 0 && settled.tokens === 10, '任务数组变化时刷新运行状态')

  const { createTurnFindTexts } = await compile('src/renderer/src/features/session/session-find.ts')
  const findTexts = createTurnFindTexts()
  const firstTurn = { kind: 'user', id: user.id, msg: user }
  const pending = { kind: 'pending', id: '__pending__' }
  const liveTurn = { kind: 'assistant', id: tail.id, response: { text: 'original' }, commentary: [{ text: 'tool commentary' }] }
  const oldTurns = [firstTurn, liveTurn, pending]
  const before = findTexts(oldTurns)
  ok(findTexts(oldTurns) === before && before[2].text === '', '同一轮列表复用查找文本，待回复占位不参与文本匹配')
  const updated = findTexts([firstTurn, { ...liveTurn, response: { text: 'new' } }])
  ok(updated !== before && updated[0] === before[0] && updated[1] !== before[1] && updated[1].text === 'new\ntool commentary', '稳定历史回合复用查找条目，同 ID 的新输出更新正文')
  const switched = findTexts([{ ...firstTurn, msg: { ...user, text: 'another session' } }])
  ok(switched[0] !== before[0] && switched[0].text === 'another session', '切换到复用消息 ID 的会话不读取旧查询文本')
})
