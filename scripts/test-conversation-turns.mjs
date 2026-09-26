/**
 * 轮次投影纯逻辑（`src/shared/conversation-turns.ts`，实施-26 R1）的单测。
 *
 * 为什么值得单测：轮次切分决定「一张卡 = 一轮问答」这件事本身。
 * 切错了在界面上看不出来 —— 只会表现为「卡片串在一起」「中断的那轮不见了」
 * 「自动继续被拆成两张卡」。渲染层补不了这个洞，所以在这里钉住切分口径。
 *
 * 覆盖（对应实施-26 每片执行卡 R1 的出口）：
 *   0 轮 / 单轮 / 多轮 / 工具往返 / 只有 assistant 无 user /
 *   stopped 与 interrupted 轮可见 / logicalTurnId 缺失时按 role 退化 /
 *   logicalTurnId 与 role 顺序冲突时以前者为准 / entryId 透传。
 */

/** UIMessage 的最小构造器（这个测试只关心切分用到的字段）。 */
const mk = (over = {}) => ({
  id: over.id ?? 'm0',
  role: over.role ?? 'assistant',
  text: over.text ?? '',
  ...over
})

const timing = (logicalTurnId, extra = {}) => ({
  logicalTurnId,
  startedAt: 1000,
  endedAt: 2000,
  elapsedMs: 1000,
  terminalReason: 'completed',
  ...extra
})

export function runConversationTurnsTests(ok, mod) {
  const { buildConversationTurns } = mod

  /* ---- 0 轮 ---- */
  {
    const none = buildConversationTurns([])
    ok(none.length === 0, '空消息：0 轮，不报错')

    const onlyAssistant = buildConversationTurns([mk({ id: 'm0', text: '没有问题的回答' })])
    ok(onlyAssistant.length === 0, '只有 assistant 无 user：0 轮（没有问题的回答不成轮）')

    const leadingNoise = buildConversationTurns([
      mk({ id: 'm0', role: 'bash', text: 'ls' }),
      mk({ id: 'm1', text: '前导助手消息' })
    ])
    ok(leadingNoise.length === 0, '前导 bash / assistant 被丢弃，不构成轮')
  }

  /* ---- 单轮 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '问题' }),
      mk({ id: 'm1', role: 'assistant', text: '答案' })
    ])
    ok(turns.length === 1, '单轮：1 张卡')
    ok(turns[0]?.question.text === '问题', '单轮：question 是那条 user 消息')
    ok(turns[0]?.answer?.text === '答案', '单轮：answer 是那条 assistant 消息')
    ok(turns[0]?.incomplete === false, '单轮：有答案且 completed → 不标未完成')
    ok(turns[0]?.id === 'turn:m0', '单轮无 lid：轮 id = turn:<首条 user 的 id>')
  }

  /* ---- 多轮 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q1' }),
      mk({ id: 'm1', role: 'assistant', text: 'A1' }),
      mk({ id: 'm2', role: 'user', text: 'Q2' }),
      mk({ id: 'm3', role: 'assistant', text: 'A2' }),
      mk({ id: 'm4', role: 'user', text: 'Q3' }),
      mk({ id: 'm5', role: 'assistant', text: 'A3' })
    ])
    ok(turns.length === 3, '多轮：3 张卡')
    ok(
      turns.map((t) => t.messages.length).join(',') === '2,2,2',
      '多轮：每轮各自持有自己的消息，不串轮',
      turns.map((t) => t.messages.length).join(',')
    )
  }

  /* ---- 工具往返：过程不算答案，但仍属于这一轮 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '读一下文件' }),
      mk({
        id: 'm1',
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'c1', name: 'read', args: {}, status: 'ok' },
          { id: 'c2', name: 'grep', args: {}, status: 'ok' }
        ]
      }),
      mk({ id: 'm2', role: 'assistant', text: '最终答案' })
    ])
    ok(turns.length === 1, '工具往返：不额外成卡，仍是一轮')
    ok(turns[0]?.toolCalls === 2, '工具往返：计数 = 工具调用条数', String(turns[0]?.toolCalls))
    ok(
      turns[0]?.answer?.id === 'm2',
      '工具往返：没有正文的 assistant 不当答案，取后面有正文的那条',
      String(turns[0]?.answer?.id)
    )
  }

  /* ---- bash 直执行也计入工具往返 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '跑个命令' }),
      mk({
        id: 'm1',
        role: 'bash',
        text: 'ls',
        toolCalls: [{ id: 'm1', name: 'bash', args: {}, status: 'ok' }]
      }),
      mk({ id: 'm2', role: 'assistant', text: '输出如上' })
    ])
    ok(turns[0]?.toolCalls === 1, 'bash 直执行计入工具往返')
  }

  /* ---- 中断轮必须可见 ---- */
  {
    const stopped = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '问题' }),
      mk({ id: 'm1', role: 'assistant', text: '写了一半', turnTiming: timing('t1', { terminalReason: 'stopped' }) })
    ])
    ok(stopped.length === 1, 'stopped 轮：仍然可见，不被过滤')
    ok(stopped[0]?.incomplete === true, 'stopped 轮：标记未完成')
    ok(stopped[0]?.terminalReason === 'stopped', 'stopped 轮：终止原因透出')

    const interrupted = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '问题' }),
      mk({ id: 'm1', role: 'assistant', text: '', turnTiming: timing('t2', { terminalReason: 'interrupted' }) })
    ])
    ok(
      interrupted.length === 1 && interrupted[0]?.incomplete === true && !interrupted[0]?.answer,
      'interrupted 轮：没有最终回答也可见且标未完成'
    )

    const failed = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '问题' }),
      mk({ id: 'm1', role: 'assistant', text: '', error: '模型返回错误', turnTiming: timing('t3', { terminalReason: 'failed' }) })
    ])
    ok(failed[0]?.incomplete === true, 'failed 轮：标记未完成')
  }

  /* ---- logicalTurnId：同一回合的两条 user（自动继续）不拆卡 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '第一问', turnTiming: timing('t9') }),
      mk({ id: 'm1', role: 'assistant', text: '说明', turnTiming: timing('t9') }),
      mk({ id: 'm2', role: 'user', text: '自动继续的补充', turnTiming: timing('t9') }),
      mk({ id: 'm3', role: 'assistant', text: '最终答案', turnTiming: timing('t9') })
    ])
    ok(turns.length === 1, '同一 logicalTurnId 的多条 user：合为一轮（自动继续不拆卡）')
    ok(turns[0]?.id === 't9', '有 lid：轮 id 用 logicalTurnId', String(turns[0]?.id))
    ok(turns[0]?.question.id === 'm0', '合轮后 question 仍是本轮第一条 user')
    ok(turns[0]?.messages.length === 4, '合轮后消息不丢', String(turns[0]?.messages.length))

    const two = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q1', turnTiming: timing('t1') }),
      mk({ id: 'm1', role: 'assistant', text: 'A1', turnTiming: timing('t1') }),
      mk({ id: 'm2', role: 'user', text: 'Q2', turnTiming: timing('t2') }),
      mk({ id: 'm3', role: 'assistant', text: 'A2', turnTiming: timing('t2') })
    ])
    ok(two.length === 2 && two[1]?.id === 't2', '不同 logicalTurnId：正常切成两轮')
  }

  /* ---- lid 与 role 顺序冲突：以 lid 为准 ---- */
  {
    /*
     * 真实形态：旧历史（无 lid）在前、新回合（有 lid）在后。
     * lid 一旦出现就接管 —— 新消息不能因为「有 user」而挂到旧轮上。
     */
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: '旧 Q' }),
      mk({ id: 'm1', role: 'assistant', text: '旧 A' }),
      mk({ id: 'm2', role: 'user', text: '新 Q', turnTiming: timing('t5') }),
      mk({ id: 'm3', role: 'assistant', text: '新 A', turnTiming: timing('t5') })
    ])
    ok(
      turns.length === 2 && turns[0]?.id === 'turn:m0' && turns[1]?.id === 't5',
      '旧历史 + 新回合：lid 接管，两轮 id 各自正确',
      turns.map((t) => t.id).join(',')
    )
  }

  /* ---- 退化：lid 缺失时按 role 顺序 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q1' }),
      mk({ id: 'm1', role: 'assistant', text: 'A1' }),
      mk({ id: 'm2', role: 'user', text: 'Q2' }),
      mk({ id: 'm3', role: 'assistant', text: 'A2' })
    ])
    ok(
      turns.map((t) => t.id).join(',') === 'turn:m0,turn:m2',
      '旧历史（无 lid）：按 role 顺序退化，id 用 user 消息 id',
      turns.map((t) => t.id).join(',')
    )
  }

  /* ---- entryId（R0① 的落点）：透传为 fork 锚点 ---- */
  {
    const turns = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q1', entryId: '90ac64b9' }),
      mk({ id: 'm1', role: 'assistant', text: 'A1', entryId: '23cb6928' })
    ])
    ok(turns[0]?.question.entryId === '90ac64b9', 'entryId 透传到 question（分叉锚点）')
    ok(turns[0]?.answer?.entryId === '23cb6928', 'entryId 透传到 answer')
  }

  /* ---- 起止时间：优先 turnTiming，缺失时退回消息 timestamp ---- */
  {
    const timed = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q', turnTiming: timing('t1', { startedAt: 111, endedAt: 222 }) }),
      mk({ id: 'm1', role: 'assistant', text: 'A', turnTiming: timing('t1', { startedAt: 111, endedAt: 222 }) })
    ])
    ok(timed[0]?.startedAt === 111 && timed[0]?.endedAt === 222, '起止时间优先取 turnTiming')

    const plain = buildConversationTurns([
      mk({ id: 'm0', role: 'user', text: 'Q', timestamp: 5 }),
      mk({ id: 'm1', role: 'assistant', text: 'A', timestamp: 9 })
    ])
    ok(plain[0]?.startedAt === 5 && plain[0]?.endedAt === 9, '没有 turnTiming 时退回消息 timestamp')
  }
}
