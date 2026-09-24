/**
 * 回合分组 / 段落拆分 / 缓存命中率 的纯逻辑测试。
 *
 * 为什么单独一个文件：test-unit.mjs 已经很长（会话解析那一套），
 * 而这里的被测对象是**纯函数**，输入的构造方式完全不同。
 *
 * 为什么需要它们（都是实测出来的问题）：
 *   · 一个真实会话里出现**最长 34 条连续 assistant 消息** ——
 *     界面上就是 34 个「砚」块，读起来全是碎片，而它们是同一轮回答
 *   · 段落拆分如果不管代码围栏，会把一个 ``` 块切成两半，
 *     前半段丢掉语言标记 → 语法高亮直接废掉
 *   · 命中率的分母必须是 input + cacheRead（pi 的 input 是**未命中**那部分），
 *     只看 input 会算出 >100%
 */

export async function runTurnTests(ok) {
  const { groupIntoTurns, splitParagraphs, cacheHitRate, formatHitRate, turnUsage, turnUsageOf, addUsage, hasUsageNumbers, toolWaitSpans, waitSpansMs, currentTurnMessages } =
    await import('../out/test/turns.mjs')

  /* ---------------------------------------------------------------- 构造 */

  const asst = (id, text, extra = {}) => ({ id, role: 'assistant', text, ...extra })
  const usr = (id, text) => ({ id, role: 'user', text })
  const tool = (id, name, status = 'ok') => ({ id, name, args: {}, status })

  /* ------------------------------------------------ 11. 回合分组（合并） */

  console.log('\n--- 11. 回合分组（消息合并）---')

  // 11.1 一个带工具的回合 → 只出一块
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

  // 11.2 实测痛点：34 条连续 assistant → 1 块（旧实现是 34 个「砚」）
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

  // 11.3 无工具的纯回答
  {
    const t = groupIntoTurns([usr('u1', '你好'), asst('a1', '你好，我是砚')])
    ok(t.length === 2 && t[1].tools.length === 0, '纯回答回合：无工具')
    ok(t[1].response?.text === '你好，我是砚', '纯回答成为 response')
    ok(t[1].commentary.length === 0, '没有冤枉的解说')
    ok(t[1].responseDetail === 'unknown', '没有元数据的旧消息显示为未知档位')
  }

  // 11.4 末尾停在工具上（没有最终文字）→ 提升最后一条解说
  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '我先读一下', { toolCalls: [tool('t1', 'read')] })
    ])
    const a = t[1]
    ok(a.response?.text === '我先读一下', '末尾无正文时把最后一条解说提升为回答')
    ok(a.commentary.length === 0, '提升后解说为空（不重复显示）')
  }

  // 11.5 bash 直执行是独立一块
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

  // 11.6 思考合并 + 耗时累加
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

  // 11.7 错误不丢
  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '失败了', { error: 'API 超时' }),
      asst('a2', '重试成功')
    ])
    ok(t[1].error === 'API 超时', '来回多次后错误仍然保留')
  }

  // 11.8 流式标记
  {
    const t = groupIntoTurns([usr('u1', 'x'), asst('a1', '在写'), asst('a2', '接着写')], 'a2')
    ok(t[1].streaming === true, '正在流式的那条消息让回合标记为 streaming')
    const t2 = groupIntoTurns([usr('u1', 'x'), asst('a1', '写完了')], undefined)
    ok(t2[1].streaming === false, '没有流式 id 时不是 streaming')
  }

  // 11.9 空输入
  {
    const t = groupIntoTurns([])
    ok(Array.isArray(t) && t.length === 0, '空消息数组 → 空回合数组（不抛）')
  }

  /*
   * 11.10 真实形态（实测的一条回合，17 条 assistant 消息）
   *
   * ```
   *   msg 0      文字22字 + tools[bash,recall]   ← 领起句：「我先看看环境」
   *   msg 1..15  无文字  + tools[bash,bash]×15   ← 干活
   *   msg 16     文字1615字 + tools[]            ← 结论
   * ```
   * 期望：领起句 → 解说；1615 字的结论 → 回复。
   * 旧实现也是这个结果（它是最后一条文字），所以这条是回归保护。
   */
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

  /*
   * 11.11 回复**跨多条消息**（用户报的顺序/归类问题的根因）
   *
   * 实测真实会话里，最后一次工具之后的文字会被拆成两条无工具消息：
   *   a1: 1600 字的正文
   *   a2: 「说一声就走。」
   * 旧实现只把最后一条当回复 → 1600 字正文全进了解说，
   * 界面上「回复」只剩一句「说一声就走。」（用户看到的就是这个）。
   */
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

  /*
   * 11.12 回复**夹在工作中间**（工具 → 说话 → 工具）
   *
   * 这种文字是「两个阶段之间的过渡」，不该当结论。
   */
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

  // 11.13 宿主生图进度挂在助手回合上，阶段更新按 id 替换而不是堆重复条目
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

  /* ---------------------------------------------------- 12. 段落拆分 */

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

    // 未闭合的围栏（流式中途）—— 不能因此把后面的都吞掉
    const open = '看这个：\n\n```ts\nconst a = 1'
    const op = splitParagraphs(open)
    ok(op.length === 2, '未闭合的围栏也能切出前面的段落', `实际 ${op.length}`)
  }

  /* ------------------------------------------------- 13. 缓存命中率 */

  console.log('\n--- 13. 缓存命中率 ---')
  {
    const u = (input, cacheRead) => ({
      input,
      output: 0,
      cacheRead,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0
    })

    ok(cacheHitRate(undefined) === null, '没有 usage → null')
    ok(cacheHitRate(u(0, 0)) === null, '全 0 → null（不能算出 NaN）')

    const r = cacheHitRate(u(467, 124032))
    ok(Math.abs(r - 99.625) < 0.01, '命中率 = cacheRead/(input+cacheRead)', `实际 ${r?.toFixed(3)}`)
    ok(cacheHitRate(u(0, 100)) === 100, '全是缓存命中 → 100%')
    ok(cacheHitRate(u(100, 0)) === 0, '完全没命中 → 0%')

    ok(formatHitRate(99.98) === '99.98%', '99.98% 保留两位小数（不再写 ≈100%）')
    ok(formatHitRate(92.44) === '92.44%', '92.44% 保留两位小数')
    ok(formatHitRate(0) === '0.00%', '0% 也有显示')
    ok(formatHitRate(null) === null, 'null 不显示')
    ok(formatHitRate(100) === '100%', '只有真满命中才显示 100%')
    ok(formatHitRate(99.999) === '99.99%', '99.999% 截断成 99.99%，不能四舍五入成 100%')
    ok(formatHitRate(99.995) === '99.99%', '99.995% 同样截断，不显示 ≈ 也不显示 100%')
  }

  /* ------------------------------------------- 14. 整轮用量聚合（H-6b） */

  console.log('\n--- 14. 整轮用量聚合（H-6b） ---')
  {
    const msg = (over = {}) =>
      ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, ...over })

    /* 多轮工具调用：每条助手消息的 usage 是该次请求的**独立用量** → 相加 */
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '中间', { toolCalls: [tool('t1', 'read')], usage: msg({ input: 10, output: 1, totalTokens: 11 }) }),
      asst('a2', '答完', { usage: msg({ input: 10, output: 50, cacheRead: 900, cacheWrite: 5, totalTokens: 960, cost: 0.02 }) })
    ])
    const u = turnUsage(t[1])
    ok(u?.output === 51, '整轮输出 = 1 + 50（每条消息是该次请求的独立用量，不是累计值）', `实际 ${u?.output}`)
    ok(u?.input === 20, '整轮输入 = 10 + 10', `实际 ${u?.input}`)
    ok(u?.cacheRead === 900 && u?.cacheWrite === 5, 'cacheRead / cacheWrite 同步相加')
    ok(Math.abs((u?.cost ?? 0) - 0.02) < 1e-9, 'cost 相加')
    ok(t[1].usagePartial === undefined, '两条都报了用量 → 不标 partial')

    /* 有请求没报用量 → 聚合只是下限，界面标 ≥ */
    const t2 = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '中间', { toolCalls: [tool('t1', 'read')] }),
      asst('a2', '答完', { usage: msg({ input: 10, output: 5 }) })
    ])
    ok(t2[1].usage?.output === 5, '没有用量的那条不参与相加', `实际 ${t2[1].usage?.output}`)
    ok(t2[1].usagePartial === true, '有请求没报用量 → 标 partial（界面显示 ≥）')

    /* 一条都没报 → 是「未知」而不是「部分」 */
    const t3 = groupIntoTurns([usr('u1', 'x'), asst('a1', '答完')])
    ok(t3[1].usage === undefined, '一条都没报 → 无用量')
    ok(t3[1].usagePartial === undefined, '一条都没报不算 partial（未知 ≠ 部分）')

    /* 纯函数自身 */
    ok(addUsage(undefined, undefined) === undefined, 'addUsage 两端都空 → undefined')
    ok(addUsage(undefined, msg({ output: 3 }))?.output === 3, 'addUsage 缺一端 → 原样返回另一端')
    ok(hasUsageNumbers(undefined) === false, '缺失不算有用量')
    ok(hasUsageNumbers(msg()) === false, '全 0 不算有用量（流式途中可能先报全 0）')
    ok(hasUsageNumbers(msg({ cacheWrite: 1 })) === true, '只有 cacheWrite 也算有用量')
    ok(turnUsageOf([usr('u1', 'x'), asst('a1', '答', { usage: msg({ output: 7 }) })]).usage?.output === 7, 'turnUsageOf 直接从消息算聚合')
  }

  /* --------------------------------------- 14.5 工具等待分段（H-6b） */

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

  /* ----------------------------------------- 15. currentTurnMessages */

  console.log('\n--- 15. 当前回合范围（用量条只认本轮）---')
  {
    const msg = { input: 10, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 960, cost: 0 }

    // 15.1 只包含最后一个 user 分界之后的消息
    {
      const scope = currentTurnMessages([
        usr('u1', '第一轮'),
        asst('a1', '答完', { usage: msg, speed: 42, elapsedMs: 1234 }),
        usr('u2', '第二轮'),
        asst('a2', '刚开始', { responseDetail: 'unknown' })
      ])
      ok(scope.length === 1 && scope[0].id === 'a2', '范围从最后一个 user 消息之后开始', scope.map((m) => m.id).join(','))
      ok(!scope.some((m) => m.usage), '新一轮没报 usage 时，取不到上一轮的用量')
      ok(!scope.some((m) => m.speed), '也取不到上一轮的速度（不会被标成实时）')
    }

    // 15.2 刚发用户消息、还没有回复 → 空范围（而不是退回旧轮）
    {
      const scope = currentTurnMessages([
        usr('u1', '第一轮'),
        asst('a1', '答完', { usage: msg, speed: 42 }),
        usr('u2', '第二轮刚发出')
      ])
      ok(scope.length === 0, '新一轮还没回消息时范围为空', `实际 ${scope.length}`)
    }

    // 15.3 bash 回合也是分界（与 groupIntoTurns 的回合定义一致）
    {
      const scope = currentTurnMessages([
        usr('u1', '第一轮'),
        asst('a1', '答完', { usage: msg }),
        { id: 'b1', role: 'bash', text: '$ ls' },
        asst('a2', '接着答')
      ])
      ok(scope.length === 1 && scope[0].id === 'a2', 'bash 消息同样开启新回合', scope.map((m) => m.id).join(','))
    }

    // 15.4 一条分界消息都没有（会话文件片段）→ 退回全部，不把信息藏掉
    {
      const all = [asst('a1', '片段一'), asst('a2', '片段二')]
      const scope = currentTurnMessages(all)
      ok(scope.length === 2, '没有分界消息时返回全部消息', `实际 ${scope.length}`)
    }

    // 15.5 同一轮内多条 assistant（工具往返）都算本轮
    {
      const scope = currentTurnMessages([
        usr('u1', '干活'),
        asst('a1', '先看看', { toolCalls: [tool('t1', 'read')], usage: msg, speed: 30 }),
        asst('a2', '干完了', { usage: { ...msg, output: 80 }, speed: 55 })
      ])
      ok(scope.length === 2, '工具往返的多条 assistant 都在本轮范围内', `实际 ${scope.length}`)
      ok(scope[scope.length - 1].speed === 55, '范围里能拿到本轮最新的速度')
    }

    /*
     * ------------------------------------------- 16. 工作段与推理位置
     *
     * 用户 2026-09-23 的要求：自主线跑时，**后一段的推理要显示在上一段正文之后**，
     * 而不是全部写回整轮靠前的旧推理块（R1）。
     */
    console.log('\n--- 16. 工作段（推理跟随正文位置）---')

    // 16.1 推理1 → 正文A → 推理2 → 工具 → 正文B
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
      /* 整轮聚合字段仍然对（页脚 / 用量不因分段而变） */
      ok(a.tools.length === 2 && a.thinking.includes('第二段推理'), '整轮聚合仍包含全部工具与推理')
      /*
       * 整轮 response 是**拼接口径**（正文A + 正文B）—— 这正是界面不能继续用它渲染的原因：
       * 多段时必须按 segments 逐段渲染，否则正文 A 会被拼到第 2 段推理后面。
       */
      ok(
        a.response?.text.includes('正文A') && a.response?.text.includes('正文B'),
        '整轮回复仍是拼接口径（界面多段时不用它）'
      )
      ok(a.segments.filter((s) => s.response).length === 2, '两段正文 → 界面切到分段渲染路径')
    }

    // 16.2 普通回合（解说 + 回复）：只有一段正文 → 界面保持旧渲染路径
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

    // 16.3 段落拆分不改文案：正文 A 不因分段被改字或括起
    {
      const t = groupIntoTurns([usr('u1', 'x'), asst('a1', '正文A'), asst('a2', '正文B')])
      const a = t[1]
      ok(
        a.segments.map((s) => s.response?.text).join('|') === '正文A|正文B',
        '段内正文保持原顺序与原文字',
        a.segments.map((s) => s.response?.text).join('|')
      )
    }

    // 16.4 会话链里的回复来源不同，分段字段必须保留各自 cwd。
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
