export async function runTurnTests(ok) {
  const { groupIntoTurns, createTurnProjector, splitParagraphs, cacheHitRate, formatHitRate, addUsage, hasUsageNumbers, toolWaitSpans, waitSpansMs } =
    await import('../out/test/turns.mjs')

  {
    const project = createTurnProjector()
    const history = [{ id: 'cache-u', role: 'user', text: 'History' }, { id: 'cache-a', role: 'assistant', text: 'Stable answer' }]
    const question = { id: 'live-u', role: 'user', text: 'Current task' }
    let current = { id: 'live-a', role: 'assistant', text: 'First', toolCalls: [{ id: 'tool-live', name: 'read', status: 'running' }] }
    const first = project([...history, question, current], current.id)
    current = { ...current, text: 'First\n\nMore', toolCalls: [{ ...current.toolCalls[0], status: 'done', output: 'Result' }] }
    let rows = [...history, question, current]
    const second = project(rows, current.id)
    ok(first[1] === second[1], '流式更新复用已完成历史回合身份')
    ok(JSON.stringify(second) === JSON.stringify(groupIntoTurns(rows, current.id)), '工具状态与文字增量的缓存投影等同完整投影')
    ok(JSON.stringify(project(rows)) === JSON.stringify(groupIntoTurns(rows)), '流式结束使当前回合转为完成状态')
    const editedHistory = [history[0], { ...history[1], text: 'Edited history' }, question, current]
    ok(JSON.stringify(project(editedHistory)) === JSON.stringify(groupIntoTurns(editedHistory)), '历史编辑使对应缓存失效')
    const noticeBefore = {
      id: 'notice-a',
      role: 'assistant',
      text: '通知前已答',
      elapsedMs: 1200,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0 }
    }
    const noticeAfter = {
      id: 'notice-b',
      role: 'assistant',
      text: '通知后继续',
      elapsedMs: 300,
      usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 }
    }
    const noticeRows = [
      question,
      noticeBefore,
      { id: 'hidden-notice', role: 'user', text: '<subagent-notification id="x" status="done">\nResult\n</subagent-notification>' },
      noticeAfter
    ]
    const noticeProjected = project(noticeRows)
    ok(JSON.stringify(noticeProjected) === JSON.stringify(groupIntoTurns(noticeRows)), '隐藏宿主通知的投影与分组同口径')
    ok(!noticeProjected.some((t) => t.kind === 'user' && t.id === 'hidden-notice'), '隐藏宿主通知不生成用户气泡')
    const noticeAssistants = noticeProjected.filter((t) => t.kind === 'assistant')
    ok(
      noticeAssistants.length === 2 &&
        noticeAssistants[0].id === 'notice-a' && noticeAssistants[0].elapsedMs === 1200 && noticeAssistants[0].usage?.totalTokens === 15 &&
        noticeAssistants[1].id === 'notice-b' && noticeAssistants[1].elapsedMs === 300 && noticeAssistants[1].usage?.totalTokens === 10,
      '通知把助手拆成两段：原段 id/elapsed/usage 冻结，后段独立计时',
      JSON.stringify(noticeAssistants.map((t) => ({ id: t.id, elapsedMs: t.elapsedMs, total: t.usage?.totalTokens })))
    )
    rows = [current, { id: 'shell-cache', role: 'bash', text: 'shell output' }, ...history]
    ok(JSON.stringify(project(rows)) === JSON.stringify(groupIntoTurns(rows)), '开头助手消息、bash边界与重排保持完整投影语义')
    ok(project([]).length === 0 && JSON.stringify(project(history)) === JSON.stringify(groupIntoTurns(history)), '切换空会话及返回历史不会混入旧投影')
  }

  const asst = (id, text, extra = {}) => ({ id, role: 'assistant', text, ...extra })
  const usr = (id, text) => ({ id, role: 'user', text })
  const tool = (id, name, status = 'ok') => ({ id, name, args: {}, status })

  {
    const notice = '<subagent-notification id="sub-1" status="done">\n后台结果\n</subagent-notification>'
    const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: 0 })
    const messages = [
      usr('u1', '继续任务'),
      asst('a1', '等待子代理', { elapsedMs: 1200, usage: usage(10, 5) }),
      usr('u2', notice),
      asst('a2', '收到结果，继续', { elapsedMs: 300, usage: usage(7, 3) })
    ]
    const turns = groupIntoTurns(messages)
    ok(turns.length === 3 && turns[0].kind === 'user', '宿主通知不生成用户气泡（不新增用户轮）', `实际 ${turns.length} 轮`)
    ok(turns[1]?.kind === 'assistant' && turns[1].id === 'a1' && turns[2]?.kind === 'assistant' && turns[2].id === 'a2', '宿主通知把助手拆成两个独立段')
    ok(
      turns[1]?.elapsedMs === 1200 && turns[1]?.usage?.totalTokens === 15 && JSON.stringify(turns[1]?.sourceIds) === JSON.stringify(['a1']),
      '通知前已结束段 id/elapsed/usage 冻结',
      JSON.stringify({ id: turns[1]?.id, elapsedMs: turns[1]?.elapsedMs, usage: turns[1]?.usage })
    )
    ok(
      turns[2]?.elapsedMs === 300 && turns[2]?.usage?.totalTokens === 10 && JSON.stringify(turns[2]?.sourceIds) === JSON.stringify(['a2']),
      '通知后新段独立计时，不复制旧段用量',
      JSON.stringify({ id: turns[2]?.id, elapsedMs: turns[2]?.elapsedMs, usage: turns[2]?.usage })
    )
    ok(JSON.stringify(createTurnProjector()(messages)) === JSON.stringify(turns), '隐藏通知的投影与分组同口径')
  }

  console.log('\n--- 11. 回合分组（消息合并）---')

  {
    const t = groupIntoTurns([
      usr('u1', '帮我改标题'),
      asst('a1', '我先看看实现', { responseDetail: 'detailed', toolCalls: [tool('t1', 'read')] }),
      asst('a2', '找到了，改成独立进程', { toolCalls: [tool('t2', 'edit')] }),
      asst('a3', '改好了，三处改动：\n1. a\n2. b')
    ])
    ok(t.length === 2, '带工具的回合合成 2 块（用户 + 助手）', `实际 ${t.length}`)
    const a = t[1]
    ok(a?.kind === 'assistant', '第二块是助手回合')
    ok(a.tools.length === 2, '工具调用合并为 2 条', `实际 ${a.tools.length}`)
    ok(a.commentary.length === 2, '前面两条文字归为解说', `实际 ${a.commentary.length}`)
    ok(a.response?.text.startsWith('改好了'), '最后一条文字成为最终回答')
    ok(a.sourceIds.length === 3, '记录了 3 条原始消息', `实际 ${a.sourceIds.length}`)
    ok(a.responseDetail === 'detailed', '回合保留第一条 assistant 的实际回复档位')
  }

  {
    const msgs = [usr('u1', 'x')]
    for (let i = 0; i < 34; i++) {
      msgs.push(asst('a' + i, '第 ' + i + ' 段', { toolCalls: [tool('t' + i, 'bash')] }))
    }
    const t = groupIntoTurns(msgs)
    ok(t.length === 2, '34 条连续 assistant 合并成 1 块', `实际 ${t.length} 块`)
    ok(t[1].tools.length === 34, '工具一条不丢', `实际 ${t[1].tools.length}`)
    ok(t[1].commentary.length === 33, '33 段解说 + 1 段回答', `实际 ${t[1].commentary.length}`)
  }

  {
    const t = groupIntoTurns([usr('u1', '你好'), asst('a1', '你好，我是砚')])
    ok(t.length === 2 && t[1].tools.length === 0, '纯回答回合：无工具')
    ok(t[1].response?.text === '你好，我是砚', '纯回答成为 response')
    ok(t[1].commentary.length === 0, '没有冤枉的解说')
    ok(t[1].responseDetail === 'unknown', '没有元数据的旧消息显示为未知档位')
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '我先读一下', { toolCalls: [tool('t1', 'read')] })
    ])
    const a = t[1]
    ok(a.response?.text === '我先读一下', '末尾无正文时把最后一条解说提升为回答')
    ok(a.commentary.length === 0, '提升后解说为空（不重复显示）')
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '好'),
      {
        id: 'b1',
        role: 'bash',
        text: 'git status',
        bash: { command: 'git status', exitCode: 0, cancelled: false }
      }
    ])
    ok(t.length === 3, 'bash 独立成块', `实际 ${t.length}`)
    ok(t[2].kind === 'bash', '第三块是 bash')
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '', { thinking: '想第一步', thinkingMs: 1000, toolCalls: [tool('t1', 'read')] }),
      asst('a2', '', { thinking: '想第二步', thinkingMs: 2000, toolCalls: [tool('t2', 'edit')] }),
      asst('a3', '好了')
    ])
    const a = t[1]
    ok(a.thinking.includes('想第一步') && a.thinking.includes('想第二步'), '多段思考合并')
    ok(a.thinkingMs === 3000, '思考耗时累加', `实际 ${a.thinkingMs}`)
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '失败了', { error: 'API 超时' }),
      asst('a2', '重试成功')
    ])
    ok(t[1].error === 'API 超时', '来回多次后错误仍然保留')
  }

  {
    const t = groupIntoTurns([usr('u1', 'x'), asst('a1', '在写'), asst('a2', '接着写')], 'a2')
    ok(t[1].streaming === true, '正在流式的那条消息让回合标记为 streaming')
    const t2 = groupIntoTurns([usr('u1', 'x'), asst('a1', '写完了')], undefined)
    ok(t2[1].streaming === false, '没有流式 id 时不是 streaming')
  }

  {
    const t = groupIntoTurns([])
    ok(Array.isArray(t) && t.length === 0, '空消息数组 → 空回合数组（不抛）')
  }

  {
    const msgs = [usr('u1', '帮我查 MCP')]
    msgs.push(asst('a0', '早上好！让我先看看你环境里的 MCP 配置。', { toolCalls: [tool('t0a', 'bash'), tool('t0b', 'recall')] }))
    for (let i = 1; i <= 15; i++) {
      msgs.push(asst('a' + i, '', { toolCalls: [tool('t' + i + 'a', 'bash'), tool('t' + i + 'b', 'bash')] }))
    }
    msgs.push(asst('a16', '早上好 ☀️ 查完了，先给结论。\n\n## 一、pi 本身没有内置 MCP'))

    const t = groupIntoTurns(msgs)
    const a = t[1]
    ok(t.length === 2, '真实形态：17 条 assistant → 1 块', `实际 ${t.length}`)
    ok(a.tools.length === 32, '工具合计 32 条（2 + 15×2）', `实际 ${a.tools.length}`)
    ok(a.commentary.length === 1, '领起句归为解说', `实际 ${a.commentary.length}`)
    ok(a.response?.text.startsWith('早上好 ☀️'), '结论成为回复')
    ok(
      a.response?.text.includes('## 一、pi 本身没有内置 MCP'),
      '回复完整（正文没被切断）'
    )
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a0', '我先看看', { toolCalls: [tool('t1', 'bash')] }),
      asst('a1', '这是正文，很长很长的一段结论。'),
      asst('a2', '说一声就走。')
    ])
    const a = t[1]
    ok(a.commentary.length === 1, '只有领起句是解说', `实际 ${a.commentary.length}`)
    ok(
      !!a.response?.text.includes('这是正文，很长很长的一段结论。'),
      '正文在回复里（没有被归到解说）'
    )
    ok(!!a.response?.text.includes('说一声就走。'), '后续的无工具消息也并入回复')
  }

  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a0', '先读文件', { toolCalls: [tool('t1', 'read')] }),
      asst('a1', '读完了，现在改', { toolCalls: [tool('t2', 'edit')] }),
      asst('a2', '改完了，总结：……')
    ])
    const a = t[1]
    ok(a.commentary.length === 2, '阶段过渡的是解说（首句 + 中间句）', `实际 ${a.commentary.length}`)
    ok(a.response?.text.startsWith('改完了'), '最后阶段之后的才是回复')
  }

  {
    const t = groupIntoTurns([
      usr('u1', '生成一张图'),
      asst('a1', '我开始生成。', {
        imageProgress: [{ id: 'img-1', stage: 'generating', startedAt: 10, updatedAt: 20 }]
      }),
      asst('a2', '', {
        imageProgress: [{ id: 'img-1', stage: 'done', startedAt: 10, updatedAt: 30, endedAt: 30 }]
      })
    ])
    const a = t[1]
    ok(a.imageProgress.length === 1, '生图进度同一 id 不重复堆叠')
    ok(a.imageProgress[0]?.stage === 'done', '生图进度保留最新终态')
  }

  console.log('\n--- 12. 段落拆分（按段落显示）---')
  {
    ok(splitParagraphs('一段').length === 1, '单段 → 1')
    ok(splitParagraphs('第一段\n\n第二段').length === 2, '空行分段 → 2')
    ok(splitParagraphs('第一段\n第二段').length === 1, '单换行不分段（markdown soft break）')

    const code = '说明：\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n结论'
    const parts = splitParagraphs(code)
    ok(parts.length === 3, '代码块内的空行不切段 → 3 段', `实际 ${parts.length}`)
    ok(parts[1].includes('const b = 2'), '代码块保持完整（高亮不会废）')
    ok(parts[1].startsWith('```ts'), '代码块保留了语言标记')

    ok(splitParagraphs('   \n  \n ').length === 0, '全空白 → 0 段')

    const open = '看这个：\n\n```ts\nconst a = 1'
    const op = splitParagraphs(open)
    ok(op.length === 2, '未闭合的围栏也能切出前面的段落', `实际 ${op.length}`)
  }

  console.log('\n--- 13. 缓存命中率 ---')
  {
    const u = (input, cacheRead, cacheWrite = 0) => ({
      input,
      output: 0,
      cacheRead,
      cacheWrite,
      totalTokens: 0,
      cost: 0
    })

    ok(cacheHitRate(undefined) === null, '没有 usage → null')
    ok(cacheHitRate(u(0, 0)) === null, '全 0 → null（不能算出 NaN）')

    const r = cacheHitRate(u(467, 124032))
    ok(Math.abs(r - 99.625) < 0.01, '命中率 = cacheRead/(input+cacheRead+cacheWrite)', `实际 ${r?.toFixed(3)}`)
    ok(cacheHitRate(u(0, 100)) === 100, '全是缓存命中 → 100%')
    ok(cacheHitRate(u(100, 0)) === 0, '完全没命中 → 0%')
    const withWrite = cacheHitRate(u(467, 124032, 21468))
    ok(
      Math.abs(withWrite - (124032 / (467 + 124032 + 21468)) * 100) < 1e-9,
      '缓存写入计入分母，长会话不会虚高到 ≈100%',
      `实际 ${withWrite?.toFixed(3)}`
    )

    ok(formatHitRate(99.98) === '99.98%', '99.98% 保留两位小数（不再写 ≈100%）')
    ok(formatHitRate(92.44) === '92.44%', '92.44% 保留两位小数')
    ok(formatHitRate(0) === '0.00%', '0% 也有显示')
    ok(formatHitRate(null) === null, 'null 不显示')
    ok(formatHitRate(100) === '100%', '只有真满命中才显示 100%')
    ok(formatHitRate(99.999) === '99.99%', '99.999% 截断成 99.99%，不能四舍五入成 100%')
    ok(formatHitRate(99.995) === '99.99%', '99.995% 同样截断，不显示 ≈ 也不显示 100%')
  }

  console.log('\n--- 14. 整轮用量聚合（H-6b） ---')
  {
    const msg = (over = {}) =>
      ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, ...over })

    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '中间', { toolCalls: [tool('t1', 'read')], usage: msg({ input: 10, output: 1, totalTokens: 11 }) }),
      asst('a2', '答完', { usage: msg({ input: 10, output: 50, cacheRead: 900, cacheWrite: 5, totalTokens: 960, cost: 0.02 }) })
    ])
    const u = t[1].usage
    ok(u?.output === 51, '整轮输出 = 1 + 50（每条消息是该次请求的独立用量，不是累计值）', `实际 ${u?.output}`)
    ok(u?.input === 20, '整轮输入 = 10 + 10', `实际 ${u?.input}`)
    ok(u?.cacheRead === 900 && u?.cacheWrite === 5, 'cacheRead / cacheWrite 同步相加')
    ok(Math.abs((u?.cost ?? 0) - 0.02) < 1e-9, 'cost 相加')
    ok(t[1].usagePartial === undefined, '两条都报了用量 → 不标 partial')

    const t2 = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '中间', { toolCalls: [tool('t1', 'read')] }),
      asst('a2', '答完', { usage: msg({ input: 10, output: 5 }) })
    ])
    ok(t2[1].usage?.output === 5, '没有用量的那条不参与相加', `实际 ${t2[1].usage?.output}`)
    ok(t2[1].usagePartial === true, '有请求没报用量 → 标 partial（界面显示 ≥）')

    const t3 = groupIntoTurns([usr('u1', 'x'), asst('a1', '答完')])
    ok(t3[1].usage === undefined, '一条都没报 → 无用量')
    ok(t3[1].usagePartial === undefined, '一条都没报不算 partial（未知 ≠ 部分）')

    ok(addUsage(undefined, undefined) === undefined, 'addUsage 两端都空 → undefined')
    ok(addUsage(undefined, msg({ output: 3 }))?.output === 3, 'addUsage 缺一端 → 原样返回另一端')
    ok(hasUsageNumbers(undefined) === false, '缺失不算有用量')
    ok(hasUsageNumbers(msg()) === false, '全 0 不算有用量（流式途中可能先报全 0）')
    ok(hasUsageNumbers(msg({ cacheWrite: 1 })) === true, '只有 cacheWrite 也算有用量')
  }

  console.log('\n--- 14.5 工具等待分段（H-6b） ---')
  {
    const t1 = { id: 't1', name: 'bash', args: {}, status: 'ok', startedAt: 1000, endedAt: 2000 }
    const t2 = { id: 't2', name: 'bash', args: {}, status: 'ok', startedAt: 1500, endedAt: 3000 }
    const t3 = { id: 't3', name: 'read', args: {}, status: 'ok', startedAt: 5000, endedAt: 5500 }
    const spans = toolWaitSpans([t1, t2, t3])
    ok(spans.length === 3, '有完整起止的调用都进分段', String(spans.length))
    ok(
      waitSpansMs(spans) === 2500,
      '重叠区间只算一次（1000~3000 + 5000~5500 = 2500，并行不相加）',
      String(waitSpansMs(spans))
    )

    ok(toolWaitSpans([{ id: 't9', name: 'bash', args: {}, status: 'running', startedAt: 100 }]).length === 0, '还在跑的调用不进分段（无结束时间）')
    ok(toolWaitSpans([{ id: 't8', name: 'bash', args: {}, status: 'ok' }]).length === 0, '没有起止时间的调用不进分段')
    ok(waitSpansMs([]) === 0, '没有分段 → 0')

    const turns = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '干活', { toolCalls: [t1] })
    ])
    ok(turns[1].waitMs === 1000, '回合的 waitMs = 区间并集', String(turns[1].waitMs))
    ok(turns[1].waitSpans?.length === 1, '回合带 waitSpans 明细')

    const noWait = groupIntoTurns([usr('u1', 'x'), asst('a1', '直接答')])
    ok(noWait[1].waitMs === undefined && noWait[1].waitSpans === undefined, '没有工具调用就不写等待字段')
  }

  console.log('\n--- 15. 回合错误归属（后段成功不覆盖错误）---')
  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '出错了', { error: '模型不可用' }),
      asst('a2', '重试成功', { elapsedMs: 2000 })
    ])
    ok(t[1].error === '模型不可用', '后段成功的消息不覆盖同回合的错误', String(t[1].error))
    ok(t[1].errorMsgId === 'a1', '错误归属到第一条出错消息', String(t[1].errorMsgId))
    ok(t[1].elapsedMs === 2000, '耗时仍取最后一条消息', String(t[1].elapsedMs))
    ok(t[1].errorRecovered === true, '出错后又有正常输出时标记为已恢复', String(t[1].errorRecovered))
    const failedAgain = groupIntoTurns([usr('u1', 'x'), asst('a1', '出错了', { error: '一' }), asst('a2', '继续'), asst('a3', '又错', { error: '二' })])
    ok(failedAgain[1].errorRecovered !== true, '恢复后再次出错不算已恢复')
    const onlyError = groupIntoTurns([usr('u1', 'x'), asst('a1', '', { error: '一' })])
    ok(onlyError[1].errorRecovered === undefined, '只有报错时不写恢复字段')

    const two = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '第一次出错', { error: '第一' }),
      asst('a2', '第二次出错', { error: '第二' })
    ])
    ok(two[1].error === '第一' && two[1].errorMsgId === 'a1', '多条出错消息取第一条', `${two[1].error}/${two[1].errorMsgId}`)

    const clean = groupIntoTurns([usr('u1', 'x'), asst('a1', '答完', { elapsedMs: 900 })])
    ok(clean[1].error === undefined && clean[1].errorMsgId === undefined, '没有错误时不写错误字段')

    console.log('\n--- 16. 工作段（推理跟随正文位置）---')

    {
      const t = groupIntoTurns([
        usr('u1', '接着干'),
        asst('a1', '先看看代码', { thinking: '第一段推理', toolCalls: [tool('t1', 'read')] }),
        asst('a2', '正文A'),
        asst('a3', '', { thinking: '第二段推理', toolCalls: [tool('t2', 'edit')] }),
        asst('a4', '正文B')
      ])
      const a = t[1]
      ok(a.segments.length === 3, '三段工作段（推理+工具 / 正文A / 正文B）', `实际 ${a.segments.length}`)
      ok(a.segments[0].thinking.includes('第一段推理'), '第 1 段带第 1 段推理')
      ok(a.segments[0].commentary[0]?.text === '先看看代码', '带工具的文字是解说（不冒充正文）')
      ok(a.segments[1].response?.text === '正文A', '正文 A 单独成段（不被后续推理顶到后面）')
      ok(a.segments[2].thinking.includes('第二段推理'), '第 2 段推理归属后半段')
      ok(a.segments[2].tools.length === 1 && a.segments[2].response?.text === '正文B', '第 2 段的工具与正文 B 在同一段')
      ok(
        a.segments.every((s, i) => (i === 0 ? true : s.id !== a.segments[i - 1].id)),
        '每段 id 互不相同（DOM 可以用它做 stable key）'
      )
      ok(a.tools.length === 2 && a.thinking.includes('第二段推理'), '整轮聚合仍包含全部工具与推理')
      ok(
        a.response?.text.includes('正文A') && a.response?.text.includes('正文B'),
        '整轮回复仍是拼接口径（界面多段时不用它）'
      )
      ok(a.segments.filter((s) => s.response).length === 2, '两段正文 → 界面切到分段渲染路径')
    }

    {
      const t = groupIntoTurns([
        usr('u1', '改个标题'),
        asst('a1', '先看实现', { toolCalls: [tool('t1', 'read')] }),
        asst('a2', '改好了')
      ])
      const a = t[1]
      ok(a.segments.length === 2, '解说与回复各成一段', `实际 ${a.segments.length}`)
      ok(a.segments.filter((s) => s.response).length === 1, '只有一段正文 → 界面仍走旧渲染（零回归）')
      ok(a.segments.find((s) => s.response)?.response?.text === '改好了', '段内回复就是最后那条正文')
      ok(a.segments[0].commentary.length === a.commentary.length, '段内解说与整轮解说一致')
    }

    {
      const t = groupIntoTurns([usr('u1', 'x'), asst('a1', '正文A'), asst('a2', '正文B')])
      const a = t[1]
      ok(
        a.segments.map((s) => s.response?.text).join('|') === '正文A|正文B',
        '段内正文保持原顺序与原文字',
        a.segments.map((s) => s.response?.text).join('|')
      )
    }

    {
      const cwdA = 'C:\\worktrees\\history-a'
      const cwdB = 'C:\\worktrees\\history-b'
      const t = groupIntoTurns([
        usr('u1', '检查两个来源'),
        asst('a1', '来源 A 的 [README](README.md)', { sourceCwd: cwdA }),
        asst('a2', '来源 B 的 [README](README.md)', { sourceCwd: cwdB })
      ])
      const a = t[1]
      ok(a.segments[0]?.response?.sourceCwd === cwdA, '第一段回复保留来源 A 的 cwd')
      ok(a.segments[1]?.response?.sourceCwd === cwdB, '第二段回复保留来源 B 的 cwd')
      ok(
        a.responseParts?.length === 2 &&
          a.responseParts[0]?.sourceCwd === cwdA &&
          a.responseParts[1]?.sourceCwd === cwdB,
        '整轮聚合遇到不同 cwd 时保留分段来源'
      )

      const same = groupIntoTurns([
        usr('u2', '检查同一来源'),
        asst('a3', '第一段\n\n第二段', { sourceCwd: cwdA })
      ])[1]
      ok(same.response?.sourceCwd === cwdA, '同一 cwd 的聚合回复保留目录')
      ok(!same.responseParts, '同一 cwd 的回复维持原有单块渲染结构')
    }
  }
}
