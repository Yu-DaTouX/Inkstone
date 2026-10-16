const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0 }

export async function runStreamDeltasTests(ok) {
  const { AgentController } = await import('../out/test/agent.mjs')

  const pushes = []
  const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
  const emit = (e) => ctl.handleEvent(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const updates = () => pushes.filter((m) => m.ch === 'msg-update')
  const toolPushes = () => pushes.filter((m) => m.ch === 'tool')
  const lastUpdate = () => updates().at(-1)
  const lastTool = () => toolPushes().at(-1)

  emit({ type: 'message_start', message: { role: 'assistant' } })
  const addPush = pushes.find((m) => m.ch === 'msg-add')
  ok(!!addPush, 'message_start 推了 msg-add')
  const streamId = addPush.payload.id

  const chunks = ['第一段', '，第二段', '，第三段']
  for (const t of chunks) {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: t }, usage: USAGE })
  }
  await wait(80)

  const joined = updates()
    .map((m) => m.payload.patch.textDelta ?? '')
    .join('')
  ok(joined === chunks.join(''), `textDelta 拼接 == 全文`, joined)
  ok(
    updates().every((m) => m.payload.patch.text === undefined),
    '流式帧不再携带全量 text（否则又回到 O(N²) 重传）'
  )
  ok(
    updates().every((m) => m.payload.patch.toolCalls === undefined),
    '流式帧不再携带 toolCalls 全量'
  )
  ok(
    updates().every((m) => m.payload.id === streamId),
    '流式帧的 id 指向正在流的那条消息'
  )

  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '一下' } })
  await wait(80)
  const thinking = updates()
    .map((m) => m.payload.patch.thinkingDelta ?? '')
    .join('')
  ok(thinking === '想一下', `thinkingDelta 拼接 == 全文`, thinking)

  emit({
    type: 'tool_execution_start',
    toolCallId: 'tc-1',
    toolName: 'bash',
    args: { command: 'echo hi' }
  })
  ok(!!lastTool(), 'tool_execution_start 全量推了工具')
  ok(lastTool().payload.outputDelta === undefined, '首个通告是全量（不带 delta）')
  ok(lastTool().payload.msgId === streamId, '工具挂到了正在流的消息上')

  const line = 'x'.repeat(100)
  let acc = ''
  for (let batch = 0; batch < 20; batch++) {
    for (let i = 0; i < 10; i++) {
      acc += line + '\n'
      emit({
        type: 'tool_execution_update',
        toolCallId: 'tc-1',
        partialResult: { content: [{ type: 'text', text: acc }] }
      })
    }
    await wait(40)
  }
  await wait(120)

  const deltas = toolPushes().filter((m) => m.payload.outputDelta !== undefined)
  const joinedOut = deltas.map((m) => m.payload.outputDelta).join('')
  ok(joinedOut === acc, `outputDelta 拼接 == 完整输出（${acc.length} 字符）`, `${joinedOut.length}`)
  ok(deltas.length < 60, `200 个 chunk 被节流成 ${deltas.length} 次推送`)
  ok(
    deltas.every((m) => m.payload.call.output === undefined),
    '增量帧不带全量 output'
  )

  const deltaBytes = deltas.reduce((a, m) => a + JSON.stringify(m).length, 0)
  const naiveBytes = deltas.reduce((a, m, i) => {
    const upto = Math.round((acc.length * (i + 1)) / deltas.length)
    return a + JSON.stringify({ ch: 'tool', payload: { msgId: streamId, call: { output: 'x'.repeat(upto) } } }).length
  }, 0)
  ok(
    deltaBytes < naiveBytes / 3,
    `增量总字节 ${deltaBytes}B 远小于全量重传的 ${naiveBytes}B`
  )
  ok(
    Math.max(...deltas.map((m) => JSON.stringify(m).length)) < acc.length,
    '单帧体积小于最终输出总量（增量而不是快照）'
  )

  emit({
    type: 'tool_execution_end',
    toolCallId: 'tc-1',
    result: { content: [{ type: 'text', text: acc }] },
    isError: false
  })
  const endPush = lastTool()
  ok(endPush.payload.outputDelta === undefined && endPush.payload.call.output === acc, '结束时发全量快照')
  ok(endPush.payload.call.status === 'ok', '结束状态 = ok')
  ok(typeof endPush.payload.call.endedAt === 'number', '结束写了 endedAt（界面要靠它算耗时）')

  const afterEnd = toolPushes().length
  emit({
    type: 'tool_execution_update',
    toolCallId: 'tc-1',
    partialResult: { content: [{ type: 'text', text: acc }] }
  })
  await wait(80)
  ok(toolPushes().length === afterEnd, '结束后输出没变 → 不产生多余推送（不会重复追加尾巴）')

  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      text: chunks.join(''),
      usage: USAGE,
      stopReason: 'stop',
      timestamp: Date.now()
    }
  })
  const endPatch = lastUpdate().payload.patch
  ok(endPatch.text === chunks.join(''), 'message_end 发全量 text（权威对齐）')
  ok(endPatch.thinking === '想一下', 'message_end 发全量 thinking')
  ok(endPatch.toolCalls?.length === 1, 'message_end 带上工具数组')
  ok(endPatch.toolCalls?.[0]?.output === acc, 'message_end 里工具是最终输出')

  emit({ type: 'tool_execution_update', toolCallId: 'not-exist', partialResult: { content: [] } })
  await wait(40)
  ok(true, '未知 toolCallId 的更新被安全忽略')

  const beforeHydrate = toolPushes().length
  ok(beforeHydrate > 0, '工具推送有记录（用于后面的索引断言）')
}
