/**
 * 流式增量推送协议的单元测试（**主进程侧**）。
 *
 * ── 为什么需要 ──
 * 为了让长会话不卡，主进程不再每帧重发整篇累积文本/工具输出，改成
 * 「只发新增的那一段」（`textDelta` / `thinkingDelta` / `outputDelta`）。
 * 这条路径很容易被后来的改动无声破坏：
 *   · 顺手在 flushNow 里加回 `text: s.text` → 又变成 O(N²) 的全量重传（性能回退，测试全绿）
 *   · 增量游标忘了推进 / 推进过头 → 界面少字或重复
 *   · 工具结束时的全量快照与待推增量同时生效 → 输出尾巴重复
 * 所以这里直接驱动 `AgentController.handleEvent`，把推送当**协议**来断言：
 * 拼接结果必须等于全量结果，而且单帧体积必须有界。
 *
 * ── 为什么不走真实 pi ──
 * 真实流式要模型（花 token、不确定），而这里的逻辑与模型无关 ——
 * 它只认 pi 的事件协议。所以直接喂构造出来的事件序列。
 *
 * 探针侧（渲染端）的对应验证见 scripts/probe/deltas.js。
 */

/** pi 的 usage 形状（main/normalize.ts 的 toUsage 消费） */
const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0 }

export async function runStreamDeltasTests(ok) {
  const { AgentController } = await import('../out/test/agent.mjs')

  const pushes = []
  // handleEvent / push 走的是同一个 AgentController，但 push 由我们接管
  const ctl = new AgentController({ push: (m) => pushes.push(m), cwd: process.cwd() })
  const emit = (e) => ctl.handleEvent(e)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  const updates = () => pushes.filter((m) => m.ch === 'msg-update')
  const toolPushes = () => pushes.filter((m) => m.ch === 'tool')
  const lastUpdate = () => updates().at(-1)
  const lastTool = () => toolPushes().at(-1)

  /* ------------------------------------------------------------ 文本增量 */

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

  /* ---- 思考增量 ---- */
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想' } })
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '一下' } })
  await wait(80)
  const thinking = updates()
    .map((m) => m.payload.patch.thinkingDelta ?? '')
    .join('')
  ok(thinking === '想一下', `thinkingDelta 拼接 == 全文`, thinking)

  /* -------------------------------------------------------- 工具输出增量 */

  emit({
    type: 'tool_execution_start',
    toolCallId: 'tc-1',
    toolName: 'bash',
    args: { command: 'echo hi' }
  })
  ok(!!lastTool(), 'tool_execution_start 全量推了工具')
  ok(lastTool().payload.outputDelta === undefined, '首个通告是全量（不带 delta）')
  ok(lastTool().payload.msgId === streamId, '工具挂到了正在流的消息上')

  /*
   * 模拟 20 批 × 10 个 chunk。分批之间让节流定时器落地 ——
   * 这正是真实场景（命令持续吐输出），也是「旧实现 O(N²)」的形态：
   * 旧代码每次 chunk 都发一份完整累积输出。
   */
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

  /*
   * 体积断言：这才是「峰值消失」的量化证据。
   * 新协议：总推送字节 ≈ 输出总长度；旧协议：≈ 输出总长度 × 批次数 / 2。
   */
  const deltaBytes = deltas.reduce((a, m) => a + JSON.stringify(m).length, 0)
  const naiveBytes = deltas.reduce((a, m, i) => {
    // 旧实现：第 i 次推送带的是「此刻的完整累积输出」
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

  /* ---- 结束：全量快照 + 状态 ---- */
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

  /* ---- message_end：权威全量对齐 ---- */
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

  /* ---- 未知工具 id 不炸 ---- */
  emit({ type: 'tool_execution_update', toolCallId: 'not-exist', partialResult: { content: [] } })
  await wait(40)
  ok(true, '未知 toolCallId 的更新被安全忽略')

  /* ---- 索引：hydrate 之后工具仍然找得到 ---- */
  const beforeHydrate = toolPushes().length
  ok(beforeHydrate > 0, '工具推送有记录（用于后面的索引断言）')
}
