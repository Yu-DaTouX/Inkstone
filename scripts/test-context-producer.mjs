/**
 * 状态生成器（N21-4 剩余项）的单测。
 *
 * 为什么这些断言值得钉住：生成器是**唯一**会调模型、又会写用户派生数据的部分。
 * 它的失败模式（编造约束、把陈旧状态当有效、迟到结果覆盖新快照、
 * 状态自身膨胀到吃掉工作集）都发生在真实会话里、极难复现 ——
 * 而且坏了不会让应用崩，只会让模型拿着错的世界模型干活。
 *
 * 覆盖：确定性 reducer / 提示词与解析 / 合并与 provenance / 裁剪 /
 * freshness 分档 / dirty 判定 / CAS / 真落盘（fake ctx + 真文件 + schema 交叉校验）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextProducerTests(ok, { producer, transform, extension, schema }) {
  const {
    PRODUCER_BUDGET,
    CLIP_LIMITS,
    PRODUCER_SYSTEM_PROMPT,
    evidenceFromMessages,
    exitCodeOf,
    testCountsOf,
    userDirectives,
    buildProducerPrompt,
    extractJsonObject,
    parseProducerOutput,
    matchDirective,
    mergeTaskState,
    clipTaskState,
    clipTaskStateToBudget,
    taskStateTokens,
    taskStateHardLimit,
    freshnessOf,
    applyFreshness,
    dirtyMask,
    dirtyMaskWithEvidence,
    dirtyScore,
    shouldRefresh,
    casAllows,
    buildStateFile,
    DIRTY,
    HARD_DIRTY,
    foldEligible,
    freshView,
    isSyntheticText,
    pendingUserOnly,
    stripSyntheticMessages,
    tailRolesOf,
    transcriptStats,
    turnsSince
  } = producer

  /* ---------------------------------------------------------- 1. 确定性 reducer */
  console.log('\n--- N21-4 生成器：确定性 evidence reducer ---')
  {
    ok(exitCodeOf('exit code: 1') === 1, '读得到 exit code: N')
    ok(exitCodeOf('Process exited with code 0') === 0, '读得到 exited with code N')
    ok(exitCodeOf('all good') === undefined, '读不到就 undefined（绝不猜）')
    const counts = testCountsOf('Tests  2 failed | 5 passed')
    ok(counts.passed === 5 && counts.failed === 2, '读得到 passed / failed 计数')

    const messages = [
      { role: 'user', content: [{ type: 'text', text: '不要动数据库迁移' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm run typecheck' } },
          { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'npm run build' } },
          { type: 'toolCall', id: 'c3', name: 'edit', arguments: { path: 'src/a.ts' } }
        ]
      },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'exit code: 2' }] },
      { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: 'exit code: 0' }] },
      { role: 'toolResult', toolCallId: 'c3', content: [{ type: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c4', name: 'read', arguments: { path: 'src/b.ts' } }] },
      { role: 'toolResult', toolCallId: 'c4', content: [{ type: 'text', text: 'content' }] }
    ]
    const entryIds = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']
    const evidence = evidenceFromMessages({ messages, entryIds })
    ok(evidence.ok, '正常输入能产出 evidence')
    ok(evidence.testsRun.length === 1, 'typecheck 归到 tests（不是普通命令）')
    ok(evidence.testsRun[0].source.entryId === 'e1', '测试记录带真实 entryId')
    ok(evidence.commandsRun.length === 1 && evidence.commandsRun[0].command === 'npm run build', '普通命令进 commandsRun')
    ok(evidence.commandsRun[0].exitCode === 0, '命令带退出码')
    ok(evidence.files.length === 2, '两个文件都被记下')
    ok(evidence.files.find((f) => f.path === 'src/a.ts').state === 'modified', '写类工具 → modified')
    ok(evidence.files.find((f) => f.path === 'src/b.ts').state === 'read', '读类工具 → read')
    ok(evidence.files.every((f) => f.source.kind === 'file' && f.source.confidence === 'observed'), '文件 provenance 是 observed')

    const mismatch = evidenceFromMessages({ messages, entryIds: ['e0'] })
    ok(!mismatch.ok && mismatch.reason === 'no-identity', '身份不等长 → 这次没有 evidence（不贴错 entryId）')
    const noIds = evidenceFromMessages({ messages })
    ok(!noIds.ok, '没有身份清单 → 不产 evidence')

    /* 失败的命令优先保留 */
    const many = []
    const ids = []
    for (let i = 0; i < 10; i++) {
      many.push({ role: 'assistant', content: [{ type: 'toolCall', id: `x${i}`, name: 'bash', arguments: { command: `cmd-${i}` } }] })
      many.push({ role: 'toolResult', toolCallId: `x${i}`, content: [{ type: 'text', text: i === 3 ? 'exit code: 1' : 'exit code: 0' }] })
      ids.push(`m${i}`, `r${i}`)
    }
    const ranked = evidenceFromMessages({ messages: many, entryIds: ids })
    ok(ranked.commandsRun.length === CLIP_LIMITS.commands, `命令只留最近 ${CLIP_LIMITS.commands} 条`)
    ok(ranked.commandsRun[0].command === 'cmd-3', '失败的命令排在最前（优先保留）')
  }

  /* ---------------------------------------------------------- 2. 提示词与解析 */
  console.log('\n--- N21-4 生成器：提示词与模型输出解析 ---')
  {
    ok(PRODUCER_SYSTEM_PROMPT.includes('JSON'), '系统提示要求 JSON 输出')
    ok(PRODUCER_SYSTEM_PROMPT.includes('override'), '系统提示说明宿主会覆盖确定性字段')

    const directives = userDirectives(
      [
        { role: 'user', content: [{ type: 'text', text: '第一条：不要动数据库' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'text', text: '第二条：跑完单测再提交' }] }
      ],
      ['e1', 'e2', 'e3']
    )
    ok(directives.length === 2, '只取用户消息')
    ok(directives[1].text.includes('单测'), '按时间正序（最近的在最后）')
    ok(directives[1].entryId === 'e3', '约束摘录带真实 entryId（可追溯）')

    const prompt = buildProducerPrompt({
      previousTask: null,
      directives,
      evidence: { files: [{ path: 'src/a.ts', state: 'modified' }], commandsRun: [{ command: 'npm run build', exitCode: 0 }], testsRun: [{ command: 'npm test', failed: 1 }] }
    })
    ok(prompt.includes('<user_messages>') && prompt.includes('<verified_facts>'), '提示含材料分区')
    ok(prompt.includes('src/a.ts'), '提示带上确定性事实')
    ok(prompt.includes('(none)'), '没有上一版状态时写明 none')

    ok(extractJsonObject('```json\n{"a":1}\n```')?.a === 1, '容忍 code fence')
    ok(extractJsonObject('好的，结果如下：{"a":1} 以上')?.a === 1, '容忍前后废话')
    ok(extractJsonObject('没有 JSON') === null, '没有 JSON → null')

    const parsed = parseProducerOutput(
      '{"objective":"跑通生成器","constraints":["不要动数据库","不要动数据库", 42],"nextActions":["跑单测"],"unknown":"丢掉"}'
    )
    ok(parsed.ok, '合法输出解析成功')
    ok(parsed.value.objective === '跑通生成器', 'objective 取到')
    ok(parsed.value.constraints.length === 1, '去重 + 丢掉非字符串')
    ok(parsed.value.unknown === undefined, '白名单之外的字段丢掉')
    ok(!parseProducerOutput('{"constraints":["x"]}').ok, '缺 objective → 这次生成失败')
    ok(!parseProducerOutput('not json').ok, '非 JSON → 失败')
    const long = parseProducerOutput(JSON.stringify({ objective: 'x'.repeat(400) }))
    ok(long.value.objective.length <= CLIP_LIMITS.textLength, '超长 objective 被截断')
  }

  /* ---------------------------------------------------------- 3. 合并与 provenance */
  console.log('\n--- N21-4 生成器：合并、provenance 与防幻觉 ---')
  {
    const directives = [
      { text: '不要动数据库迁移', entryId: 'u1' },
      { text: '跑完单测再提交', entryId: 'u2' }
    ]
    ok(matchDirective('不要动数据库迁移', directives)?.entryId === 'u1', '逐字命中')
    ok(matchDirective('不要动数据库迁移文件（用户要求）', directives)?.entryId === 'u1', '长条目被包含也算命中')
    ok(matchDirective('随便说点什么', directives) === null, '对不上就是 null（不硬凑）')

    const semantics = {
      objective: '把生成器做完',
      currentPhase: '实现',
      constraints: ['不要动数据库迁移'],
      decisions: ['先用纯逻辑层'],
      nextActions: ['跑单测'],
      assumptions: ['扩展能调模型']
    }
    const evidence = {
      files: [{ path: 'src/a.ts', state: 'modified', source: { kind: 'file', path: 'src/a.ts', entryId: 'e3', confidence: 'observed' } }],
      commandsRun: [{ command: 'npm run build', exitCode: 0, source: { kind: 'tool', entryId: 'e2', confidence: 'observed' } }],
      testsRun: []
    }
    const previous = {
      task: { objective: '旧目标', currentPhase: '计划' },
      constraints: [{ text: '旧约束（已作废）', status: 'superseded', supersededBy: 'c2', source: { kind: 'user', entryId: 'u0', confidence: 'observed' }, updatedAt: 1 }],
      decisions: [],
      symbolsTouched: [{ symbol: 'foo', source: { kind: 'model', confidence: 'hypothesis' } }],
      episodeRefs: ['ep-1'],
      archiveRefs: ['ctx://tool/e1']
    }
    const merged = mergeTaskState({ semantics, evidence, previous, directives, now: 1000 })
    ok(!!merged, '合并成功')
    ok(merged.task.objective === '把生成器做完', '目标来自模型')
    ok(merged.constraints[0].source.kind === 'user' && merged.constraints[0].source.entryId === 'u1', '约束命中用户原话 → kind user + entryId')
    ok(merged.decisions[0].source.kind === 'model' && merged.decisions[0].source.confidence === 'hypothesis', '模型结论标 hypothesis')
    ok(merged.files.length === 1 && merged.files[0].source.entryId === 'e3', 'files 来自 reducer（带真实 entryId）')
    ok(merged.commandsRun[0].command === 'npm run build', 'commandsRun 来自 reducer')
    ok(merged.constraints.some((c) => c.status === 'superseded'), '上一版已作废的条目仍保留（历史不丢）')
    ok(merged.symbolsTouched.length === 1, 'symbolsTouched 沿用上一版（reducer 不产出时）')
    ok(merged.episodeRefs[0] === 'ep-1' && merged.archiveRefs[0] === 'ctx://tool/e1', '引用字段沿用上一版')

    /* 防幻觉：模型给 files/commands 也必须被 reducer 覆盖 */
    const hallucinated = mergeTaskState({
      semantics: { ...semantics, files: ['/etc/passwd'], commandsRun: ['rm -rf /'] },
      evidence,
      previous: null,
      directives: [],
      now: 1
    })
    ok(hallucinated.files.length === 1 && hallucinated.files[0].path === 'src/a.ts', '模型编的 files 被 reducer 覆盖')
    ok(hallucinated.commandsRun.length === 1 && hallucinated.commandsRun[0].command === 'npm run build', '模型编的命令被覆盖')

    const noObjective = mergeTaskState({ semantics: { decisions: ['x'] }, evidence, previous: null, directives: [], now: 1 })
    ok(noObjective === null, '没有 objective → 不产生状态')

    const emptyEvidence = mergeTaskState({ semantics, evidence: { files: [], commandsRun: [], testsRun: [] }, previous, directives, now: 1 })
    ok(emptyEvidence.files.length === 0, 'reducer 读不到文件时就是空（不沿用旧文件清单）')
  }

  /* ---------------------------------------------------------- 4. 裁剪与预算 */
  console.log('\n--- N21-4 生成器：状态自身的预算与裁剪 ---')
  {
    ok(taskStateHardLimit(0) === PRODUCER_BUDGET.hardCeil, '工作集未知 → 用上限 6000')
    ok(taskStateHardLimit(1_000_000) === PRODUCER_BUDGET.hardCeil, '工作集很大 → 仍封顶 6000')
    ok(taskStateHardLimit(100_000) === PRODUCER_BUDGET.hardFloor, '工作集 100k → 2500 下限')

    const fat = {
      task: { objective: '目标', currentPhase: '实现' },
      constraints: Array.from({ length: 40 }, (_, i) => ({ text: `约束 ${i}`, status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 })),
      failedAttempts: Array.from({ length: 30 }, (_, i) => ({ text: `失败 ${i}`, status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 })),
      hypothesis: Array.from({ length: 200 }, (_, i) => ({ text: `猜测 ${i} `.repeat(20), status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 })),
      decisions: [],
      currentState: [],
      completed: [],
      unresolved: [],
      nextActions: [],
      assumptions: [],
      files: [],
      commandsRun: [],
      testsRun: [],
      symbolsTouched: [],
      episodeRefs: [],
      archiveRefs: []
    }
    const clipped = clipTaskState(fat)
    ok(clipped.constraints.length === CLIP_LIMITS.constraints, `约束裁到 ${CLIP_LIMITS.constraints}`)
    ok(clipped.failedAttempts.length === CLIP_LIMITS.failedAttempts, '失败尝试按上限裁')
    ok(clipped.hypothesis.length === CLIP_LIMITS.hypothesis, '猜测按上限裁')

    const over = clipTaskStateToBudget(fat, 0)
    ok(over.tokens <= PRODUCER_BUDGET.hardCeil, `反复裁剪后落到上限内（${over.tokens}）`)
    ok(over.task.task.objective === '目标', '目标永不删')
    ok(over.task.constraints.length > 0, '约束不删（只按上限裁）')
    ok(over.task.failedAttempts.length > 0, '失败尝试优先保留')

    const priority = clipTaskState({
      ...fat,
      hypothesis: [],
      commandsRun: [
        { command: 'ok-1', exitCode: 0, source: { kind: 'tool', confidence: 'observed' } },
        { command: 'bad', exitCode: 1, source: { kind: 'tool', confidence: 'observed' } }
      ],
      testsRun: [
        { command: 'pass', passed: 3, failed: 0, source: { kind: 'tool', confidence: 'observed' } },
        { command: 'fail', passed: 1, failed: 2, source: { kind: 'tool', confidence: 'observed' } }
      ]
    })
    ok(priority.commandsRun[0].command === 'bad', '失败的测试/命令排在前面')
    ok(priority.testsRun[0].command === 'fail', '失败的测试排在前面')
  }

  /* ---------------------------------------------------------- 5. freshness 分档 */
  console.log('\n--- N21-4 生成器：freshness（有界陈旧）---')
  {
    const entries = ['e1', 'e2', 'e3', 'e4'].map((id) => ({ id, type: 'message' }))
    ok(freshnessOf({ stateWatermark: { entryCount: 4, lastEntryId: 'e4' }, entries }).relation === 'same', '完全一致 → same')
    const older = freshnessOf({ stateWatermark: { entryCount: 2, lastEntryId: 'e2' }, entries })
    ok(older.relation === 'older' && older.gap === 2, '前缀 → older + gap')
    ok(freshnessOf({ stateWatermark: { entryCount: 4, lastEntryId: 'zz' }, entries }).relation === 'diverged', '找不到那条 entryId → diverged')
    ok(freshnessOf({ stateWatermark: null, entries }).relation === 'diverged', '没有水位 → diverged')
    ok(freshnessOf({ stateWatermark: { entryCount: 0, lastEntryId: null }, entries }).relation === 'older', '空会话水位 → older')

    const task = {
      task: { objective: '目标', currentPhase: '实现' },
      constraints: [{ text: '约束', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }],
      hypothesis: [{ text: '猜测', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }],
      nextActions: [{ text: '下一步', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }],
      assumptions: [{ text: '假设', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }],
      decisions: [{ text: '决定', status: 'active', source: { kind: 'model', confidence: 'hypothesis' }, updatedAt: 1 }],
      currentState: [],
      completed: [],
      failedAttempts: [],
      unresolved: [],
      files: [],
      commandsRun: [],
      testsRun: [],
      symbolsTouched: [],
      episodeRefs: [],
      archiveRefs: []
    }
    const fresh = applyFreshness(task, { relation: 'same', gap: 0 })
    ok(fresh.tier === 'fresh' && fresh.task.hypothesis[0].stale === undefined, 'same：原样')
    const soft = applyFreshness(task, { relation: 'older', gap: 1 })
    ok(soft.tier === 'stale-soft', 'gap 1 → stale-soft')
    ok(soft.task.hypothesis[0].stale === true && soft.task.nextActions[0].stale === true, '推测类字段标 stale')
    ok(soft.task.constraints[0].stale === undefined, '约束不标 stale（它是硬事实）')
    const rendered = transform.renderTaskState(soft.task)
    ok(rendered.includes('stale'), '渲染时把 stale 显式写出来（不静默当有效）')
    const hard = applyFreshness(task, { relation: 'older', gap: 5 })
    ok(hard.tier === 'stale-hard' && hard.task.decisions.length === 0, 'gap 3–6：语义推测全丢')
    ok(hard.task.constraints.length === 1, '但约束仍在')
    ok(applyFreshness(task, { relation: 'older', gap: 9 }).task === null, 'gap > 6：不注入')
    ok(applyFreshness(task, { relation: 'diverged', gap: Infinity }).task === null, 'diverged：不注入')
  }

  /* ---------------------------------------------------------- 5.5 落后几回合（单位口径） */
  console.log('\n--- N21-4 生成器：落后回合数（不是条目数）---')
  {
    /*
     * 为什么要钉住这个：一个回合会产生**多条** entry（user + assistant + N 个 toolResult）。
     * 用条目差当「落后几回合」，会让 dirty 权重（≥6）与净增（≥6000）两道门槛
     * 在长会话里形同虚设 —— 而「开着 episode-fold 到底花多少钱」正是由它决定的。
     */
    const entries = [
      { id: 'e1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '第一轮' }] } },
      { id: 'e2', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
      { id: 'e3', type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } },
      { id: 'e4', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '第二轮' }] } },
      { id: 'e5', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }
    ]
    const fresh = freshnessOf({ stateWatermark: { entryCount: 1, lastEntryId: 'e1' }, entries })
    ok(fresh.gap === 4, '条目差是 4（旧口径会把它当成「落后 4 个回合」）', String(fresh.gap))
    ok(fresh.turnsGap === 1, '真实落后只有 1 个回合（中间那些是同回合的 assistant / toolResult）', String(fresh.turnsGap))
    ok(!shouldRefresh({ settledGap: fresh.turnsGap }).needed, '落后 1 回合 → 不刷新（省额度）')
    ok(shouldRefresh({ settledGap: 2 }).reason === 'settled-gap', '落后 2 回合 → 刷新')
    ok(turnsSince(entries, { entryCount: 5, lastEntryId: 'e5' }) === 0, '水位就在末尾 → 0 回合')
    ok(turnsSince(entries, { entryCount: 1, lastEntryId: 'nope' }) === null, '水位条目找不到 → null（调用方用条目差兜底）')
    const stats = transcriptStats(entries)
    ok(stats.userTurns === 2, '数的是**用户**回合', String(stats.userTurns))
    ok(stats.tokens > 0, '转录 token 是估算值（>0）', String(stats.tokens))
  }

  /* ---------------------------------------------------------- 5.6 输入自净与激活门槛 */
  console.log('\n--- N21-4 生成器：输入自净与激活门槛（第四轮外部评审）---')
  {
    ok(isSyntheticText('<TASK_STATE derived="true">x</TASK_STATE>'), '认得出状态注入块（P0-1）')
    ok(isSyntheticText('[Archived tool result]\nRef: ctx://tool/m1'), '认得出墓碑（P0-1）')
    ok(isSyntheticText('[Recalled context] turn=1 ref=ctx://tool/m1\n原文'), '认得出召回正文（P0-1）')
    ok(!isSyntheticText('请把迁移文件删掉'), '普通用户消息不是 synthetic')

    const messages = [
      { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      { role: 'custom', customType: 'yan-task-state', content: [{ type: 'text', text: '<TASK_STATE>旧状态</TASK_STATE>' }] },
      { role: 'user', content: [{ type: 'text', text: '第二轮' }] }
    ]
    const ids = ['e1', 'e2', 'e3', 'e4']
    const cleaned = stripSyntheticMessages(messages, ids)
    ok(cleaned.removed === 1 && cleaned.messages.length === 3, '注入口那一类被剔掉', `removed=${cleaned.removed}`)
    ok(cleaned.messages[0].role === 'user' && cleaned.messages[2].role === 'user', '真实消息顺序不变')
    ok(cleaned.entryIds.join(',') === 'e1,e2,e4', 'entryIds 与 messages 仍一一对应', cleaned.entryIds.join(','))
    ok(stripSyntheticMessages([], []).messages.length === 0, '空输入不抛错')

    ok(!foldEligible({ settledTurns: 3, transcriptTokens: 100_000 }).eligible, '回合不够 → 不激活（短任务不背闭环误差风险）')
    ok(!foldEligible({ settledTurns: 9, transcriptTokens: 10_000 }).eligible, '转录太小 → 不激活')
    ok(foldEligible({ settledTurns: 4, transcriptTokens: 48_000 }).eligible, '回合数 + 转录 token 都到 → 激活')
    /*
     * 最低回合数是**全局地板**（第四轮复核 Q1 第 2 条）：不能让清扫分支绕过它，
     * 否则「早期一回合生成了一个肥工具输出」会被当成「有足够历史值得提炼」，
     * 而且 sticky 之后再也退不回来。
     */
    ok(
      !foldEligible({ firstSweep: true, settledTurns: 1 }).eligible,
      '清扫过但回合数不够 → 仍不激活（地板是全局的）'
    )
    ok(foldEligible({ firstSweep: true, settledTurns: 4 }).reason === 'first-sweep', '回合够 + 清扫过 → 激活')
    ok(
      foldEligible({ settledTurns: 6, transcriptTokens: 1_000 }).reason === 'small-transcript',
      '回合够但转录太小 → 理由单列（便于诊断）'
    )
  }

  /* ---------------------------------------------------------- 5.7 pending-only 与注入视角 */
  console.log('\n--- N21-4 生成器：只落后一条用户消息不算陈旊 ---')
  {
    const userEntry = (id) => ({ id, type: 'message', message: { role: 'user', content: [{ type: 'text', text: id }] } })
    const assistantEntry = (id) => ({ id, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: id }] } })
    const settled = [userEntry('c1'), assistantEntry('c2'), userEntry('c3'), assistantEntry('c4')]
    const watermark = { entryCount: 4, lastEntryId: 'c4' }
    /* 完全同步 */
    ok(pendingUserOnly(settled, watermark) === false, '完全同步 → 不适用（由 relation 处理）')
    /* 正常消费路径：生成后用户又开口了，但没有新执行事实 */
    const pending = [...settled, userEntry('c5')]
    ok(pendingUserOnly(pending, watermark) === true, '水位后恰好一条 user → pending-only')
    const f = freshnessOf({ stateWatermark: watermark, entries: pending })
    ok(f.relation === 'older' && f.turnsGap === 1 && f.pendingOnly === true, '原分档确实是「落后 1 回合」', JSON.stringify({ gap: f.gap, turns: f.turnsGap }))
    ok(
      freshView(f).relation === 'same' && freshView(f).gap === 0,
      '注入视角视为同步 —— 否则 fresh 在稳态下永远不可达（第四轮复核 Q3）'
    )
    /* 一旦出现新的执行事实（toolResult / assistant 执行）→ 回到真实分档 */
    ok(pendingUserOnly([...pending, assistantEntry('c6')], watermark) === false, '有新的 assistant 执行 → 不再 pending-only')
    const f2 = freshnessOf({ stateWatermark: watermark, entries: [...pending, assistantEntry('c6')] })
    ok(f2.pendingOnly === false && freshView(f2).relation === 'older', '有新证据 → 仍走真实分档（不被新鲜度偏移掉）')
    ok(pendingUserOnly(pending, { entryCount: 4, lastEntryId: 'nope' }) === false, '水位条目定位不到 → 不假设')
    ok(freshView({ relation: 'older', gap: 3, pendingOnly: false }).relation === 'older', 'pendingOnly 为假时 freshView 不动它')
    /* 用户连发两条（follow-up）不算“只落后一条” */
    ok(pendingUserOnly([...settled, userEntry('c5'), userEntry('c6')], watermark) === false, '连续两条 user → 不算 pending-only')
    /*
     * pi 会在用户消息之后/之前写一些**非执行**的包装条目（custom_message 等）。
     * 它们不影响「用户又说了句话」这个事实，所以判据要能容忍它们 ——
     * 否则真实会话里永远判不出 pending-only（线上第一次就是卡在这里）。
     */
    const wrapped = [...settled, userEntry('c5'), { id: 'c5w', type: 'custom_message', summary: 'x' }]
    ok(pendingUserOnly(wrapped, watermark) === true, 'user + pi 的包装条目（custom_message）仍算 pending-only')
    ok(
      tailRolesOf(wrapped, watermark).join(',') === 'user,custom_message',
      'tailRolesOf 给出角色指纹（线上排查就靠它）',
      tailRolesOf(wrapped, watermark).join(',')
    )
    /*
     * `session_info` 是线上真实踩到的那个包装类型（诊断 `tail: ["session_info","user"]`）。
     * 判据用**反向**表达（非 message 不构成执行事实），而不是枚举包装类型 ——
     * 枚举必然会漏掉下一个新类型。
     */
    ok(
      pendingUserOnly([...settled, { id: 'c5s', type: 'session_info' }, userEntry('c5')], watermark) === true,
      'user + session_info ✓（枚举包装类型会漏掉它）'
    )
    ok(
      pendingUserOnly([...settled, { id: 'c5t', type: 'message', message: { role: 'toolResult', content: [] } }], watermark) ===
        false,
      '只多了 toolResult（执行事实）→ 不算 pending-only'
    )
    ok(tailRolesOf(settled, { entryCount: 4, lastEntryId: 'nope' }) === null, '定位不到水位 → tailRolesOf 返回 null')
  }

  /* ---------------------------------------------------------- 6. dirty 与刷新判定 */
  console.log('\n--- N21-4 生成器：刷新判定（dirty 位掩码）---')
  {
    const userMask = dirtyMask([{ id: 'e1', type: 'message', message: { role: 'user' } }])
    ok((userMask & DIRTY.USER_INTENT) !== 0, '用户消息 → USER_INTENT')
    ok((userMask & HARD_DIRTY) !== 0, '用户消息含 CONSTRAINT 硬触发（意图/约束必须被记住）')
    const readOnly = dirtyMaskWithEvidence(dirtyMask([]), { files: [{ path: 'a', state: 'read' }], commandsRun: [], testsRun: [] })
    ok(readOnly === 0, '纯只读不产生任何 dirty 位')
    const failing = dirtyMaskWithEvidence(0, { commandsRun: [{ command: 'x', exitCode: 1 }], testsRun: [], files: [] })
    ok((failing & DIRTY.FAILURE) !== 0, '失败命令 → FAILURE')
    ok(dirtyScore(failing) === 6, 'FAILURE 权重 5 + COMMAND_RESULT 1')

    ok(shouldRefresh({ stateMissing: true }).needed, '没有状态 → 必须生成')
    ok(shouldRefresh({ mask: DIRTY.TEST_CHANGE }).reason === 'hard-dirty', '测试变化是硬触发')
    ok(shouldRefresh({ mask: DIRTY.USER_INTENT | DIRTY.FILE_CHANGE }).needed, '权重累计 ≥6 也触发（4 + 2）')
    ok(shouldRefresh({ settledGap: 2 }).reason === 'settled-gap', '落后 ≥2 回合触发')
    ok(shouldRefresh({ deltaTokens: 6_000 }).reason === 'context-growth', '净增 ≥6000 token 触发')
    ok(!shouldRefresh({ mask: DIRTY.FILE_CHANGE }).needed, '只有一次文件改动 → 不触发（省额度）')
  }

  /* ---------------------------------------------------------- 7. CAS 与状态文件 */
  console.log('\n--- N21-4 生成器：CAS（迟到结果不许覆盖新快照）---')
  {
    ok(casAllows({ current: { revision: 1 }, precondition: { expectedRevision: 1 } }).ok, '版本一致 → 允许提交')
    ok(!casAllows({ current: { revision: 2 }, precondition: { expectedRevision: 1 } }).ok, '版本变了 → 拒绝')
    ok(casAllows({ current: { revision: 2 }, precondition: { expectedRevision: 1 } }).reason === 'revision-changed', '拒绝原因是 revision-changed')
    ok(!casAllows({ current: { revision: 1, entryCount: 3 }, precondition: { expectedRevision: 1, baseEntryCount: 5 } }).ok, '水位回退 → 拒绝')
    ok(casAllows({ current: { entryCount: 5 }, precondition: { baseEntryCount: 3 } }).ok, '水位前进（正常追加）→ 允许')

    const file = buildStateFile({ sessionId: 's1', watermark: { entryCount: 3, lastEntryId: 'e3' }, task: {}, episodes: null, now: 10, revision: 2 })
    ok(file.schemaVersion === 1 && file.revision === 2, '状态文件带 schemaVersion 与 revision')
    ok(Array.isArray(file.episodes) && file.episodes.length === 0, 'episodes 默认空数组')
  }

  /* ---------------------------------------------------------- 8. 真落盘（fake ctx） */
  console.log('\n--- N21-4 生成器：真落盘（fake ctx + schema 交叉校验）---')
  /*
   * 自己建隔离目录而不是借用 test-unit 的 `YAN_DATA_DIR`：
   * 这一块会**真写文件**，目录归属必须由它自己控制（否则一个环境变量
   * 被别的测试改过，写入就会跑到不该去的地方）。
   */
  const prevDataDir = process.env.YAN_DATA_DIR
  const produceDir = mkdtempSync(join(tmpdir(), 'yan-ctx-producer-'))
  process.env.YAN_DATA_DIR = produceDir
  try {
    const dir = join(produceDir, 'context-state')
    const sessionId = 'prodsess0001'
    const filePath = join(dir, `${sessionId}.json`)

    const entries = [
      { id: 'p1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '不要动数据库迁移' }] } },
      { id: 'p2', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'npm run build' } }] } },
      { id: 'p3', type: 'message', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'exit code: 0' }] } }
    ]
    const modelPayload = JSON.stringify({
      objective: '把状态生成器落地',
      currentPhase: '验证',
      constraints: ['不要动数据库迁移'],
      nextActions: ['跑真实回合'],
      decisions: ['先做确定性 reducer']
    })
    let callCount = 0
    const makeCtx = (over = {}) => ({
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
        getBranch: () => entries
      },
      model: { provider: 'test', id: 'fake', maxTokens: 4096 },
      modelRegistry: {
        complete: async () => {
          callCount++
          return { content: [{ type: 'text', text: modelPayload }], stopReason: 'stop' }
        }
      },
      ...over
    })

    extension.__internals.resetProducerFlight()
    await extension.__internals.produceAndCommit(sessionId, makeCtx())
    ok(callCount === 1, '真的调了一次无工具 completion')
    const written = JSON.parse(readFileSync(filePath, 'utf8'))
    ok(written.revision === 1, `首次落盘 revision=1（实际 ${written.revision}）`)
    ok(written.task.task.objective === '把状态生成器落地', '目标写进状态文件')
    ok(written.task.commandsRun.length === 1 && written.task.commandsRun[0].command === 'npm run build', '命令来自 reducer')
    ok(written.task.constraints[0].source.kind === 'user' && written.task.constraints[0].source.entryId === 'p1', '约束带真实用户 entryId')

    /* 交叉校验：JS 写出的状态必须过 TS schema（两边不许各信各的） */
    const inspected = schema.inspectContextStateFile(written, { knownEntryIds: entries.map((e) => e.id) })
    ok(inspected.status === 'ok', `JS 产出的状态文件过 TS schema（${inspected.status}）`)
    if (inspected.status !== 'ok') console.log('   ', JSON.stringify(inspected.issues?.slice(0, 4)))
    ok(inspected.status === 'ok' && inspected.state.revision === 1, 'schema 读回 revision')

    /*
     * CAS：**生成期间**磁盘被别的写改掉 → 这次结果必须被拒
     * （迟到结果不许覆盖新快照）。关键是在 completion 的回调里改文件 ——
     * 在调用前改只会让 previous 读到新值，反而证明不了 CAS。
     */
    await extension.__internals.produceAndCommit(sessionId, makeCtx({
      modelRegistry: {
        complete: async () => {
          writeFileSync(filePath, JSON.stringify({ ...written, revision: 9 }, null, 2), 'utf8')
          return { content: [{ type: 'text', text: modelPayload }], stopReason: 'stop' }
        }
      }
    }))
    const after = JSON.parse(readFileSync(filePath, 'utf8'))
    ok(after.revision === 9, `生成期间被改过 → CAS 拒绝，文件保持对方的版本（实际 ${after.revision}）`)
    /* 恢复成 revision=1 的可写状态，供后面的失败路径用例使用 */
    writeFileSync(filePath, JSON.stringify(written, null, 2), 'utf8')

    /* 模型输出不合法 / 调用失败 → 文件保持原样 */
    const before = readFileSync(filePath, 'utf8')
    await extension.__internals.produceAndCommit(sessionId, makeCtx({
      modelRegistry: { complete: async () => ({ content: [{ type: 'text', text: '这里没有 JSON' }], stopReason: 'stop' }) }
    }))
    ok(readFileSync(filePath, 'utf8') === before, '模型没给 JSON → 不落盘')
    await extension.__internals.produceAndCommit(sessionId, makeCtx({
      modelRegistry: { complete: async () => { throw new Error('boom') } }
    }))
    ok(readFileSync(filePath, 'utf8') === before, '调用抛错 → 不落盘')
    await extension.__internals.produceAndCommit(sessionId, makeCtx({ modelRegistry: null }))
    ok(readFileSync(filePath, 'utf8') === before, '没有 modelRegistry → 不落盘（能力缺失优雅降级）')
  } finally {
    if (prevDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prevDataDir
    rmSync(produceDir, { recursive: true, force: true })
  }

  /* ---------------------------------------------------------- 9. 钩子注册 */
  console.log('\n--- N21-4 生成器：钩子注册 ---')
  {
    const handlers = {}
    extension.default({ on: (name, fn) => { handlers[name] = (handlers[name] ?? []).concat(fn) }, registerTool: () => {} })
    ok(typeof handlers.agent_settled?.[0] === 'function', '扩展注册了 agent_settled 钩子（生成器的触发点）')

    /* 默认 kinds 不含 episode-fold → 不生成（默认不花钱） */
    const saved = process.env.YAN_CONTEXT_POLICY
    delete process.env.YAN_CONTEXT_POLICY
    const p = extension.__internals.policy()
    ok(!p.kinds.includes('episode-fold'), '默认不接管 episode-fold（默认不调模型）')
    process.env.YAN_CONTEXT_POLICY = saved
    const tokenTask = {
      task: { objective: 'x', currentPhase: '' },
      constraints: [{ text: '约束', status: 'active', source: { kind: 'user', entryId: 'm1', confidence: 'observed' }, updatedAt: 1 }],
      decisions: [],
      currentState: [],
      completed: [],
      failedAttempts: [],
      unresolved: [],
      nextActions: [],
      assumptions: [],
      hypothesis: [],
      files: [],
      commandsRun: [],
      testsRun: [],
      symbolsTouched: [],
      episodeRefs: [],
      archiveRefs: []
    }
    ok(taskStateTokens(tokenTask) > 0, '状态渲染有 token 估算')
    ok(taskStateTokens({ ...tokenTask, constraints: [] }) === 0, '只有目标没条目 → 视为空状态（不注入空壳）')
  }
}
