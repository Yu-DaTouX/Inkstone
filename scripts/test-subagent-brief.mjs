/**
 * 内部 agent 分工（实施-25 P15）—— 任务输入 / 并行适合度 / 结果汇总。
 *
 * 四条最值得钉住的：
 *   · **输入不猜**：不知道的字段就是没有，不替调用方编；
 *   · **并行适合度清单只有一个出口**（避免三份「适合并行」定义）；
 *   · **摘要如实标来源**：它取的是「最后那段话」，不是子代理自报的结论；
 *   · **未决问题恒为空**：判断哪句是未决问题属于理解，宿主不替主 agent 下结论。
 */

export function runSubagentBriefTests(ok, mod) {
  const {
    parseSubagentBrief,
    briefPrompt,
    briefLine,
    subagentFitText,
    SUBAGENT_FIT_CASES,
    SUBAGENT_UNFIT_CASES,
    SUBAGENT_BRIEF_LIMITS,
    summarizeSubagentRun,
    resultHasContent,
    SUBAGENT_SUMMARY_MAX
  } = mod

  /* ---- 任务输入 ---- */
  {
    const minimal = parseSubagentBrief(undefined, '查一下这两个模块')
    ok(minimal.ok && minimal.brief.goal === '查一下这两个模块', '只给任务描述时，目标就用它')
    ok(minimal.brief.deliverables.length === 0 && minimal.brief.sources.length === 0 && minimal.brief.boundary === '', '没给的就是没有（不替调用方编）')

    const full = parseSubagentBrief(
      {
        goal: '摸清两个模块的错误处理是否一致',
        deliverables: ['一段结论', '不一致的具体位置', '一段结论'],
        sources: ['src/main/agent.ts', 'src/main/index.ts'],
        boundary: '只读，不要改代码'
      },
      'fallback'
    )
    ok(full.ok && full.brief.goal === '摸清两个模块的错误处理是否一致', '显式 goal 优先于任务描述')
    ok(full.brief.deliverables.length === 2, '交付物去重')
    ok(full.brief.sources.length === 2 && full.brief.boundary === '只读，不要改代码', '来源与边界原样保留')

    const noGoal = parseSubagentBrief({ goal: '   ' }, '   ')
    ok(!noGoal.ok, '既没有 goal 也没有任务描述：拒掉')
    const badList = parseSubagentBrief({ deliverables: '一段结论' }, 'x')
    ok(!badList.ok && /数组/.test(badList.error), 'deliverables 不是数组：给出可读错误', badList.error)
    const tooMany = parseSubagentBrief(
      { deliverables: Array.from({ length: SUBAGENT_BRIEF_LIMITS.maxDeliverables + 1 }, (_, i) => `第${i}项`) },
      'x'
    )
    ok(!tooMany.ok && /最多/.test(tooMany.error), '超过条数上限：如实报错，不静默截断')
    const tooLong = parseSubagentBrief({ goal: 'x'.repeat(SUBAGENT_BRIEF_LIMITS.maxGoal + 1) }, 'x')
    ok(!tooLong.ok, '目标超长：拒掉')

    const prompt = briefPrompt(full.brief, '查一下这两个模块的错误处理')
    ok(prompt.startsWith('摸清两个模块的错误处理是否一致'), 'prompt 从目标开始')
    ok(/要交回的东西：/.test(prompt) && /- 一段结论/.test(prompt), 'prompt 列出交付物')
    ok(/只依据这些来源（不要自行扩大）：/.test(prompt) && /src\/main\/agent\.ts/.test(prompt), 'prompt 写明只准依据的来源')
    ok(/边界：只读，不要改代码/.test(prompt), 'prompt 写出边界')
    ok(/先说结论/.test(prompt), 'prompt 要求先给结论')

    const sameGoal = briefPrompt(minimal.brief, '查一下这两个模块')
    ok(!/任务原话/.test(sameGoal), '目标与任务描述相同时不重复写一遍')
    ok(briefLine(full.brief).includes('要交回') && briefLine(full.brief).includes('边界'), '一行摘要含交付物与边界')
  }

  /* ---- 并行适合度 ---- */
  {
    const text = subagentFitText()
    ok(SUBAGENT_FIT_CASES.length >= 4, '适合并行的清单有内容')
    ok(/独立来源搜集/.test(text) && /长材料分段/.test(text), '适合：来源搜集与长材料分段')
    ok(SUBAGENT_UNFIT_CASES.some((item) => /导师与用户的连续交流/.test(item)), '不适合里明确写着「导师与用户的连续交流」（P15 验收那条）')
    ok(/短问答/.test(text) && /连续编辑同一段/.test(text), '不适合：短问答与连续编辑同一段')
    ok(text.indexOf('适合拆出去并行') < text.indexOf('不适合拆'), '先列适合、再列不适合（读起来先给能用的）')
  }

  /* ---- 结果汇总 ---- */
  {
    const transcript = [
      { role: 'user', text: '开始吧' },
      {
        role: 'assistant',
        text: '我先看看两边的读法。',
        toolCalls: [
          { name: 'read', args: { path: 'src/main/agent.ts' } },
          { name: 'grep', args: { pattern: 'catch (', path: 'src/main/index.ts' } },
          { name: 'bash', args: { command: 'ls -la' } },
          { name: 'write', args: { path: 'src/main/not-source.ts' } }
        ]
      },
      { role: 'assistant', text: '  两个模块的读法不一致：一个吞掉错误，一个往上抛。  ' }
    ]
    const result = summarizeSubagentRun(
      { transcript, diffPaths: ['src/main/index.ts', 'src/main/index.ts', 'src/main/agent.ts'], resultPath: '/tmp/sub.json', status: 'done' },
      1234
    )
    ok(result.summary === '两个模块的读法不一致：一个吞掉错误，一个往上抛。', '摘要取最后一条助手消息（并去掉首尾空白）')
    ok(result.summaryFrom === 'last-message' && !result.summaryTruncated, '摘要来源如实标注（最后一段话）')
    ok(result.sources.join(',') === 'src/main/agent.ts,src/main/index.ts', '来源只取读类工具的位置参数（bash / write / 搜索词不算）', result.sources.join(','))
    ok(result.artifacts[0] === 'src/main/index.ts' && result.artifacts.length === 3, '成果：改动文件去重 + 结果文件')
    ok(result.openQuestions.length === 0, '未决问题**不猜**（恒为空，留给主 agent 判断）')
    ok(result.at === 1234, '时间由调用方给（便于稳定推送）')
    ok(resultHasContent(result), '有摘要就算有内容')

    const errOnly = summarizeSubagentRun({ transcript: [{ role: 'user', text: 'hi' }], error: 'pi 子进程提前退出', status: 'error' }, 5)
    ok(errOnly.summaryFrom === 'error' && /提前退出/.test(errOnly.summary), '没有助手正文时用错误文本并标注来源')
    ok(!resultHasContent(errOnly) === false, '错误文本也算有内容（要让主 agent 看到）')

    const empty = summarizeSubagentRun({ transcript: [], status: 'starting' }, 5)
    ok(empty.summary === '' && empty.summaryFrom === 'none' && !resultHasContent(empty), '什么都没有时如实给空')

    const long = summarizeSubagentRun(
      { transcript: [{ role: 'assistant', text: 'a'.repeat(SUBAGENT_SUMMARY_MAX + 50) }], status: 'done' },
      5
    )
    ok(long.summaryTruncated && [...long.summary].length === SUBAGENT_SUMMARY_MAX + 1, '超长摘要截断并带省略号')
    ok(long.summary.endsWith('…'), '截断用省略号标明')

    /* 只读子任务的转录里没有 diff，成果为空但来源仍在 */
    const readOnly = summarizeSubagentRun(
      {
        transcript: [
          {
            role: 'assistant',
            text: '看完了。',
            toolCalls: [
              { name: 'fetch', args: { url: 'https://example.com/a' } },
              { name: 'grep', args: { pattern: 'TODO' } }
            ]
          }
        ],
        status: 'done'
      },
      7
    )
    ok(
      readOnly.artifacts.length === 0 && readOnly.sources.join(',') === 'https://example.com/a',
      '只读任务：成果为空、来源仍取位置（搜索词不算）',
      readOnly.sources.join(',')
    )
  }
}
