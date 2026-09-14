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
  const { groupIntoTurns, splitParagraphs, cacheHitRate, formatHitRate, turnUsage } =
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
      asst('a1', '我先看看实现', { toolCalls: [tool('t1', 'read')] }),
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

  /* ----------------------------------------------------- 14. turnUsage */

  console.log('\n--- 14. turnUsage ---')
  {
    const t = groupIntoTurns([
      usr('u1', 'x'),
      asst('a1', '中间', {
        toolCalls: [tool('t1', 'read')],
        usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: 0 }
      }),
      asst('a2', '答完', {
        usage: { input: 10, output: 50, cacheRead: 900, cacheWrite: 0, totalTokens: 960, cost: 0 }
      })
    ])
    const u = turnUsage(t[1])
    ok(u?.output === 50, 'usage 取最后一条（pi 报的是累计值，不能相加）')
    ok(u?.cacheRead === 900, 'cacheRead 同步取最后一条')
  }
}
