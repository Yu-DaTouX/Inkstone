/**
 * 切片安全规则（`resources/pi-extensions/context-safety.js`）的单测 —— N21-10。
 *
 * 为什么值得钉住：这三条规则（正在用的 diff 不得删 / 用户约束不得降级 / 不从 reasoning 中间切）
 * 在真实会话里坏了只会表现为"模型好像忘了要求""它把我刚改的地方改回去了"，
 * 没法从日志里看出是**压缩压坏了**。所以把规则做成纯函数，用构造的输入断言：
 *   · 三组输入（正在使用的 diff + 已解决的旧错误 + 用户约束）各自的处置对不对；
 *   · `violations()` 对**人为做坏的**切片方案必须报错（否则它只是个沉默的摆设）。
 *
 * 输入形状按 `src/main/normalize.ts` 里的真实对应关系构造：assistant 上的 `toolCalls`
 * 与后面 `role:'tool'` + `toolCallId` 的结果成对。**注意没有把 system 放进会话主体**
 * —— pi 的 messages 里 system 提示是单独通道，注入型 system 也在末尾（如语言扩展）。
 *
 * 用法：进 `npm run test:unit`（在 `scripts/test-unit.mjs` 里 import 本文件）。
 */

const entry = (entryId, role, extra = {}) => ({ entryId, role, ...extra })

/** 一段典型会话尾巴：两轮对话 + 一次工具调用（result 是大块输出） */
function session() {
  return [
    entry('u1', 'user', { tokens: 40 }),
    entry('a1', 'assistant', { tokens: 120, toolCalls: ['c1'] }),
    entry('t1', 'tool', { tokens: 8000, toolCallId: 'c1', paths: ['src/main/agent.ts'] }),
    entry('u2', 'user', { tokens: 30 }),
    entry('a2', 'assistant', { tokens: 200 }),
    entry('u3', 'user', { tokens: 25 }),
    entry('a3', 'assistant', { tokens: 180 })
  ]
}

export function runContextSafetyTests(ok, mod) {
  const {
    atomicUnits, planTailCut, carryOver, routeEntries, sweepCandidates,
    violations, routingViolations
  } = mod

  /* ---------- A. 原子上下文单元（§12.4） ---------- */

  const units = atomicUnits(session())
  const turn1 = units.find((u) => u.entryIds.includes('u1'))
  ok(
    turn1 && ['t1', 'a1', 'u1'].every((id) => turn1.entryIds.includes(id)),
    'user 回合把 assistant 与它的 tool 结果都包进同一个单元',
    JSON.stringify(turn1)
  )
  ok(units.length === 3, '按 user 边界切成三个回合单元', JSON.stringify(units.map((u) => u.entryIds)))

  const orphan = atomicUnits([entry('t9', 'tool', { toolCallId: 'cX', tokens: 10 })])
  ok(orphan.length === 1 && orphan[0].kind === 'orphan-tool', '找不到调用的 tool 结果自成 orphan 单元（不擅自丢）', JSON.stringify(orphan))

  const bash = atomicUnits([entry('b1', 'bash', { tokens: 5 }), entry('b2', 'bash', { tokens: 5 })])
  ok(bash.length === 2 && bash.every((u) => u.kind === 'bash'), 'RPC 直执行的 bash 命令各自成单元（命令与输出不分离）', JSON.stringify(bash))

  const sys = atomicUnits([entry('s1', 'system', {}), entry('s2', 'system', {}), entry('u1', 'user', {})])
  ok(sys.length === 2 && sys[0].entryIds.length === 2, '连续的 system 合成一个单元', JSON.stringify(sys))

  /* ---------- B. 切割：只在单元边界、超 max 也不硬截 ---------- */

  const all = session()
  const cut = planTailCut(all, { target: 400, max: 600 })
  ok(violations(cut, all, {}).length === 0, '默认切割结果合法（无违规）', JSON.stringify(violations(cut, all, {})))
  ok(cut.keptTokens >= 400 || cut.keptEntryIds.length === all.length, '累加到 ≥ target 才停（或已经装下全部）', `${cut.keptTokens} / target 400`)
  ok(cut.overMax === (cut.keptTokens > 600), 'overMax 如实反映是否超出 max', `kept=${cut.keptTokens} overMax=${cut.overMax}`)
  ok(!cut.keptEntryIds.includes('u1') && cut.droppedEntryIds.includes('u1'), '够长时确实把最老的回合切了出去（不是"什么都不切"）', cut.droppedEntryIds.join())

  /* 配对：把 target 卡在 assistant(call) 与 tool(result) 之间（t1 是 8000 token 的大结果） */
  const pairCut = planTailCut(all, { target: 8200, max: 8200 })
  const keptCall = pairCut.keptEntryIds.includes('a1')
  const keptResult = pairCut.keptEntryIds.includes('t1')
  ok(keptCall === keptResult, 'tool 调用与结果不会被切开（要么都在保留区，要么都丢掉）', `call=${keptCall} result=${keptResult}`)

  const small = planTailCut(all, { target: 10, max: 10 })
  ok(small.boundaryEntryId === 'u3', 'max 很小也只在回合边界切（不硬截半条）', String(small.boundaryEntryId))

  /* system 契约若落在切片区：**拒绝推进**（保守正确），调用方应先在装配层重新发出它 */
  const withContract = [entry('s1', 'system', { tokens: 900, protect: ['system-contract'] }), ...session()]
  const ctCut = planTailCut(withContract, { target: 100, max: 100 })
  ok(ctCut.keptEntryIds.includes('s1') && ctCut.keptEntryIds.length === withContract.length, '契约在切片区里时切割退到它之前（宁可不切，也不悄悄丢契约）', ctCut.keptEntryIds.join())
  ok(ctCut.rescued.some((r) => r.entryId === 's1'), '并记下原因', JSON.stringify(ctCut.rescued))
  ok(violations(ctCut, withContract, {}).length === 0, '这种保守结果本身是合法的', JSON.stringify(violations(ctCut, withContract, {})))

  /* ---------- C. 规则 ①：正在使用的 diff 不得删 ---------- */

  const diff = [
    entry('u1', 'user', { tokens: 200 }),
    entry('a1', 'assistant', { tokens: 30 }),
    entry('u2', 'user', { tokens: 200 }),
    entry('a2', 'assistant', { tokens: 30, toolCalls: ['c1'] }),
    entry('t1', 'tool', { tokens: 9000, toolCallId: 'c1', paths: ['src/main/agent.ts'] }),
    entry('u3', 'user', { tokens: 200 }),
    entry('a3', 'assistant', { tokens: 30 })
  ]
  const diffCut = planTailCut(diff, { target: 100, max: 100 }, { activePaths: ['src/main/agent.ts'] })
  ok(diffCut.keptEntryIds.includes('t1'), '正在使用的 diff（工具结果）被拉回保留区', diffCut.keptEntryIds.join())
  ok(diffCut.droppedEntryIds.includes('u1'), '拉回只到它所在的回合为止，前面的仍然可以切', diffCut.droppedEntryIds.join())
  ok(diffCut.rescued.some((r) => r.entryId === 't1'), 'rescued 里记下了"为什么它被留下"', JSON.stringify(diffCut.rescued))
  ok(
    violations(diffCut, diff, { activePaths: ['src/main/agent.ts'] }).length === 0,
    '按 activePaths 复查：没有"正在使用的 diff 被回收"',
    JSON.stringify(violations(diffCut, diff, { activePaths: ['src/main/agent.ts'] }))
  )

  const swept = sweepCandidates(diff, { activePaths: ['src/main/agent.ts'], minTokens: 1000 })
  ok(!swept.candidates.some((c) => c.entryId === 't1'), '清扫不动正在使用的 diff', JSON.stringify(swept.candidates))
  ok(swept.skipped.some((s) => s.entryId === 't1' && s.reason.includes('正在使用')), '跳过时给出原因（"正在使用的 diff，不得删除"）', JSON.stringify(swept.skipped))

  const routed = routeEntries(diff, { activePaths: ['src/main/agent.ts'] })
  ok(routed.activeDiff.includes('t1') && !routed.history.includes('t1'), '路由把它放进 activeDiff 桶，不进 history', JSON.stringify(routed))

  /* 没有 activePaths 时它只是普通大输出 → 可以清扫（说明保护来自"在用"，不是"是 tool"） */
  const plainSwept = sweepCandidates(diff, { minTokens: 1000 })
  ok(plainSwept.candidates.some((c) => c.entryId === 't1'), '不在用的大输出仍可进清扫候选', JSON.stringify(plainSwept.candidates))

  /* ---------- D. 规则 ②：用户约束不得降级 ---------- */

  const constrained = [
    entry('u1', 'user', { tokens: 20, protect: ['user-constraint'] }),
    entry('u2', 'user', { tokens: 5000 }),
    entry('u3', 'user', { tokens: 5000 }),
    entry('a3', 'assistant', { tokens: 30 })
  ]
  const cCut = planTailCut(constrained, { target: 100, max: 100 })
  ok(!cCut.keptEntryIds.includes('u1'), '约束**允许**离开原始窗口（否则永远压不动）', cCut.keptEntryIds.join())
  const carried = carryOver(constrained, cCut)
  ok(carried.constraints.includes('u1'), '被切掉的约束出现在 carryOver().constraints（状态层必须带走）', JSON.stringify(carried))
  ok(violations(cCut, constrained, { carriedIds: carried.constraints }).length === 0, '带走之后没有违规', JSON.stringify(violations(cCut, constrained, { carriedIds: carried.constraints })))
  ok(
    violations(cCut, constrained, {}).some((v) => v.includes('既没留在窗口、也没被状态带走')),
    '**忘记带走**必须被指出来（规则 ② 的守门是真的在工作）',
    JSON.stringify(violations(cCut, constrained, {}))
  )

  const cRouted = routeEntries(constrained, {})
  ok(cRouted.constraints.includes('u1') && !cRouted.history.includes('u1'), '约束只进 constraints 桶，不进 history（不降级成背景信息）', JSON.stringify(cRouted))
  ok(routingViolations(cRouted, constrained).length === 0, '路由复查无违规', JSON.stringify(routingViolations(cRouted, constrained)))
  const badRouted = { ...cRouted, constraints: [], history: ['u1'] }
  ok(routingViolations(badRouted, constrained).some((v) => v.includes('降级')), '把约束塞进 history 会被 routingViolations 抓到', JSON.stringify(routingViolations(badRouted, constrained)))

  /* 已解决的旧错误可以压；未解决的必须带走 */
  const errors = [
    entry('u1', 'user', { tokens: 20 }),
    entry('a1', 'assistant', { tokens: 30, toolCalls: ['c1'] }),
    entry('t1', 'tool', { tokens: 3000, toolCallId: 'c1', isError: true, resolved: true }),
    entry('u2', 'user', { tokens: 2000 }),
    entry('a2', 'assistant', { tokens: 20 })
  ]
  const eCut = planTailCut(errors, { target: 100, max: 100 })
  const eCarry = carryOver(errors, eCut)
  ok(eCarry.unresolved.length === 0, '**已解决**的旧错误不进"必须带走"清单（它本来就该被压掉）', JSON.stringify(eCarry))
  const eRouted = routeEntries(errors, {})
  ok(eRouted.history.includes('t1') && !eRouted.unresolved.includes('t1'), '已解决的错误路由进 history（可回收）', JSON.stringify(eRouted))

  const unresolved = errors.map((e) => (e.entryId === 't1' ? { ...e, resolved: false } : e))
  const uCarry = carryOver(unresolved, planTailCut(unresolved, { target: 100, max: 100 }))
  ok(uCarry.unresolved.includes('t1'), '未解决的错误被切掉时必须由状态带走（§12.6）', JSON.stringify(uCarry))
  const uSwept = sweepCandidates(unresolved, { minTokens: 1000 })
  ok(
    !uSwept.candidates.some((c) => c.entryId === 't1') && uSwept.skipped.some((s) => s.entryId === 't1' && s.reason.includes('未解决')),
    '清扫不动未解决的错误',
    JSON.stringify(uSwept)
  )

  /* ---------- E. 规则 ③：不从 assistant reasoning / output 中间切 ---------- */

  const reasoning = [
    entry('u1', 'user', { tokens: 20 }),
    entry('a1', 'assistant', { tokens: 12000 }),
    entry('u2', 'user', { tokens: 20 })
  ]
  const rSwept = sweepCandidates(reasoning, { minTokens: 100 })
  ok(!rSwept.candidates.some((c) => c.entryId === 'a1'), 'assistant 的推理/正文不进清扫候选', JSON.stringify(rSwept.candidates))
  ok(rSwept.skipped.some((s) => s.entryId === 'a1' && s.reason.includes('不得从中间切割')), '跳过 assistant 时说明原因', JSON.stringify(rSwept.skipped))
  const rCut = planTailCut(reasoning, { target: 100, max: 100 })
  const rKept = rCut.keptEntryIds.includes('a1')
  ok(rKept || rCut.droppedEntryIds.includes('a1'), 'assistant 条目整条保留或整条丢弃', `kept=${rKept}`)
  ok(!(rKept && rCut.droppedEntryIds.includes('a1')), '同一条不会既保留又丢弃', JSON.stringify(rCut.keptEntryIds))
  ok(violations(rCut, reasoning, {}).length === 0, '大 assistant 条目的切割方案合法', JSON.stringify(violations(rCut, reasoning, {})))

  /* ---------- F. 反向断言：做坏的方案必须被指出来 ---------- */

  const good = planTailCut(session(), { target: 400, max: 600 })
  const split = {
    keptEntryIds: [...good.keptEntryIds, 'a1'],
    droppedEntryIds: good.droppedEntryIds.filter((id) => id !== 'a1')
  }
  ok(
    violations(split, all, {}).some((v) => v.includes('单元被切开') || v.includes('tool 调用与结果被分开')),
    '人为切成"半条"会被 violations 抓到',
    JSON.stringify(violations(split, all, {}))
  )

  const contract = [entry('s1', 'system', { tokens: 900, protect: ['system-contract'] }), ...session()]
  const noSystem = {
    ...good,
    keptEntryIds: good.keptEntryIds.filter((id) => id !== 's1'),
    droppedEntryIds: [...good.droppedEntryIds, 's1']
  }
  ok(violations(noSystem, contract, {}).some((v) => v.includes('系统提示/契约被回收')), '把系统提示回收掉会被 violations 抓到', JSON.stringify(violations(noSystem, contract, {})))

  const notComplement = { keptEntryIds: good.keptEntryIds, droppedEntryIds: [] }
  ok(violations(notComplement, all, {}).some((v) => v.includes('既没保留也没丢弃')), '保留/丢弃不互补会被 violations 抓到', JSON.stringify(violations(notComplement, all, {})))

  const emptyPlan = planTailCut([], { target: 100, max: 100 })
  ok(emptyPlan.keptEntryIds.length === 0 && violations(emptyPlan, [], {}).length === 0, '空输入不炸、也不算违规', JSON.stringify(emptyPlan))
}
