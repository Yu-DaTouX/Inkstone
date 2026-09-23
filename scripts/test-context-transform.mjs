/**
 * 上下文状态化压缩的单测（N21-4 / S2–S6）。
 *
 * 为什么这些断言值得钉住：这一层会**真的改写发给模型的消息**。
 * 坏了不会让应用崩，只会让模型少看一段历史、或者拿到错位的 `ctx://` 引用
 * （Recall 取回别人的内容）—— 在真实窗口里看起来只是“模型变笨了”。
 * 所以判据必须落在纯逻辑与「钩子 + 假 sessionManager」两层：
 *
 *   ① 原始 entry 身份对齐（数量 + 角色双校验，错位一律放弃）；
 *   ② Tool Sweep 只在 recentTail 之外、幂等、不破坏 tool 配对；
 *   ③ 墓碑文本与 `ctx://` 引用形状；
 *   ④ Task State 只注入 active 条目、放在历史之前、可重复调用不叠加；
 *   ⑤ Recall 预算（单次 / 累计 / 条数）与 TTL 存根；
 *   ⑥ 结构化摘要缺字段不接管（降级路径）；
 *   ⑦ 扩展写出的归档文件能通过 S1 的 schema 校验（跨语言交叉验证）。
 *
 * 全部跑在临时目录：`YAN_DATA_DIR` 指向 mkdtemp，不碰真实用户目录。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------- 夹具 */

const BIG = 'x'.repeat(4000) // ≈1000 token

/**
 * 三段回合的会话：A（用户 + 读文件 + 大结果）、B（用户 + 回答）、C（用户 + 回答）。
 * 刻意做成三个原子单元，好让 recentTail 的切割落在 A / B 与 C 之间。
 */
function branchFixture() {
  return [
    { type: 'model_change', id: 'mc0' },
    { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: '读一下 a.ts' }] } },
    {
      type: 'message',
      id: 'm2',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/a.ts' } },
          { type: 'text', text: '先看看' }
        ]
      }
    },
    {
      type: 'message',
      id: 'm3',
      message: { role: 'toolResult', toolCallId: 't1', toolName: 'read', content: [{ type: 'text', text: BIG }] }
    },
    { type: 'message', id: 'm4', message: { role: 'user', content: [{ type: 'text', text: '继续 b.ts' }] } },
    { type: 'message', id: 'm5', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
    { type: 'message', id: 'm6', message: { role: 'user', content: [{ type: 'text', text: '再确认一次' }] } },
    { type: 'message', id: 'm7', message: { role: 'assistant', content: [{ type: 'text', text: '确认完毕' }] } }
  ]
}

const messagesOf = (branch) => branch.filter((e) => e.type === 'message').map((e) => e.message)

function fakeCtx(branch, sessionId = 'sess0001') {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      getEntries: () => branch,
      getEntry: (id) => branch.find((e) => e.id === id) ?? null
    }
  }
}

function taskStateFixture(objective = '把 S2 做完') {
  const entry = (text, status = 'active') => ({
    text,
    status,
    source: { kind: 'user', entryId: 'm1', confidence: 'observed' },
    updatedAt: 1000
  })
  return {
    task: { objective, currentPhase: '实现' },
    currentState: [entry('已经对齐 entry 身份')],
    decisions: [entry('用纯函数写变换')],
    constraints: [entry('不改默认阈值')],
    files: [{ path: 'src/a.ts', state: 'reading', source: { kind: 'file', path: 'src/a.ts', confidence: 'observed' } }],
    completed: [entry('墓碑渲染完成')],
    failedAttempts: [entry('先试了整文件 parse')],
    unresolved: [entry('Recall 的 episode 分支未覆盖')],
    nextActions: [entry('补 live 场景')],
    commandsRun: [{ command: 'npm run test:unit', exitCode: 0, source: { kind: 'tool', entryId: 'm3', confidence: 'observed' } }],
    testsRun: [{ command: 'npm run test:unit', passed: 1027, source: { kind: 'tool', entryId: 'm3', confidence: 'observed' } }],
    symbolsTouched: [{ symbol: 'planToolSweep', source: { kind: 'model', confidence: 'hypothesis' } }],
    assumptions: [entry('pi 会按 entry 顺序给上下文', 'active')],
    hypothesis: [entry('免费模型当天可能返回空文本')],
    episodeRefs: [],
    archiveRefs: ['ctx://tool/m3']
  }
}

/* ---------------------------------------------------------------- 测试主体 */

export async function runContextTransformTests(ok, deps) {
  const { transform: T, extension: EXT, schema } = deps
  const dataDir = await mkdtemp(join(tmpdir(), 'yan-ctx-transform-'))
  const savedDataDir = process.env.YAN_DATA_DIR
  const savedLog = process.env.YAN_CONTEXT_EXT_LOG
  process.env.YAN_DATA_DIR = dataDir

  const stateFile = join(dataDir, 'context-state', 'sess0001.json')
  const archiveFile = join(dataDir, 'context-state', 'sess0001.archive.json')

  const setPolicy = (value) => {
    process.env.YAN_CONTEXT_POLICY = JSON.stringify(value)
  }

  /* ============ A. token 估算与消息取文本 ============ */
  console.log('\n— A. 估算与取文本 —')
  {
    ok(T.estimateTokens('') === 0 && T.estimateTokens(null) === 0, '空文本估算为 0')
    ok(T.estimateTokens('abcd') === 1, '4 字符 ≈ 1 token', String(T.estimateTokens('abcd')))
    ok(T.estimateTokens('abcde') === 2, '向上取整（不低估）', String(T.estimateTokens('abcde')))
    /* N21-11：宽字符（CJK/假名/韩文/全角）按 1 个 = 1 token，其余仍按 ÷4 */
    ok(T.estimateTokens('中文') === 2, '汉字按 1 个 = 1 token', String(T.estimateTokens('中文')))
    ok(T.estimateTokens('中abc') === 2, '混排：1 汉字 + 3 ASCII → ceil(1 + 0.75)', String(T.estimateTokens('中abc')))
    ok(T.estimateTokens('？！：；（）') === 6, '全角标点同样按 1 个 = 1 token', String(T.estimateTokens('？！：；（）')))
    ok(T.estimateTokens('あいう') === 3 && T.estimateTokens('한글') === 2, '假名 / 韩文音节也在宽字符集里')
    ok(T.estimateTokens('🎉🎉🎉🎉') === 2, 'emoji 不是宽字符（维持 UTF-16 ÷ 4 的既有口径，4 个 = 8 单元）')
    ok(T.estimateTokens('a'.repeat(4)) === 1, '纯 ASCII 行为不变（回归保护）', String(T.estimateTokens('a'.repeat(4))))
    ok(
      T.isWideTokenChar(0x4e2d) && T.isWideTokenChar(0xff01) && T.isWideTokenChar(0x3042) && T.isWideTokenChar(0xac00) &&
        !T.isWideTokenChar(0x61) && !T.isWideTokenChar(0x1f389) && !T.isWideTokenChar(0x20),
      'isWideTokenChar 的边界（汉字/全角/假名/韩文 true；字母/emoji/空格 false）'
    )
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'p' } }] }
    ok(T.messageText(assistant) === 'hi', 'thinking / toolCall 不算正文', JSON.stringify(T.messageText(assistant)))
    ok(T.toolCallsOf(assistant).length === 1 && T.toolCallsOf(assistant)[0].id === 't1', 'assistant 的 toolCall 能取出来')
    ok(T.toolTarget({ path: 'src/a.ts' }) === 'src/a.ts', '目标优先取 path')
    ok(T.toolTarget({ command: 'npm run x\necho hi' }) === 'npm run x', '命令只取第一行')
    ok(T.toolTarget({ q: 1 }) === '', '抄不到目标就留空（不编）')
    /* 路径提取比 toolTarget 窄：只收路径字段（硬约束①的输入） */
    ok(T.toolPaths({ path: 'src/a.ts', file_path: 'b.ts' }).join(',') === 'src/a.ts,b.ts', '路径类参数都收')
    ok(T.toolPaths({ pattern: 'foo', command: 'ls -la' }).length === 0, 'pattern / 命令行不算路径（否则会把无关条目错保护）')
    const turn = [
      { role: 'user', content: [{ type: 'text', text: '改一下' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'x1', name: 'edit', arguments: { path: 'src/a.ts' } }] },
      { role: 'toolResult', toolCallId: 'x1', content: [{ type: 'text', text: 'ok' }] }
    ]
    ok(T.activePathsOf(turn).join(',') === 'src/a.ts', '本回合正在动的文件进入 activePaths')
    ok(
      T.activePathsOf([...turn, { role: 'user', content: [{ type: 'text', text: '换个话题' }] }]).length === 0,
      '旧回合的编辑不再“正在使用”（否则硬留集会单调增长）'
    )
  }

  /* ============ B. entry 身份对齐 ============ */
  console.log('\n— B. 原始 entry 身份对齐（provenance 只认 raw id） —')
  {
    const branch = branchFixture()
    const messages = messagesOf(branch)
    const ids = T.alignEntryIds(branch, messages)
    ok(!!ids && ids.join(',') === 'm1,m2,m3,m4,m5,m6,m7', 'model_change 被跳过，其余按序对齐', JSON.stringify(ids))
    ok(T.alignEntryIds(branch, messages.slice(1)) === null, '数量不等 → 放弃（不猜）')
    const wrongRole = messages.slice()
    wrongRole[2] = { role: 'assistant', content: [] }
    ok(T.alignEntryIds(branch, wrongRole) === null, '数量相等但角色错位 → 放弃')

    /* 压缩过：只从 firstKeptEntryId 起保留 */
    const compacted = [
      { type: 'message', id: 'old1', message: { role: 'user', content: [{ type: 'text', text: '老历史' }] } },
      { type: 'message', id: 'old2', message: { role: 'assistant', content: [{ type: 'text', text: '老回答' }] } },
      { type: 'compaction', id: 'c1', firstKeptEntryId: 'm4', summary: '压缩摘要' },
      { type: 'message', id: 'm4b', message: { role: 'user', content: [{ type: 'text', text: '继续' }] } }
    ]
    const compactedMessages = [{ role: 'compactionSummary', summary: '压缩摘要' }, compacted[3].message]
    const compactedIds = T.alignEntryIds(compacted, compactedMessages)
    ok(
      !!compactedIds && compactedIds.join(',') === 'c1,m4b',
      '有压缩时从 firstKeptEntryId 起对齐（不然 id 全部错位）',
      JSON.stringify(compactedIds)
    )
    ok(T.watermarkOfEntries(branch).entryCount === branch.length, '水位 = 全部非文件头条目数')
    ok(T.watermarkOfEntries(branch).lastEntryId === 'm7', '水位最后一条 = 文件顺序最后一条')
  }

  /* ============ C. Tool Sweep 规划与幂等 ============ */
  console.log('\n— C. Tool Sweep（§12.5） —')
  {
    const branch = branchFixture()
    const messages = messagesOf(branch)
    const entryIds = T.alignEntryIds(branch, messages)
    const watermark = T.watermarkOfEntries(branch)
    const planned = T.planToolSweep({
      messages,
      entryIds,
      watermark,
      recentTail: { target: 1, max: 1 },
      sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 }
    })
    ok(planned.ok, '大工具结果在 recentTail 之外 → 可以 sweep', planned.reason)
    ok(planned.archiveEntries.length === 1 && planned.archiveEntries[0].ref === 'ctx://tool/m3', '归档元数据引用原始 entryId', JSON.stringify(planned.archiveEntries?.[0]?.ref))
    ok(planned.metrics.reclaimedTokens > 900, '收益估算合理（≈1000 - 墓碑）', JSON.stringify(planned.metrics))

    const applied = T.applyToolSweep(messages, planned.plan)
    ok(applied.changed === 1, '替换了一条')
    ok(T.isTombstoneText(T.messageText(applied.messages[2])), 'toolResult 变成墓碑')
    ok(applied.messages[2].toolCallId === 't1', 'toolCallId 保留（tool 配对不破）')
    ok(applied.messages.length === messages.length, '消息条数不变（墓碑不是删除）')
    ok(T.sweepViolations(applied.messages, entryIds).length === 0, 'sweep 后不违反原子/配对/保护约束')
    ok(planned.plan.edits[0].tombstone.includes('ctx://tool/m3'), '墓碑里有 ctx:// 引用')
    ok(planned.plan.edits[0].tombstone.includes('read'), '墓碑抄了工具名')
    ok(planned.plan.edits[0].tombstone.includes('src/a.ts'), '墓碑抄了确定性目标（来自 toolCall 参数）')

    /* 幂等：再规划一次没有候选，再 apply 不改动 */
    const again = T.planToolSweep({ messages: applied.messages, entryIds, watermark, recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    ok(!again.ok && again.reason === 'no-candidates', '已包过的墓碑不再入选（幂等）', again.reason)
    const twice = T.applyToolSweep(applied.messages, planned.plan)
    ok(twice.changed === 0, '重复提交同一份 plan 不改动消息')

    /* recentTail 内的工具结果不许动 */
    const recent = T.planToolSweep({ messages, entryIds, watermark, recentTail: { target: 1_000_000, max: 1_000_000 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    ok(!recent.ok && recent.reason === 'no-candidates', 'recentTail 覆盖全部时没有候选')

    /* 收益门槛 */
    const tiny = T.planToolSweep({ messages, entryIds, watermark, recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 1_000_000, minReclaimRatio: 0.99 } })
    ok(!tiny.ok && tiny.reason === 'below-reclaim-threshold', '可回收量不足 → 跳过（不改 armed）', tiny.reason)

    /* 未解决的错误不许 sweep */
    const errorBranch = branchFixture()
    errorBranch[3].message.isError = true
    const errorMessages = messagesOf(errorBranch)
    const errorPlan = T.planToolSweep({
      messages: errorMessages,
      entryIds: T.alignEntryIds(errorBranch, errorMessages),
      watermark,
      recentTail: { target: 1, max: 1 },
      sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 }
    })
    ok(!errorPlan.ok && errorPlan.reason === 'no-candidates', 'isError 的工具结果受 unresolved-error 保护，不参与 sweep', errorPlan.reason)
  }

  /* ============ D. Task State 渲染与注入 ============ */
  console.log('\n— D. Task State（§12.8 / §13.1） —')
  {
    const task = taskStateFixture()
    task.decisions.push({
      text: '旧决策',
      status: 'superseded',
      supersededBy: '用纯函数写变换',
      source: { kind: 'user', entryId: 'm1', confidence: 'observed' },
      updatedAt: 1000
    })
    const text = T.renderTaskState(task)
    ok(
      text.startsWith('<TASK_STATE derived="true" authoritative="false" freshness="fresh">') &&
        text.trimEnd().endsWith('</TASK_STATE>'),
      '块首尾标记完整（头行带 authority 契约）'
    )
    ok(
      text.includes('not ground truth') && text.includes('those win'),
      '契约里明确「不是事实源」与优先级（第四轮外部评审 P0-2）'
    )
    ok(
      T.renderTaskState(task, { freshness: 'stale', sourceHead: 42 }).startsWith(
        '<TASK_STATE derived="true" authoritative="false" freshness="stale" sourceHead="42">'
      ),
      'freshness / sourceHead 透传到头行'
    )
    ok(text.includes('Objective: 把 S2 做完'), '目标在块里')
    ok(text.includes('Constraints:') && text.includes('不改默认阈值'), '约束以独立小标题出现（不降级成背景）')
    ok(!text.includes('旧决策'), 'superseded 条目不再注入')
    ok(text.includes('ctx://tool/m3'), '归档引用出现在块里（告诉模型去哪里查）')
    ok(T.renderTaskState({ task: { objective: 'x', currentPhase: 'y' } }) === '', '只有标题、没有内容的空状态不注入')

    /*
     * provenance 的**可见面**（第五轮外部意见 Q1 的 P0-③）：没有证据引用的语义条目
     * 必须在注入时显式标出来。否则模型读到的就是「上一版已经认定的结论」，
     * 错误语义会一代代传下去 —— 这一步是断递归的最后一环，也是**模型唯一能看到**的一环。
     */
    const withInferred = {
      ...task,
      nextActions: [
        { text: '推断的下一步', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 },
        { text: '有证据的下一步', status: 'active', source: { kind: 'tool', entryId: 'm4', confidence: 'derived' }, updatedAt: 1 }
      ]
    }
    const inferredText = T.renderTaskState(withInferred)
    ok(/推断的下一步.*\[inferred/.test(inferredText), 'hypothesis 条目带 inferred 标记')
    ok(!/有证据的下一步.*\[inferred/.test(inferredText), 'derived 条目不带 inferred 标记')
    ok(inferredText.includes('not ground truth'), '标记不替代 authority 契约（两者都要有）')

    const bothMarks = {
      ...task,
      assumptions: [
        { text: '又旧又没证据', status: 'active', stale: true, source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }
      ]
    }
    const bothText = T.renderTaskState(bothMarks)
    ok(/又旧又没证据.*\[stale.*inferred/.test(bothText), 'stale 与 inferred 同时出现时两个都标（不互相掩盖）')

    const { messages, injected } = T.injectTaskState(messagesOf(branchFixture()), text)
    ok(injected && messages[0].customType === 'yan-task-state', 'Task State 插在最前（历史之前）')
    ok(messages.length === 8, '只加一条（不复制历史）')
    const second = T.injectTaskState(messages, text)
    ok(second.messages.length === 8 && T.hasTaskState(second.messages), '重复注入不叠加')
    const removed = T.injectTaskState(messages, '')
    ok(!T.hasTaskState(removed.messages) && removed.messages.length === 7, '空文本时移除旧的注入')
  }

  /* ============ E. Recall 预算与 TTL ============ */
  console.log('\n— E. Recall（§12.9） —')
  {
    const policy = { maxTokensPerCall: 100, maxActiveRecallTokens: 150, maxEntriesPerCall: 2, ttl: 'turn' }
    ok(T.recallBudget(policy, { tokens: 50 }).ok, '预算内允许')
    const tooLarge = T.recallBudget(policy, { tokens: 101 })
    ok(!tooLarge.ok && tooLarge.reason === 'too-large', '单次超限被拒（可解释）', tooLarge.reason)
    const tooMany = T.recallBudget(policy, { tokens: 10, count: 3 })
    ok(!tooMany.ok && tooMany.reason === 'too-many-entries', '条数超限被拒')
    const active = T.recallBudget(policy, { tokens: 60 }, { tokens: 100 })
    ok(!active.ok && active.reason === 'active-budget', '累计超限被拒', active.reason)
    ok(T.recallBudget(policy, { tokens: 50 }, { tokens: 100 }).ok, '恰好不超上限时允许')

    const wrapped = T.wrapRecall('原文正文', 'ctx://tool/m3', 1)
    const parsed = T.parseRecall(wrapped)
    ok(parsed?.turn === 1 && parsed?.ref === 'ctx://tool/m3', '包装里的回合号与引用可解析', JSON.stringify(parsed))
    ok(T.parseRecall('普通工具输出') === null, '非召回内容不被误判')

    const withRecall = [
      { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
      { role: 'toolResult', toolCallId: 'x', content: [{ type: 'text', text: wrapped }] },
      { role: 'user', content: [{ type: 'text', text: '第二轮' }] }
    ]
    ok(T.userTurnCount(withRecall) === 2, '用户回合数只数 role=user', String(T.userTurnCount(withRecall)))
    const stripped = T.stripStaleRecalls(withRecall, 2)
    ok(stripped.changed === 1, '上一轮的召回正文被清理')
    const stub = T.messageText(stripped.messages[1])
    ok(stub.startsWith(T.RECALL_STUB_PREFIX) && stub.includes('ctx://tool/m3'), '清理后只剩存根 + 引用', stub)
    ok(T.activeRecallTokens(stripped.messages) === 0, '清理后不再计入召回预算')
    const sameTurn = T.stripStaleRecalls(withRecall, 1)
    ok(sameTurn.changed === 0, '同一轮的召回正文保留（本回合还要用）')
    ok(T.activeRecallTokens(withRecall) > 0, '召回内容计入 active tokens')
  }

  /* ============ F. 结构化摘要与 Episode 汇总 ============ */
  console.log('\n— F. 结构化压缩与 Episode 汇总 —')
  {
    const full = { task: taskStateFixture(), episodes: [{ id: 'ep1', objective: '做完 S2', outcome: '完成', importantRefs: ['ctx://tool/m3'] }] }
    /*
     * 消费门（EpisodeState 切片）：**默认不渲染**。生成与校验照常，只是不让模型
     * 自己写的段结论进模型可见路径 —— 与 `state.inject` 当初的 shadow 模式同一条做法。
     */
    const shadow = T.buildStructuredSummary(full)
    ok(shadow.ok && !shadow.summary.includes('ep1'), '默认不消费 Episode（shadow：只生成不注入）')
    ok(shadow.episodesSkipped === 1, '被门挡下的条数可观测（不是静默丢掉）', String(shadow.episodesSkipped))
    const built = T.buildStructuredSummary(full, { includeEpisodes: true })
    ok(built.ok, '六类字段齐备时可以接管', built.reason)
    ok(
      built.summary.includes('<TASK_STATE derived="true"') && built.summary.includes('<HISTORICAL_CONTEXT>'),
      '两段式输出'
    )
    ok(built.summary.includes('ep1') && built.summary.includes('ctx://tool/m3'), 'Episode 只引用不重新摘要')
    ok(!built.summary.includes('旧决策'), 'superseded 不进摘要')

    const empty = { task: taskStateFixture(), episodes: [] }
    const emptyTask = { ...empty, task: { ...empty.task, decisions: [], constraints: [], failedAttempts: [], unresolved: [], nextActions: [] } }
    /*
     * 生成器落地后**默认不再要求六类字段齐备**（§16.6.2）：状态是模型产出的
     * 真状态，“真的没有 failedAttempts”与“忘了问”是两件事。
     * 需要保守判定的调用方仍可显式声明 requiredFields。
     */
    ok(T.buildStructuredSummary(emptyTask).ok, '默认不再要求六类字段齐备（生成器已落地）')
    const missing = T.buildStructuredSummary(emptyTask, { requiredFields: ['decisions', 'nextActions'] })
    ok(!missing.ok && missing.reason === 'missing-fields', '显式要求字段时仍会拒绝（保守模式可用）', missing.reason)
    ok(Array.isArray(missing.missing) && missing.missing.includes('decisions'), '拒绝原因列出缺哪几类', JSON.stringify(missing.missing))
    const relaxed = T.buildStructuredSummary(emptyTask, { allowMissing: true })
    ok(relaxed.ok, '显式放宽时允许（测试 / 未来区分“确实没有”）')

    const merged = T.mergeEpisodeRefs({ episodeRefs: ['ep0'], archiveRefs: [] }, full.episodes)
    ok(merged.episodeRefs.join(',') === 'ep0,ep1' && merged.archiveRefs.includes('ctx://tool/m3'), 'Episode 汇总只加引用', JSON.stringify(merged))
    const risk = T.episodeRecursionRisk([
      { id: 'ep1', sourceRange: { from: 'm1', to: 'm3' } },
      { id: 'ep2', sourceRange: { from: 'ep1', to: 'm3' } },
      { id: 'ep3', sourceRange: { from: 'ctx://tool/m3', to: 'm3' } }
    ])
    ok(risk.length === 2 && risk[0].episode === 'ep2' && risk[1].episode === 'ep3', '递归摘要风险可预检（§12.7）', JSON.stringify(risk))

    /*
     * Episode 旁路防线（第四轮外部评审 P0-4）：旧 EpisodeState 的语义路径还没接上
     * provenance / freshness 这套契约，所以**有递归风险的条目不进摘要** ——
     * 源头先拦一道，真正的 schema 执法仍在 `shared/context-state.ts`。
     */
    const riskySummary = T.buildStructuredSummary(
      {
        task: taskStateFixture(),
        episodes: [
          { id: 'ep1', objective: '合法的目标', outcome: '', sourceRange: { from: 'm1', to: 'm2' }, importantRefs: [] },
          { id: 'ep2', objective: '旧语义的目标', outcome: '', sourceRange: { from: 'ep1', to: 'ep2' }, importantRefs: [] }
        ]
      },
      /* 消费门开着才能验「有风险的被拦、合法的留下」；关着的时候两者都不在，测不到这一层 */
      { includeEpisodes: true }
    )
    ok(
      riskySummary.ok &&
        riskySummary.summary.includes('合法的目标') &&
        !riskySummary.summary.includes('旧语义的目标') &&
        riskySummary.episodesDropped === 1,
      '有递归风险的 episode 不进摘要（P0-4）',
      `dropped=${riskySummary.episodesDropped}`
    )
    /*
     * 压缩接手的摘要里，头行也要写**真实**档位与水位 —— 不能因为它是个摘要
     * 就默写 `freshness="fresh"`（那时状态可能已经是 stale-soft / stale-hard）。
     */
    const staleBlock = T.buildStructuredSummary(
      { task: taskStateFixture(), episodes: [], sourceWatermark: { entryCount: 7, lastEntryId: 'm7' } },
      { freshness: 'stale' }
    )
    ok(
      staleBlock.ok &&
        staleBlock.summary.includes(
          '<TASK_STATE derived="true" authoritative="false" freshness="stale" sourceHead="7">'
        ),
      '压缩摘要的契约头用真实档位与水位（不默写 fresh）'
    )
  }

  /* ============ G. 与 S1 schema 的交叉校验 ============ */
  console.log('\n— G. 跨语言交叉校验（JS 写出的东西要过 TS schema） —')
  {
    const known = ['mc0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    const watermark = T.watermarkOfEntries(branchFixture())
    const entry = {
      ref: 'ctx://tool/m3',
      kind: 'tool',
      label: 'read m3',
      createdAt: Date.now(),
      tokens: 1000,
      recallable: 'agent',
      sourceRange: { from: 'm3', to: 'm3' },
      watermark,
      contentStored: false
    }
    const parsed = schema.validateArchiveEntry(entry, { knownEntryIds: known })
    ok(parsed.ok, '纯模块产出的归档条目通过 S1 schema 校验', parsed.ok ? '' : JSON.stringify(parsed.issues.slice(0, 3)))

    const wrongKind = schema.validateArchiveEntry({ ...entry, ref: 'ctx://episode/m3' }, { knownEntryIds: known })
    ok(!wrongKind.ok, 'ref 类别与 kind 不一致时 schema 拒绝（交叉验证不是永远通过）')

    /* 扩展的归档写入（真实文件）也要过 schema */
    await EXT.__internals.mergeArchive('sess0001', [entry], Date.now(), watermark)
    const raw = JSON.parse(await readFile(archiveFile, 'utf8'))
    const inspected = schema.inspectArchiveFile(raw, { knownEntryIds: known })
    ok(inspected.status === 'ok', '扩展写出的整份归档文件通过 schema 校验', inspected.status === 'ok' ? '' : JSON.stringify(inspected.issues?.slice(0, 3)))
    await EXT.__internals.mergeArchive('sess0001', [entry], Date.now(), watermark)
    const again = JSON.parse(await readFile(archiveFile, 'utf8'))
    ok(again.entries.length === 1, '同一 ref 重复合并只留一条（幂等）')
    ok(EXT.__internals.findArchiveEntry('sess0001', 'ctx://tool/m3')?.tokens === 1000, '归档可按 ref 查回')
  }

  /* ============ H. context 钩子端到端（假 sessionManager） ============ */
  console.log('\n— H. context 钩子（真实文件 + 假 sessionManager） —')
  {
    /* 清掉上个测试留下的归档，确保断言的是本次写入 */
    await rm(archiveFile, { force: true })

    const branch = branchFixture()
    const messages = messagesOf(branch)
    const ctx = fakeCtx(branch)
    /*
     * C-2b 的动作账本：扩展写、宿主读。
     * 这里断言的是**真实写入点**（onContext 真的跑了一遍），
     * 而不是把账本内容当成给定条件。
     */
    const actionFile = join(dataDir, 'context-actions', 'sess0001.jsonl')
    const readActions = async () => {
      try {
        const text = await readFile(actionFile, 'utf8')
        return text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    }

    setPolicy({ kinds: ['tool-sweep'], recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    const out = await EXT.__internals.onContext({ messages }, ctx)
    ok(!!out && Array.isArray(out.messages), '钩子返回替换后的消息')
    ok(out.messages.length === messages.length, 'sweep 不改条数')
    ok(T.isTombstoneText(T.messageText(out.messages[2])), '真实钩子路径上也把大结果换成墓碑')
    const archived = JSON.parse(await readFile(archiveFile, 'utf8'))
    ok(archived.entries.length === 1 && archived.entries[0].ref === 'ctx://tool/m3', '钩子把归档元数据落盘', JSON.stringify(archived.entries.length))
    ok(archived.sessionId === 'sess0001', '归档绑定会话 id')
    /*
     * 回合号必须在**召回发生之前**就写好：工具用账本里的回合号给召回内容
     * 打 TTL 标记；若第一个召回读到 0，它会在同一回合的下一个请求里就被
     * 误当成过期清掉（真实回合里实测到过，模型被迫二次召回）。
     */
    ok(
      EXT.__internals.loadLedger('sess0001').turn === T.userTurnCount(messages),
      '钩子把当轮回合号写进召回账本（首个召回不会拿到 0）',
      `ledger=${JSON.stringify(EXT.__internals.loadLedger('sess0001'))}`
    )

    /*
     * C-2b：清扫必须自己留痕 —— pi 不会为它发 `compaction_*` 事件，
     * 账本是界面唯一能知道“清扫真的发生过”的来源。
     */
    const sweptActions = await readActions()
    const sweepAction = sweptActions.find((item) => item.kind === 'tool-sweep')
    ok(!!sweepAction, 'C-2b：清扫在动作账本里留痕（真实写入点）')
    ok(
      sweepAction?.status === 'applied' && sweepAction?.reclaimed >= 1,
      'C-2b：账本记下清扫状态与整理条数',
      JSON.stringify(sweepAction)
    )
    ok(
      typeof sweepAction?.savedTokens === 'number' && sweepAction.savedTokens >= 0,
      'C-2b：账本同时记下估算省下的 token',
      JSON.stringify(sweepAction)
    )

    /* 收益门槛没过（没真做）时同样留痕：失败与“没干”必须能区分开 */
    await rm(actionFile, { force: true })
    setPolicy({
      kinds: ['tool-sweep'],
      recentTail: { target: 1, max: 1 },
      /* 两个收益门槛都要“达不到”才叫没收益 —— 只抬一个不会拦住（见 planToolSweep） */
      sweep: { minTokens: 10, minReclaimTokens: 10_000_000, minReclaimRatio: 1 }
    })
    await EXT.__internals.onContext({ messages }, ctx)
    const skippedAction = (await readActions()).find((item) => item.kind === 'tool-sweep')
    ok(
      skippedAction?.status === 'skipped' && !!skippedAction?.reason,
      'C-2b：清扫因收益门槛没做时也留痕（带原因）',
      JSON.stringify(skippedAction)
    )

    /* kinds 不含 tool-sweep 时什么都不做（用户可把清理关掉） */
    setPolicy({ kinds: ['compaction'] })
    const untouched = await EXT.__internals.onContext({ messages }, ctx)
    ok(untouched === undefined, '把清理关掉（kinds 只有 compaction）后不改任何消息')

    /* 身份对不上时安全放弃 */
    setPolicy({ kinds: ['tool-sweep'], recentTail: { target: 1, max: 1 } })
    const skewed = await EXT.__internals.onContext({ messages: messages.slice(1) }, ctx)
    ok(skewed === undefined, 'entry 身份对不上 → 放弃整轮变换（宁可压不动）')

    /* Task State 注入：水位一致才注入 */
    setPolicy({ kinds: ['episode-fold'] })
    const seeded = {
      schemaVersion: 1,
      sessionId: 'sess0001',
      sourceWatermark: T.watermarkOfEntries(branch),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      task: taskStateFixture(),
      episodes: []
    }
    await writeFile(stateFile, JSON.stringify(seeded), 'utf8')
    const injected = await EXT.__internals.onContext({ messages }, ctx)
    ok(!!injected && injected.messages[0]?.customType === 'yan-task-state', '水位一致 → 注入 <TASK_STATE>')
    ok(
      T.messageText(injected.messages[0]).includes('<TASK_STATE derived="true" authoritative="false"'),
      '注入内容确实是状态块（带 authority 契约头）'
    )

    /*
     * 有效但较早（有界陈旧）→ 仍然注入，但推测类字段必须带 stale 标记。
     * 完全一致才注入会形成 availability cliff（异步生成几乎永不生效）。
     */
    const older = { ...seeded, sourceWatermark: { entryCount: 7, lastEntryId: 'm7' } }
    await writeFile(stateFile, JSON.stringify(older), 'utf8')
    const olderInjected = await EXT.__internals.onContext({ messages }, ctx)
    ok(!!olderInjected, '水位较旧但可定位（gap 1）→ 仍注入')
    ok(T.messageText(olderInjected.messages[0]).includes('[stale'), '陈旧快照的推测字段显式标 stale')

    /* 水位对不上（历史被裁剪/回退）→ 不注入 */
    const diverged = { ...seeded, sourceWatermark: { entryCount: 3, lastEntryId: 'zzz' } }
    await writeFile(stateFile, JSON.stringify(diverged), 'utf8')
    ok((await EXT.__internals.onContext({ messages }, ctx)) === undefined, '水位 diverged → 不注入过期状态')

    /* 太旧（gap > 6）→ 同样不注入 */
    const tooOld = { ...seeded, sourceWatermark: { entryCount: 1, lastEntryId: 'mc0' } }
    await writeFile(stateFile, JSON.stringify(tooOld), 'utf8')
    ok((await EXT.__internals.onContext({ messages }, ctx)) === undefined, '落后超过 6 条 → 不注入（宁少不错）')

    /* 会话 id 不一致 → 不注入（不拿别的会话的状态） */
    const other = { ...seeded, sessionId: 'other999' }
    await writeFile(stateFile, JSON.stringify(other), 'utf8')
    ok((await EXT.__internals.onContext({ messages }, ctx)) === undefined, '状态文件会话对不上 → 不注入')
  }

  /* ============ I. session_before_compact 接管闸门 ============ */
  console.log('\n— I. 结构化压缩接管闸门（§12.8 降级路径） —')
  {
    const branch = branchFixture()
    const ctx = fakeCtx(branch)
    const preparation = { firstKeptEntryId: 'm6', tokensBefore: 123_456 }

    setPolicy({ kinds: ['compaction', 'episode-fold'] })
    await rm(stateFile, { force: true })
    ok(EXT.__internals.onBeforeCompact({ preparation }, ctx) === undefined, '没有状态文件 → 交回 pi 摘要（不 cancel）')

    const seeded = {
      schemaVersion: 1,
      sessionId: 'sess0001',
      sourceWatermark: T.watermarkOfEntries(branch),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      task: taskStateFixture(),
      episodes: []
    }
    await writeFile(stateFile, JSON.stringify(seeded), 'utf8')
    const taken = EXT.__internals.onBeforeCompact({ preparation }, ctx)
    ok(!!taken?.compaction, '状态齐备 → 接管压缩')
    ok(taken.compaction.firstKeptEntryId === 'm6', '保留 pi 给的切割点（只换摘要文本）')
    ok(taken.compaction.tokensBefore === 123_456, '保留 pi 给的 tokensBefore')
    ok(
      String(taken.compaction.summary).includes('<TASK_STATE derived="true"'),
      '摘要里是结构化状态，不是对话摘要'
    )

    /*
     * 分路开关（第四轮外部评审 P0-5）：`inject:false` = 不让派生状态进上下文，
     * 压缩接手也属于其中 —— 而且这是**默认关时就存在的漏洞**：以前只看
     * 「状态文件在不在」，关掉 kinds 后遗留的状态文件仍会被压缩接手。
     */
    setPolicy({ kinds: ['compaction', 'episode-fold'], state: { inject: false } })
    ok(
      EXT.__internals.onBeforeCompact({ preparation }, ctx) === undefined,
      'inject:false → 不接管压缩（状态文件仍在）'
    )
    setPolicy({ kinds: ['compaction', 'episode-fold'] })

    /*
     * 缺字段不再等于不可信（生成器已落地）；真正会让它降级的变成水位对不上。
     */
    const divergedState = { ...seeded, sourceWatermark: { entryCount: 3, lastEntryId: 'zzz' } }
    await writeFile(stateFile, JSON.stringify(divergedState), 'utf8')
    ok(EXT.__internals.onBeforeCompact({ preparation }, ctx) === undefined, '水位 diverged → 不接管（降级回 pi）')

    /* preparation 缺字段也不能接管（不猜切割点） */
    await writeFile(stateFile, JSON.stringify(seeded), 'utf8')
    ok(EXT.__internals.onBeforeCompact({ preparation: { tokensBefore: 10 } }, ctx) === undefined, 'pi 没给 firstKeptEntryId → 不接管')
  }

  /* ============ J. 诊断日志 ============ */
  console.log('\n— J. 诊断 —')
  {
    const logFile = join(dataDir, 'ctx-ext.log')
    process.env.YAN_CONTEXT_EXT_LOG = logFile
    const branch = branchFixture()
    setPolicy({ kinds: ['tool-sweep'], recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    await EXT.__internals.onContext({ messages: messagesOf(branch) }, fakeCtx(branch))
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    ok(lines.length >= 1 && lines.some((l) => l.hook === 'context' && l.swept === 1), '每次变换写一行结构化诊断', JSON.stringify(lines.at(-1)))
    ok(lines.every((l) => typeof l.ts === 'number'), '诊断行带时间戳')
    delete process.env.YAN_CONTEXT_EXT_LOG
  }

  /* ============ K. 扩展不注册模型工具（01 §1 架构检查）+ 墓碑指向宿主 CLI ============ */
  console.log('\n— K. 扩展不注册模型工具（召回走宿主 yan context recall） —')
  {
    /*
     * 架构检查的可执行版本：砚薄层**只**承载宿主没有 CLI / RPC 等价物的
     * 生命周期钩子。这里把扩展拿到的 pi 对象记下来 —— 谁再往薄层里塞
     * `registerTool`，这条断言就会变红（01 §1 的白名单只覆盖钩子）。
     */
    const handlers = {}
    const tools = {}
    EXT.default({
      on: (name, fn) => {
        handlers[name] = handlers[name] ?? []
        handlers[name].push(fn)
      },
      registerTool: (def) => {
        tools[def.name] = def
      }
    })
    ok(typeof handlers.context?.[0] === 'function', '扩展注册了 context 钩子')
    ok(typeof handlers.session_before_compact?.[0] === 'function', '扩展注册了 session_before_compact 钩子')
    ok(
      Object.keys(tools).length === 0,
      '扩展不注册任何模型工具（context_recall 已迁到宿主 yan context recall）',
      JSON.stringify(Object.keys(tools))
    )

    /* 墓碑是模型唯一能读到「怎么取回」的地方，必须指向真实存在的入口 */
    const tombstone = T.renderTombstone({ tool: 'read', target: 'src/a.ts', tokens: 1234, ref: 'ctx://tool/m3' })
    ok(tombstone.includes('yan context recall --ref'), '墓碑给出宿主 CLI 取回方式', JSON.stringify(tombstone))
    ok(!tombstone.includes('context_recall tool'), '墓碑不再指向已移除的模型工具')
    ok(tombstone.includes('Ref: ctx://tool/m3'), '墓碑保留可复制的 ctx:// 引用')

    /* TTL 存根同理：过期召回只留引用 + 一条可执行的取回提示，不保留正文 */
    const recalled = T.wrapRecall('原始正文', 'ctx://tool/m3', 1)
    const stubbed = T.stripStaleRecalls([{ role: 'toolResult', content: [{ type: 'text', text: recalled }] }], 2)
    const stubText = stubbed.messages?.[0]?.content?.[0]?.text ?? ''
    ok(stubbed.changed === 1, '过期召回正文被替换成存根', `changed=${stubbed.changed}`)
    ok(stubText.includes('yan context recall --ref ctx://tool/m3'), '存根给出宿主 CLI 取回方式', JSON.stringify(stubText))
    ok(!stubText.includes('原始正文'), '存根不再保留正文')
  }

  /* ============ K. 默认接管集与硬约束① ============ */
  console.log('\n— K. 默认接管集（清理默认开）与“正在使用”保护 —')
  {
    delete process.env.YAN_CONTEXT_POLICY
    ok(
      EXT.__internals.policy().kinds.join(',') === 'tool-sweep,recall,episode-fold,compaction',
      '默认 kinds：清理 + 召回 + 折叠 + 压缩'
    )

    /* 夹具：A 回合读 src/a.ts（大结果），最后一个回合又在改 src/a.ts */
    const activeBranch = [
      { type: 'message', id: 'p1', message: { role: 'user', content: [{ type: 'text', text: '读一下 a.ts' }] } },
      { type: 'message', id: 'p2', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't9', name: 'read', arguments: { path: 'src/a.ts' } }] } },
      { type: 'message', id: 'p3', message: { role: 'toolResult', toolCallId: 't9', toolName: 'read', content: [{ type: 'text', text: BIG }] } },
      { type: 'message', id: 'p4', message: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
      { type: 'message', id: 'p5', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
      { type: 'message', id: 'p6', message: { role: 'user', content: [{ type: 'text', text: '现在改 a.ts' }] } },
      { type: 'message', id: 'p7', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't10', name: 'edit', arguments: { path: 'src/a.ts' } }] } },
      { type: 'message', id: 'p8', message: { role: 'toolResult', toolCallId: 't10', toolName: 'edit', content: [{ type: 'text', text: 'edited' }] } }
    ]
    const activeMessages = messagesOf(activeBranch)
    const activeIds = activeBranch.filter((e) => e.type === 'message').map((e) => e.id)
    const sweepInput = (activePaths) => ({
      messages: activeMessages,
      entryIds: activeIds,
      recentTail: { target: 0, max: 0 },
      sweep: { minTokens: 10, minReclaimTokens: 0, minReclaimRatio: 0 },
      opts: { activePaths }
    })
    const guarded = T.planToolSweep(sweepInput(T.activePathsOf(activeMessages)))
    const unguarded = T.planToolSweep(sweepInput([]))
    ok(unguarded.ok && unguarded.plan.edits.some((e) => e.entryId === 'p3'), '没人声明“正在使用”时，大结果会被清扫')
    ok(!guarded.ok || !guarded.plan.edits.some((e) => e.entryId === 'p3'), '本回合正在改的文件的结果不清扫（硬约束①）')

    /* 默认 kinds 真的会清扫：只覆盖门槛数字，不覆盖 kinds */
    setPolicy({ recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    const branch = branchFixture()
    const messages = messagesOf(branch)
    const out = await EXT.__internals.onContext({ messages }, fakeCtx(branch))
    /*
     * 按**内容**找墓碑，不用固定下标：默认 kinds 里现在含 `episode-fold`，
     * 而它会把 `state.inject` 默认为开 —— 一旦本会话带状态文件，
     * 注入块会插在**最前**，`messages[2]` 就不再是那条被清扫的工具结果了。
     * 断言的是「清扫发生了」，位置不是本用例要证明的东西。
     */
    const tombstones = (out?.messages ?? []).filter((m) => T.isTombstoneText(T.messageText(m)))
    ok(tombstones.length > 0, `默认 kinds 下清扫照常发生（清理默认开，墓碑 ${tombstones.length} 条）`)

    /* 用户把清理关掉 → 回到“什么都不做” */
    setPolicy({ kinds: ['compaction'], recentTail: { target: 1, max: 1 }, sweep: { minTokens: 10, minReclaimTokens: 10, minReclaimRatio: 0 } })
    ok((await EXT.__internals.onContext({ messages }, fakeCtx(branch))) === undefined, '关掉清理后不再改消息')
    delete process.env.YAN_CONTEXT_POLICY
  }

  /* ============ L. 请求前预算诊断（实施-05 S4） ============ */
  console.log('\n— L. 预算驱动清扫：过工作集线时跳过收益门槛 —')
  {
    const branch = branchFixture()
    const messages = messagesOf(branch)
    /*
     * 门槛高到「常规判定永远不动手」：所以下面那次清扫
     * **只可能**是预算驱动的（S4 要证的正是这条接线）。
     */
    const highThreshold = {
      recentTail: { target: 1, max: 1 },
      sweep: { minTokens: 10, minReclaimTokens: 1_000_000_000, minReclaimRatio: 1 }
    }
    const tombstonesOf = (out) => (out?.messages ?? []).filter((m) => T.isTombstoneText(T.messageText(m))).length

    /* 对照 A：窗口未知 → 预算不生效 → 高门槛说了算 → 一条都不清 */
    setPolicy({ ...highThreshold, workingSetCap: 1000 })
    const noWindow = await EXT.__internals.onContext({ messages }, fakeCtx(branch))
    ok(tombstonesOf(noWindow) === 0, '窗口未知时不越权清扫（高门槛仍然有效）')

    /*
     * 对照 B：同一份消息、同一个高门槛，只多知道窗口 + 工作集线很低 → soft →
     * 用 `forced*` 那一组门槛（默认仍为 2000 / 0.03，不是把它清零，见 C-6）。
     */
    setPolicy({ ...highThreshold, workingSetCap: 100 })
    const withWindow = await EXT.__internals.onContext(
      { messages },
      { ...fakeCtx(branch), model: { contextWindow: 200_000 } }
    )
    ok(tombstonesOf(withWindow) > 0, `过工作集线时用 forced 门槛，真的清了（墓碑 ${tombstonesOf(withWindow)} 条）`)

    /*
     * 对照 C（C-6）：到线**不再**等于“无条件清扫”。把 forced 门槛也抬到天上，
     * 同样过了工作集线就一条也不清 —— 这就是“普通内容清扫仍需回收收益条件”。
     */
    setPolicy({
      workingSetCap: 100,
      recentTail: { target: 1, max: 1 },
      sweep: {
        minTokens: 10,
        minReclaimTokens: 1_000_000_000,
        minReclaimRatio: 1,
        forcedMinReclaimTokens: 1_000_000_000,
        forcedMinReclaimRatio: 1
      }
    })
    const gated = await EXT.__internals.onContext(
      { messages },
      { ...fakeCtx(branch), model: { contextWindow: 200_000 } }
    )
    ok(tombstonesOf(gated) === 0, '到线也有收益门槛：forced 门槛高时仍然不清')

    /* 接线：窗口读得到、算得出；读不到就交回 null（回落原生压缩） */
    delete process.env.YAN_CONTEXT_POLICY
    ok(EXT.__internals.requestBudgetFor({ model: { contextWindow: 0 } }) === null, '窗口 0 → 无预算')
    const b = EXT.__internals.requestBudgetFor({ model: { contextWindow: 64_000 } })
    ok(b?.workingSet === 40_000, `requestBudgetFor 读到窗口并算出工作集（${b?.workingSet}）`)
  }

  /* ============ M. C-6：三类整理门槛与防抖候选参数 ============ */
  console.log('\n— M. C-6 门槛标定（近期尾部 / 清扫门槛 / 状态准备线）—')
  {
    /* 近期尾部：小窗口不动，大窗口放宽到 64K–96K */
    ok(T.recentTailFor(100_000).target === 32_000, '小窗口保持 32K 尾部')
    ok(T.recentTailFor(511_999).max === 48_000, '差一个 token 到大窗口档：仍用 48K 上限')
    const big = T.recentTailFor(600_000)
    ok(big.target === 64_000 && big.max === 96_000, `大窗口档放宽到 64K–96K（${big.target}/${big.max}）`)
    ok(T.recentTailFor(600_000, { target: 100_000, max: 120_000 }).target === 100_000, '用户显式给的更大的尾部不被改小')
    ok(T.recentTailFor(0).target === 32_000 && T.recentTailFor(NaN).target === 32_000, '工作集未知 → 回落小窗口值（不猜）')
  }

  /* ---------------------------------------------------------------- 收尾 */
  delete process.env.YAN_CONTEXT_POLICY
  if (savedDataDir === undefined) delete process.env.YAN_DATA_DIR
  else process.env.YAN_DATA_DIR = savedDataDir
  if (savedLog === undefined) delete process.env.YAN_CONTEXT_EXT_LOG
  else process.env.YAN_CONTEXT_EXT_LOG = savedLog
  await rm(dataDir, { recursive: true, force: true })
}
