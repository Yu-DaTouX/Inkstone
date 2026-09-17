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
    citableEntries,
    verifyEntryRefs,
    provenanceCounts,
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
    stateOverhead,
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

  /* ------------------------------------------------ 3.5 provenance（第五轮外部意见 Q1 的 P0-③） */
  console.log('\n--- provenance：可引用清单、校验与三档证据 ---')
  {
    const directives = [
      { text: '不要动数据库迁移', entryId: 'u1' },
      { text: '跑完单测再提交', entryId: 'u2' }
    ]
    const evidence = {
      files: [{ path: 'src/a.ts', state: 'modified', source: { kind: 'file', path: 'src/a.ts', entryId: 'e3', confidence: 'observed' } }],
      commandsRun: [{ command: 'npm run build', exitCode: 0, source: { kind: 'tool', entryId: 'e2', confidence: 'observed' } }],
      testsRun: []
    }

    /* ① 可引用清单：**只装本轮材料** */
    const citable = citableEntries({ directives, evidence })
    ok(citable.length === 4, `清单装齐本轮材料（${citable.map((c) => c.entryId).join(',')}）`)
    ok(citable[0].entryId === 'u1' && citable[0].kind === 'user', '用户原话在前（模型最常引用的证据）')
    ok(citable.some((c) => c.entryId === 'e2' && c.kind === 'tool'), '工具结果带 kind=tool')
    ok(citable.some((c) => c.entryId === 'e3' && c.kind === 'file'), '文件带 kind=file')
    ok(citableEntries({ directives: [], evidence: {} }).length === 0, '空输入 → 空清单')

    /* ② 校验：只认清单里的 */
    const verified = verifyEntryRefs(['u1', 'e2', 'e3', 'u1', 'ghost'], citable)
    ok(verified.ok.length === 3, '合法引用取到 3 条（并去重）')
    ok(verified.bad.length === 1 && verified.bad[0] === 'ghost', '编造的 id 进 bad（诊断用）')
    ok(verifyEntryRefs(null, citable).ok.length === 0, '非数组输入不抛错')
    ok(verifyEntryRefs(['x'], null).bad.length === 1, '清单缺失 → 一律非法（宁保守）')

    /* ③ 解析：对象形态与引用合并 */
    const parsed = parseProducerOutput(
      JSON.stringify({
        objective: '带引用的状态',
        nextActions: [{ text: '跑单测', entryIds: ['u2'] }, '另一件事'],
        decisions: [{ text: '同一句', entryIds: ['u1'] }, { text: '同一句', entryIds: ['e2'] }]
      })
    )
    ok(parsed.ok, '对象形态解析成功')
    ok(parsed.value.nextActions[0].text === '跑单测' && parsed.value.nextActions[0].entryIds[0] === 'u2', '对象条目带出 entryIds')
    ok(parsed.value.nextActions[1].entryIds.length === 0, '裸字符串 → 空引用（不猜）')
    ok(parsed.value.decisions.length === 1 && parsed.value.decisions[0].entryIds.length === 2, '同一句话的引用被合并而不是丢弃')

    /* ④ 落盘三档 */
    const semantics = {
      objective: '目标',
      constraints: [{ text: '不要动数据库迁移', entryIds: ['u1'] }],
      decisions: [{ text: '引用工具结果', entryIds: ['e2'] }],
      nextActions: [{ text: '指不出证据的推断' }],
      hypothesis: [{ text: '引用一个不存在的 id', entryIds: ['ghost'] }]
    }
    const merged = mergeTaskState({ semantics, evidence, previous: { task: { objective: '旧' } }, directives, citable, now: 1000 })
    ok(!!merged, '合并成功')
    const byText = (list, text) => (list ?? []).find((i) => i.text === text)
    ok(byText(merged.constraints, '不要动数据库迁移')?.source.confidence === 'observed', '引用用户原话 → observed')
    ok(byText(merged.decisions, '引用工具结果')?.source.confidence === 'derived', '引用工具结果 → derived（从观察到的事实推出）')
    ok(byText(merged.decisions, '引用工具结果')?.source.kind === 'tool', '引用工具结果 → kind=tool（schema 只允许 user/tool 带 entryId）')
    ok(byText(merged.nextActions, '指不出证据的推断')?.source.kind === 'model', '无引用 → kind=model')
    ok(byText(merged.nextActions, '指不出证据的推断')?.source.confidence === 'hypothesis', '无引用 → hypothesis（渲染时会标 inferred）')
    ok(byText(merged.hypothesis, '引用一个不存在的 id')?.source.confidence === 'hypothesis', '引用不存在 → 降级 hypothesis（不伪造 provenance）')

    /* ⑤ 断递归：上一版说过的、本轮找不到证据的，不能靠「上一版有」保住 observed */
    const previousState = {
      task: { objective: '旧目标' },
      decisions: [{ text: '旧决策', status: 'active', source: { kind: 'user', entryId: 'prev-9', confidence: 'observed' }, updatedAt: 1 }]
    }
    const controlCitable = citableEntries({ directives: [{ text: '旧决策', entryId: 'prev-9' }], evidence: {} })
    ok(controlCitable.length === 1, '（对照）如果上一版的 id 真在清单里，它是能当证据的')
    const inherited = mergeTaskState({
      semantics: { objective: '新目标', decisions: [{ text: '旧决策', entryIds: ['prev-9'] }] },
      evidence: {},
      previous: previousState,
      directives,
      citable,
      now: 2000
    })
    ok(inherited.decisions[0].source.confidence === 'hypothesis', '上一版的 id 不在本轮清单 → 只能当推断（这才是断递归）')
    ok(!inherited.decisions.some((d) => d.source.entryId === 'prev-9'), '上一版的 entryId 不会被继承进新快照')

    /* ⑥ 统计（诊断用，**不落盘**） */
    const counts = provenanceCounts(merged)
    ok(counts.observed === 1 && counts.derived === 1 && counts.hypothesis === 2, `分布正确 ${JSON.stringify(counts)}`)
    ok(counts.total === 4, 'total = 三档之和')
    ok(provenanceCounts(null).total === 0, '空输入不抛错')
    ok(!('provenance' in merged), '统计不写进状态主体（否则主进程会判非法）')

    /* ⑦ 提示词：清单进 prompt，且与上一版状态分先后 */
    const prompt = buildProducerPrompt({ previousTask: previousState, directives, evidence, citable })
    ok(prompt.includes('<citable_entries>'), 'prompt 里有可引用区块')
    ok(prompt.includes('- u1 (user)'), '清单带 id 与 kind')
    ok(prompt.includes('<previous_state>') && prompt.indexOf('<previous_state>') < prompt.indexOf('<citable_entries>'), '先给上一版现状、再给可引用清单')
    ok(!prompt.slice(prompt.indexOf('<citable_entries>')).includes('prev-9'), '上一版的 id 不会出现在可引用清单里')
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
    /*
     * State Refresh 档（N21-6）：用量接近窗口也激活，不必等到压缩 ——
     * 状态是「压缩时接管」的前提，等压缩真来了才第一次刷新就晚了。
     * 默认比例 0.42 = 参考方案的「工作集 60%」× 默认 windowRatio 0.7。
     *
     * 注意挑区间：`near-window` 排在 `long-session`（48k）之后，所以要验证它，
     * token 必须落在「窗口 × 0.42」到 48k 之间 —— 否则先命中的是 long-session，
     * 这条断言就变成在测另一条分支了（第一版就是这么错的）。
     */
    ok(
      foldEligible({ settledTurns: 4, transcriptTokens: 45_000, windowTokens: 100_000 }).reason === 'near-window',
      '转录到窗口的 42% 且未到 48k → 激活（理由 near-window）'
    )
    ok(
      !foldEligible({ settledTurns: 4, transcriptTokens: 41_999, windowTokens: 100_000 }).eligible,
      '差一个 token 也不激活（边界不含糊）'
    )
    ok(
      !foldEligible({ settledTurns: 4, transcriptTokens: 40_000, windowTokens: 0 }).eligible,
      '拿不到窗口大小 → 这条分支整条跳过（不猜绝对值）'
    )
    ok(
      !foldEligible({ settledTurns: 3, transcriptTokens: 45_000, windowTokens: 100_000 }).eligible,
      '窗口再小也得先过回合地板'
    )
    ok(
      foldEligible({ settledTurns: 4, transcriptTokens: 50, windowTokens: 1_000, refreshRatio: 0.01 }).eligible,
      'refreshRatio 可被策略覆盖（测试与调参用）'
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

  /* ---------------------------------------------------------- 5.8 状态生成的开销 */
  console.log('\n--- N21-4 生成器：状态生成开销（决定增量 delta 值不值得做）---')
  {
    const low = stateOverhead({ producerInput: 3_000, producerOutput: 400, agentInput: 40_000, agentOutput: 10_000 })
    ok(low.ratio < 0.07 && low.level === 'low', '生成开销远小于主 agent → 不必为它加复杂度', String(low.ratio.toFixed(4)))
    const watch = stateOverhead({ producerInput: 4_000, producerOutput: 1_200, agentInput: 20_000, agentOutput: 10_000 })
    ok(watch.level === 'watch', '15%–25% → 观察档')
    const high = stateOverhead({ producerInput: 20_000, producerOutput: 1_200, agentInput: 40_000, agentOutput: 10_000 })
    ok(high.level === 'high' && high.ratio > 0.25, '>25% → 高（外部说这种情形要把 delta 升 P1）')
    ok(stateOverhead({}).level === 'unknown', '分母为 0 → unknown（不算出 Inf 骗自己）')
    ok(stateOverhead({ producerInput: 100 }).stateTokens === 100, '缺省字段按 0 算')
  }

  /* ---------------------------------------------------------- 5.9 生成器输入是有界的 */
  console.log('\n--- N21-4 生成器：输入有界（这就是增量 delta 值不值得做的判据）---')
  {
    /*
     * 为什么这条值得钉：第四轮复核的成本警告基于「生成器喂 raw transcript」的假设，
     * 与我们实际做的事**不同** —— 输入是「上一版状态（有硬 cap）+ 最近 8 条用户消息
     * （每条 ≤240 字符）+ 有上限的确定性证据」。如果将来有人把 evidence 改成全量，
     * 这条断言会立即变红。
     */
    const fill = (n, text) => Array.from({ length: n }, (_, i) => ({ text: `${text} ${i}`, status: 'active', updatedAt: 1 }))
    const bigTask = {
      task: { objective: '把上下文状态层做成可用的东西', currentPhase: '实现与验证' },
      currentState: fill(CLIP_LIMITS.currentState, '正在处理'),
      decisions: fill(CLIP_LIMITS.decisions, '决定'),
      constraints: fill(CLIP_LIMITS.constraints, '约束'),
      completed: fill(CLIP_LIMITS.completed, '已完成'),
      failedAttempts: fill(CLIP_LIMITS.failedAttempts, '失败尝试'),
      unresolved: fill(CLIP_LIMITS.unresolved, '未解决'),
      nextActions: fill(CLIP_LIMITS.nextActions, '下一步'),
      assumptions: fill(CLIP_LIMITS.assumptions, '假设'),
      hypothesis: fill(CLIP_LIMITS.hypothesis, '推测'),
      files: Array.from({ length: CLIP_LIMITS.files }, (_, i) => ({ path: `src/renderer/src/components/file-${i}.tsx`, state: 'modified' })),
      commandsRun: Array.from({ length: CLIP_LIMITS.commands }, (_, i) => ({ command: `npm run step-${i}`, exitCode: i % 3 === 0 ? 1 : 0 })),
      testsRun: Array.from({ length: CLIP_LIMITS.tests }, (_, i) => ({ command: `npm test -- suite-${i}`, failed: i === 0 ? 2 : 0, passed: 12 })),
      archiveRefs: [],
      episodeRefs: []
    }
    const bigStateTokens = transform.estimateTokens(transform.renderTaskState(bigTask))
    const session = (turns) => {
      const messages = []
      const entryIds = []
      for (let i = 0; i < turns; i += 1) {
        messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 轮：继续实现第 ${i} 个模块，注意不要动数据库迁移。` }] })
        entryIds.push(`u${i}`)
        messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: `npm run step-${i}` } }] })
        entryIds.push(`a${i}`)
        messages.push({ role: 'toolResult', toolCallId: `c${i}`, content: [{ type: 'text', text: `exit code: ${i % 2}\nstep ${i} done` }] })
        entryIds.push(`t${i}`)
      }
      return { messages, entryIds }
    }
    const measure = (turns) => {
      const s = session(turns)
      const evidence = evidenceFromMessages({ messages: s.messages, entryIds: s.entryIds })
      const directives = userDirectives(s.messages, s.entryIds)
      return transform.estimateTokens(buildProducerPrompt({ previousTask: bigTask, directives, evidence }))
    }
    const t5 = measure(5)
    const t100 = measure(100)
    const t1000 = measure(1000)
    console.log(`    满状态渲染 ≈ ${bigStateTokens} token；prompt：5 回合 ≈ ${t5}，100 回合 ≈ ${t100}，1000 回合 ≈ ${t1000}`)
    ok(t1000 < 6_000, `1000 回合的 prompt 仍 < 6000 token（实际 ${t1000}）—— 不随会话长度爆`, String(t1000))
    ok(t1000 - t5 < 2_000, `5 → 1000 回合只多 ${t1000 - t5} token（多的是 8 条最近用户消息 + 有上限的证据）`, String(t1000 - t5))
    ok(bigStateTokens < 8_000, `「满状态」渲染本身也在预算内（${bigStateTokens}）`)
    ok(
      transform.estimateTokens(buildProducerPrompt({ previousTask: null, directives: [], evidence: { files: [], commandsRun: [], testsRun: [] } })) < 600,
      'previous 为空时 prompt 就是一个小壳子'
    )
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
     * 阶段运行状态（§12.3）：成功落盘要立即上锁并记下冷却。
     * 这条与下一条是「三阶段独立 Rearm/Cooldown」在真实生成路径上的接线凭证 ——
     * 纯函数层的边界在 `test-context-stage-runtime.mjs` 里钉。
     */
    const rtOk = extension.__internals.stageRuntimeOf('episode-fold', sessionId)
    ok(rtOk.armed === false && rtOk.lastOk === true, '落盘成功后立即上锁')
    ok(rtOk.cooldownUntil > Date.now() - 1000, '上锁同时记下冷却到期时间')

    /*
     * 上锁之后不会再跑（§12.3）：把会话弄得「该刷新」（新增两个用户回合 →
     * settled-gap 触发），但**不清**运行状态 —— 这次调用必须被挡在模型调用之前。
     *
     * 为什么必须让它「脏」：不脏时 `shouldRefresh` 先就拦下了，断言就变成
     * 「测脏判定」而不是「测节流」（两者的区别恰恰是 `stageStep` 的插入位置）。
     * 拦它的是**未重新上膛**（扩展侧没有用量回落信号，5 分钟重试窗口还没到）；
     * 同一函数里的冷却分支在扩展侧通常不命中，它的边界在
     * `test-context-stage-runtime.mjs` 里单独钉。
     */
    entries.push({ id: 'p4', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '继续' }] } })
    entries.push({ id: 'p5', type: 'message', message: { role: 'user', content: [{ type: 'text', text: '再继续' }] } })
    const beforeCooling = callCount
    await extension.__internals.produceAndCommit(sessionId, makeCtx())
    const afterCooling = JSON.parse(readFileSync(filePath, 'utf8'))
    ok(
      callCount === beforeCooling && afterCooling.revision === 1,
      `脏了但尚未重新上膛 → 一次模型都不调、状态也不动（实际 calls=${callCount}, revision=${afterCooling.revision}）`
    )

    /*
     * CAS：**生成期间**磁盘被别的写改掉 → 这次结果必须被拒
     * （迟到结果不许覆盖新快照）。关键是在 completion 的回调里改文件 ——
     * 在调用前改只会让 previous 读到新值，反而证明不了 CAS。
     *
     * 先清掉阶段运行状态：上一步刚成功过，冷却窗口会把这次调用整个挡在
     * 「要不要生成」之前（那是 §12.3 的行为，不是本段要验的东西）。
     */
    extension.__internals.resetStageRuntimes()
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
    /*
     * 失败路径也要 disarm（§12.3）：否则下一轮会在同样的输入上再烧一次调用 ——
     * 模型持续返回坏 JSON 时，这就变成「每轮一次」。
     */
    const rtRejected = extension.__internals.stageRuntimeOf('episode-fold', sessionId)
    ok(rtRejected.armed === false && rtRejected.lastOk === false, 'CAS 拒绝后同样上锁（失败不留在“可立即重试”的状态）')
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

    /*
     * 默认 kinds 现在**含** episode-fold（2026-09-18 用户拍板进默认接管集）。
     * 这里必须**同时**断言分路也跟着开 —— 原先 `policy()` 的 base 把
     * `state.{generate,inject}` 写死成 false，于是「总闸在集合里、分路却关着」，
     * 生成器永远不会跑而界面显示已接管（这正是本次改动撞出来的真缺陷）。
     */
    const saved = process.env.YAN_CONTEXT_POLICY
    delete process.env.YAN_CONTEXT_POLICY
    const p = extension.__internals.policy()
    ok(p.kinds.includes('episode-fold'), '默认接管 episode-fold（2026-09-18 用户拍板）')
    ok(
      p.state.generate === true && p.state.inject === true,
      '默认两条分路都由 kinds 推导为开（不能与总闸矛盾）'
    )
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

  /*
   * ---------------- P2-7：`episode-fold` 的用户开关（扩展侧）----------------
   *
   * 这个开关补的是「进默认接管集后没有关闭入口」的缺口，而它有**两个真源**，
   * 必须同时变：
   *   · 主进程侧 `resolveContextPolicy()` —— 界面读它画“哪些阶段已接管”；
   *   · 扩展侧 `policy()` —— 决定生成器跑不跑、`<TASK_STATE>` 注不注入。
   * 主进程那份钉在 `test-context-policy.mjs`，这里钉扩展侧：三个来源的优先关系，
   * 以及它是否真的把 `kinds` 与 `stateSwitches` **一起**关掉。
   *
   * 为什么要验“一起”：`kinds` 是总闸、`state.generate/inject` 是闸内分路。
   * 只关一头就会出现「总闸说接管了、分路却说关着」（或反过来）—— 那种状态下
   * 界面的阶段预报与真实行为相反，而且不报任何错。
   */
  console.log('\n--- P2-7 · episode-fold 的用户开关（desktop.json / YAN_CONTEXT_FOLD / YAN_CONTEXT_POLICY）---')
  {
    const prevPolicyEnv = process.env.YAN_CONTEXT_POLICY
    const prevFoldEnv = process.env.YAN_CONTEXT_FOLD
    const prevDataDir = process.env.YAN_DATA_DIR
    const restoreEnv = () => {
      if (prevPolicyEnv === undefined) delete process.env.YAN_CONTEXT_POLICY
      else process.env.YAN_CONTEXT_POLICY = prevPolicyEnv
      if (prevFoldEnv === undefined) delete process.env.YAN_CONTEXT_FOLD
      else process.env.YAN_CONTEXT_FOLD = prevFoldEnv
      if (prevDataDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevDataDir
      extension.__internals.resetDesktopSettingsCache()
    }
    const kinds = () => extension.__internals.policy().kinds
    const state = () => extension.__internals.policy().state
    const tmp = mkdtempSync(join(tmpdir(), 'yan-fold-'))
    try {
      delete process.env.YAN_CONTEXT_POLICY
      delete process.env.YAN_CONTEXT_FOLD
      process.env.YAN_DATA_DIR = tmp
      extension.__internals.resetDesktopSettingsCache()

      ok(kinds().includes('episode-fold'), 'fold·三个来源都没表态时按默认开（它是默认接管集的一员）')
      ok(
        state().generate === true && state().inject === true,
        'fold·默认下生成与注入两条分路都是开'
      )

      /* env 通道：`1` / `0` 是明确表态，认不出的值当没表态 */
      process.env.YAN_CONTEXT_FOLD = '1'
      ok(kinds().includes('episode-fold'), 'fold·YAN_CONTEXT_FOLD=1 打开')
      process.env.YAN_CONTEXT_FOLD = 'false'
      ok(!kinds().includes('episode-fold'), 'fold·YAN_CONTEXT_FOLD=false 关闭')
      ok(state().generate === false && state().inject === false, 'fold·关闭时生成与注入一起停')
      process.env.YAN_CONTEXT_FOLD = 'yes'
      ok(kinds().includes('episode-fold'), 'fold·认不出的值当没表态（与 deep 同一条规则）')
      delete process.env.YAN_CONTEXT_FOLD

      /* 桌面端设置：用户真正能按到的那条路（扩展每轮读文件，所以改完立即生效） */
      writeFileSync(join(tmp, 'desktop.json'), JSON.stringify({ contextFold: { enabled: false } }))
      extension.__internals.resetDesktopSettingsCache()
      ok(!kinds().includes('episode-fold'), 'fold·设置里 enabled:false 关掉（界面开关的落实处）')
      ok(
        state().generate === false && state().inject === false,
        'fold·关掉时总闸与两条分路一致（不会留下“总闸说关、分路说开”）'
      )

      writeFileSync(join(tmp, 'desktop.json'), JSON.stringify({ contextFold: { enabled: true } }))
      extension.__internals.resetDesktopSettingsCache()
      ok(kinds().includes('episode-fold'), 'fold·设置里 enabled:true 等于默认（不额外区分“没改过”与“主动打开”）')

      process.env.YAN_CONTEXT_FOLD = '1'
      writeFileSync(join(tmp, 'desktop.json'), JSON.stringify({ contextFold: { enabled: false } }))
      extension.__internals.resetDesktopSettingsCache()
      ok(kinds().includes('episode-fold'), 'fold·env 的 1 盖过设置里的 false（测试通道优先）')

      /*
       * `YAN_CONTEXT_POLICY` 显式给了 `kinds` 时它就是接管集的唯一出处：
       * `contexttakeover` / `contextproduce` 靠它精确控制接管集。
       */
      process.env.YAN_CONTEXT_POLICY = '{"kinds":["tool-sweep","recall","episode-fold","compaction"]}'
      process.env.YAN_CONTEXT_FOLD = '0'
      extension.__internals.resetDesktopSettingsCache()
      ok(kinds().includes('episode-fold'), 'fold·env 显式给了 kinds 时用户开关不生效（测试通道优先）')

      /*
       * 这一条是 live 场景（`contextfoldpref`）依赖的性质：为了验“关掉后不生成”，
       * 场景要先用 `YAN_CONTEXT_POLICY` 把门槛降到 1/1（否则短会话本来就不生成，
       * 关与不关看不出区别），但**不能给 kinds** —— 给了就把被测的开关盖掉了。
       */
      process.env.YAN_CONTEXT_POLICY = '{"state":{"gate":{"minTurns":1,"minTokens":1}}}'
      process.env.YAN_CONTEXT_FOLD = '0'
      ok(!kinds().includes('episode-fold'), 'fold·只降门槛（没给 kinds）时用户开关仍然生效')
      ok(state().generate === false, 'fold·同上：分路也是关的（生成器一次都不会跑）')
      ok(state().minTurns === 1 && state().minTokens === 1, 'fold·门槛参数照旧可配（用户开关不影响它）')
      delete process.env.YAN_CONTEXT_POLICY
      delete process.env.YAN_CONTEXT_FOLD

      writeFileSync(join(tmp, 'desktop.json'), '{ 坏的 JSON')
      extension.__internals.resetDesktopSettingsCache()
      ok(kinds().includes('episode-fold'), 'fold·设置文件坏了当没表态（按默认开）')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      restoreEnv()
    }
  }

  /*
   * ---------------- Episode 扇叠（§12.6，真实落盘）----------------
   *
   * 用户拍板（2026-09-18）：**边界确定 + 先 shadow**。这个切片最需要的证据都在这里：
   *   ① **边界是确定的** —— 窗口来自 `recentTail` 之外 + 上一版 Episode 的终点；
   *   ② **收束不是猜的** —— `unresolved` 非空就一律不扇叠（两次落盘对比）；
   *   ③ **shadow 是真的** —— 默认（`episodeInject` 关）时 Episode 只落盘，
   *      不进 `task.episodeRefs` / `archiveRefs`，而后者会出现在模型可见的注入块里。
   */
  console.log('\n--- Episode 扇叠（§12.6）：窗口 / 收束判据 / shadow ---')
  {
    const { episodeCandidate, mergeEpisodeState, MAX_EPISODES } = producer
    const { episodeWindow } = transform

    /* ---- 纯逻辑：候选解析（unresolved 是收束判据的落点） ---- */
    const good = episodeCandidate({
      objective: '第一段任务',
      outcome: '做完了',
      decisions: [{ decision: '先做 A', reason: '因为 B' }, '直接用 C'],
      constraints: ['不要动迁移', '不要动迁移'],
      filesChanged: [{ path: 'src/a.ts' }, 'src/b.ts', { summary: '没有路径，丢掉' }],
      failedAttempts: ['试过 D，失败'],
      unresolved: [],
      importantRefs: ['ctx://tool/x1', 'ctx://episode/y', 'not-a-ref']
    })
    ok(good && good.decisions.length === 2 && good.decisions[0].reason === '因为 B', 'decisions 接受对象（带 reason）与纯字符串两种写法')
    ok(good.constraints.length === 1, '字符串列表去重')
    ok(good.filesChanged.length === 2 && good.filesChanged[0].path === 'src/a.ts', 'filesChanged 丢掉没 path 的条目')
    ok(good.importantRefs.join(',') === 'ctx://tool/x1', 'importantRefs 只留归档引用（档掉 ctx://episode 与非法串）')
    ok(episodeCandidate({ ...good, unresolved: ['还有一件事'] }) === null, 'unresolved 非空 → 不扇叠')
    ok(episodeCandidate({ objective: '只有目标' }) === null, '缺 outcome → 不扇叠')
    ok(episodeCandidate(null) === null && episodeCandidate('字符串') === null, '形状不对 → 不扇叠（不报错）')

    /* ---- 纯逻辑：窗口边界（确定性） ---- */
    const long = (n) => 'A'.repeat(n)
    const winEntries = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'].map((id, i) => ({
      id,
      message: { role: 'user', content: [{ type: 'text', text: `${id} ${long(i < 4 ? 4000 : 400)}` }] }
    }))
    const win = episodeWindow({
      messages: winEntries.map((e) => e.message),
      entryIds: winEntries.map((e) => e.id),
      recentTail: { target: 400, max: 900 }
    })
    ok(win && win.from === 'q1' && win.to === 'q4', `窗口 = 尾部窗口之外的那一段（${win?.from}→${win?.to}）`)
    ok(win.entryIds.length === 4 && win.tokens > 0, `窗口带条目清单与 token 估算（${win?.entryIds.length} 条 / ${win?.tokens}）`)
    ok(
      episodeWindow({
        messages: winEntries.map((e) => e.message),
        entryIds: winEntries.map((e) => e.id),
        recentTail: { target: 400, max: 900 },
        coveredThrough: 'q4'
      }) === null,
      '已经扇叠到这里 → 不重复（折叠只会向前推进）'
    )
    ok(
      episodeWindow({
        messages: winEntries.map((e) => e.message),
        entryIds: winEntries.map((e) => e.id),
        recentTail: { target: 100000, max: 200000 }
      }) === null,
      '全部还在活跃窗口里 → 没有可扇叠的东西（返回 null，不是空 Episode）'
    )
    ok(episodeWindow({ messages: [], entryIds: ['a'] }) === null, '消息与 entry id 数量不匹配 → 不猜边界')

    /* ---- 纯逻辑：合并（确定性 id / 幂等 / 上限） ---- */
    const wm = { entryCount: 8, lastEntryId: 'q8' }
    const one = mergeEpisodeState({ candidate: good, window: win, previous: [], watermark: wm, now: 1000 })
    ok(one.added && one.id === 'ep-q1--q4', `id 由窗口两端拼成（${one.id}）`)
    ok(one.episodes[0].sourceRange.from === 'q1' && one.episodes[0].watermark.lastEntryId === 'q8', 'sourceRange 与 watermark 都是 schema 必填项')
    const again = mergeEpisodeState({ candidate: good, window: win, previous: one.episodes, watermark: wm, now: 2000 })
    ok(again.episodes.length === 1, '同一段重复归纳只替换自己（不会留下两条几乎一样的）')
    const many = []
    for (let i = 0; i < MAX_EPISODES + 2; i++) {
      const w = { from: `m${i}`, to: `m${i + 1}`, tokens: 10, entryIds: ['x'] }
      const r = mergeEpisodeState({ candidate: good, window: w, previous: many, watermark: wm, now: i })
      many.length = 0
      many.push(...r.episodes)
    }
    ok(many.length === MAX_EPISODES, `超过上限时丢最旧的（${many.length} / ${MAX_EPISODES}）`)
    ok(many[0].id === 'ep-m2--m3', `留下的是最新的那批（首条 ${many[0].id}）`)
    ok(
      mergeEpisodeState({ candidate: null, window: win, previous: [], watermark: wm }).reason === 'not-sealed' &&
        mergeEpisodeState({ candidate: good, window: null, previous: [], watermark: wm }).reason === 'no-window' &&
        mergeEpisodeState({ candidate: good, window: win, previous: [], watermark: null }).reason === 'no-watermark',
      '三种不落盘的理由分开报（可观测，不是静默丢弃）'
    )

    /* ---- 提示词：窗口写进去，边界不让模型猜 ---- */
    const withWin = producer.buildProducerPrompt({ episodeWin: win })
    ok(withWin.includes('<episode_window>') && withWin.includes('from: q1'), '提示词里给出了扇叠窗口的边界')
    ok(/will not be folded/.test(withWin), '明确告知「列在 unresolved 里就不会被扇叠」')
    ok(!producer.buildProducerPrompt({}).includes('<episode_window>'), '没有窗口时不提这件事（不制造噪声）')

    /* ---- 真落盘：收束的一段 / 未收束的一段 / 放行时的引用汇总 ---- */
    const prevPolicyEnv = process.env.YAN_CONTEXT_POLICY
    const prevData = process.env.YAN_DATA_DIR
    const tmp = mkdtempSync(join(tmpdir(), 'yan-episode-'))
    const dir = join(tmp, 'context-state')
    const readState = (sessionId) => {
      try {
        return JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8'))
      } catch {
        return null
      }
    }
    const mkCtx = (sessionId, entries, payload) => ({
      sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => entries },
      model: { provider: 'test', id: 'fake', maxTokens: 4096 },
      modelRegistry: {
        complete: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], stopReason: 'stop' })
      }
    })
    const entriesOf = (prefix) =>
      ['1', '2', '3', '4', '5', '6', '7', '8'].map((n, i) => ({
        id: `${prefix}q${n}`,
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: `${prefix}q${n} ${long(i < 4 ? 4000 : 400)}` }] }
      }))
    try {
      process.env.YAN_DATA_DIR = tmp
      /* 把尾部窗口压小，让前四条落到窗口之外（那就是 Episode 的候选区间） */
      process.env.YAN_CONTEXT_POLICY = '{"recentTail":{"target":400,"max":900},"state":{"episodeGenerate":true}}'
      /* 诊断也写进隔离目录：下面「到底为什么没扇叠」要靠 committed 行里的字段说话 */
      process.env.YAN_CONTEXT_EXT_LOG = join(tmp, 'episode-ext.jsonl')
      extension.__internals.resetStageRuntimes()
      const logRows = () => {
        try {
          return readFileSync(join(tmp, 'episode-ext.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        } catch {
          return []
        }
      }

      const sealed = 'epep0001'
      await extension.__internals.produceAndCommit(
        sealed,
        mkCtx(sealed, entriesOf('a'), {
          objective: '把第一段做完',
          currentPhase: '收尾',
          episode: {
            objective: '第一段任务',
            outcome: '做完了并验证通过',
            decisions: [{ decision: '先做 A', reason: '因为 B 更稳' }],
            constraints: ['不要动迁移'],
            filesChanged: [{ path: 'src/a.ts', summary: '新增函数' }],
            failedAttempts: ['试过 D，失败'],
            unresolved: [],
            importantRefs: ['ctx://tool/aq2']
          }
        })
      )
      const written = readState(sealed)
      const commit = logRows().find((r) => r.hook === 'committed' && r.sessionId === sealed)
      ok(
        commit?.episodes === 1,
        `诊断记下 Episode 已落盘（episodes=${commit?.episodes ?? '无 committed 行'}, reason=${commit?.episodeReason ?? '-'}, window=${commit?.episodeWindow ?? '-'}）`
      )
      ok(
        !!written && written.episodes?.length === 1,
        `收束的一段真的落盘成 Episode（written=${written ? 'ok' : 'null'}, episodes=${written?.episodes?.length ?? '-'}, 跟踪=${commit?.episodes}, dir=${dir}）`
      )
      const ep = written?.episodes?.[0] ?? {}
      ok(ep.id === 'ep-aq1--aq4', `落盘 id 由窗口两端拼成（${ep.id}）`)
      ok(ep.sourceRange?.from === 'aq1' && ep.sourceRange?.to === 'aq4', 'sourceRange 指回**原始**条目（§12.7）')
      ok(!!ep.watermark?.lastEntryId && ep.tokensBefore > 0, 'watermark 与 tokensBefore 都写上了')
      ok((written?.task?.episodeRefs ?? []).length === 0, 'shadow：默认不把 Episode 汇总进 task.episodeRefs')
      ok(!(written?.task?.archiveRefs ?? []).includes('ctx://tool/aq2'), 'shadow：默认不把 Episode 的引用并进 archiveRefs')
      const inspected = schema.inspectContextStateFile(written, {
        knownEntryIds: ['aq1', 'aq2', 'aq3', 'aq4', 'aq5', 'aq6', 'aq7', 'aq8']
      })
      ok(inspected.status === 'ok', `带 Episode 的状态文件过 TS schema（${inspected.status}）`)
      if (inspected.status !== 'ok') console.log('   ', JSON.stringify(inspected.issues?.slice(0, 4)))

      const open = 'epep0002'
      extension.__internals.resetStageRuntimes()
      await extension.__internals.produceAndCommit(
        open,
        mkCtx(open, entriesOf('b'), {
          objective: '第一段还没完',
          currentPhase: '进行中',
          episode: { objective: '第一段任务', outcome: '做了一半', unresolved: ['还有一个测试没过'], importantRefs: [] }
        })
      )
      const openWritten = readState(open)
      ok((openWritten?.episodes ?? []).length === 0, 'unresolved 非空 → 不扇叠（收束判据的落点）')
      ok(openWritten?.task?.task?.objective === '第一段还没完', 'TaskState 照常落盘（不扇叠 ≠ 不更新状态）')

      const allowed = 'epep0003'
      process.env.YAN_CONTEXT_POLICY =
        '{"recentTail":{"target":400,"max":900},"state":{"episodeGenerate":true,"episodeInject":true}}'
      extension.__internals.resetStageRuntimes()
      await extension.__internals.produceAndCommit(
        allowed,
        mkCtx(allowed, entriesOf('c'), {
          objective: '放行',
          currentPhase: '收尾',
          episode: { objective: '第 c 段', outcome: '完成', unresolved: [], importantRefs: ['ctx://tool/cq1'] }
        })
      )
      const allowedWritten = readState(allowed)
      ok((allowedWritten?.episodes ?? []).length === 1, '放行时 Episode 照常落盘')
      ok(
        (allowedWritten?.task?.episodeRefs ?? []).includes('ep-cq1--cq4'),
        `放行后 Episode id 才汇总进 task（${JSON.stringify(allowedWritten?.task?.episodeRefs)}）`
      )
      ok((allowedWritten?.task?.archiveRefs ?? []).includes('ctx://tool/cq1'), '放行后重要引用也并进 archiveRefs')

      /*
       * 生成门默认关（2026-09-18 的实测教训）：
       * 窗口非空时提示词里会多要一个嵌套对象，而实测那会让**整次生成**（含 TaskState）
       * 更容易 `not-json`。所以默认不发这个要求 —— 这条钉住「默认下什么都不变」。
       */
      const gated = 'epep0004'
      process.env.YAN_CONTEXT_POLICY = '{"recentTail":{"target":400,"max":900}}'
      extension.__internals.resetStageRuntimes()
      await extension.__internals.produceAndCommit(
        gated,
        mkCtx(gated, entriesOf('d'), {
          objective: '默认不要求 Episode',
          currentPhase: '收尾',
          episode: { objective: '第 d 段', outcome: '完成', unresolved: [], importantRefs: [] }
        })
      )
      const gatedWritten = readState(gated)
      ok((gatedWritten?.episodes ?? []).length === 0, '生成门默认关：即使模型给了 episode、窗口也非空，也不落盘')
      ok(
        !logRows().some((r) => r.hook === 'episode-window' && r.sessionId === gated),
        '生成门关着时连窗口都不算（不为一个没启用的功能白花计算）'
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      if (prevPolicyEnv === undefined) delete process.env.YAN_CONTEXT_POLICY
      else process.env.YAN_CONTEXT_POLICY = prevPolicyEnv
      if (prevData === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = prevData
      delete process.env.YAN_CONTEXT_EXT_LOG
      extension.__internals.resetStageRuntimes()
    }
  }
}
