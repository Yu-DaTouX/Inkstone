import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function runTurnTimingTests(ok) {
  const { turnTiming } = await import('../out/test/turn-timing.mjs')
  const { groupIntoTurns } = await import('../out/test/turns.mjs')

  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

  console.log('\n--- 11.7 回合计时：整轮 vs 生成速度 ---')

  {
    const r = turnTiming({
      usage: { output: 100 },
      firstTokenAt: 8000,
      startedAt: 8000,
      turnStartedAt: 0,
      endedAt: 10000
    })
    ok(r.elapsedMs === 10000, '整轮用时从 agent 回合起点算（含工具 8s）', `实际 ${r.elapsedMs}`)
    ok(near(r.speed, 50), '生成速度只看首 token 之后那 2 秒（100tok/2s=50）', `实际 ${r.speed}`)
    ok(
      !near(r.speed, 12.5),
      '速度没有把工具等待摊进去（若用回合起点会得到 12.5，属于回归）',
      `实际 ${r.speed}`
    )
  }

  {
    const r = turnTiming({ usage: { output: 40 }, startedAt: 5000, turnStartedAt: 1000, endedAt: 9000 })
    ok(near(r.speed, 10), '没有首 token 时速度退回本条消息流起点（40tok/4s=10）', `实际 ${r.speed}`)
    ok(r.elapsedMs === 8000, '整轮仍按回合起点算', `实际 ${r.elapsedMs}`)
  }

  {
    const noUsage = turnTiming({ turnStartedAt: 0, startedAt: 0, endedAt: 4000 })
    ok(noUsage.speed === undefined, '没有 usage 时不产生速度', `实际 ${noUsage.speed}`)
    ok(noUsage.elapsedMs === 4000, '没有 usage 时整轮用时照常给出（provider 不报 token 也能显示）')

    const zeroOut = turnTiming({ usage: { output: 0 }, firstTokenAt: 0, turnStartedAt: 0, endedAt: 3000 })
    ok(zeroOut.speed === undefined, 'usage.output=0 时同样不给速度（不拿 0 当速率）', `实际 ${zeroOut.speed}`)
    ok(zeroOut.elapsedMs === 3000, 'output=0 不影响整轮用时')
  }

  {
    const r = turnTiming({ usage: { output: 10 }, endedAt: 7000 })
    ok(r.elapsedMs === undefined, '既无回合起点又无流起点时不产生用时（不假装）', `实际 ${r.elapsedMs}`)
    ok(r.speed === undefined, '两种起点都没有时也不产生速度')
  }

  {
    const r = turnTiming({ usage: { output: 10 }, firstTokenAt: 9000, turnStartedAt: 9000, endedAt: 1000 })
    ok(r.elapsedMs === 1, '结束早于起点时整轮用时钳到 1ms（不出现 0 / 负数）', `实际 ${r.elapsedMs}`)
    ok(r.speed === 10 / 0.001, '速度同样以 1ms 为下限', `实际 ${r.speed}`)
  }

  {
    const first = turnTiming({ usage: { output: 0 }, firstTokenAt: 3000, startedAt: 100, turnStartedAt: 0, endedAt: 3500 })
    const afterRetry = turnTiming({ usage: { output: 200 }, firstTokenAt: 6000, startedAt: 5000, turnStartedAt: 0, endedAt: 9000 })
    ok(afterRetry.elapsedMs > first.elapsedMs, '重试后的整轮用时大于上一次尝试的时点', `${first.elapsedMs} → ${afterRetry.elapsedMs}`)
    ok(afterRetry.elapsedMs === 9000, '重试等待留在整轮里（9000ms）')
  }

  {
    const asst = (id, extra) => ({ id, role: 'assistant', text: `回复 ${id}`, ...extra })
    const turns = groupIntoTurns([
      { id: 'u1', role: 'user', text: '跑一下' },
      asst('a1', { toolCalls: [{ id: 't1', name: 'bash', args: {}, status: 'ok' }], elapsedMs: 4200 }),
      asst('a2', { toolCalls: [{ id: 't2', name: 'read', args: {}, status: 'ok' }], elapsedMs: 9100 }),
      asst('a3', { elapsedMs: 13800 })
    ])
    const a = turns[1]
    ok(a?.kind === 'assistant', '三块合成一个助手回合')
    ok(a.elapsedMs === 13800, '回合用时取最后一条（= 整轮，不是某一条的生成时间）', `实际 ${a.elapsedMs}`)
  }

  {
    const turns = groupIntoTurns([
      { id: 'r-u1', role: 'user', text: '跑一下', timestamp: 1 },
      { id: 'r-a1', role: 'assistant', text: '第一条', timestamp: 2 },
      {
        id: 'r-a2',
        role: 'assistant',
        text: '第二条',
        timestamp: 3,
        turnTiming: {
          logicalTurnId: 'r-a1',
          startedAt: 1000,
          endedAt: 51000,
          elapsedMs: 50000,
          terminalReason: 'completed'
        }
      }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === 50000, '重载后从宿主元数据恢复整轮用时', `实际 ${t?.elapsedMs}`)
    ok(t?.timingRecorded === true, '标记「这一轮有记录」')
    ok(t?.terminalReason === 'completed', '终止原因跟着恢复', t?.terminalReason)
  }

  {
    const turns = groupIntoTurns([
      { id: 'o-u1', role: 'user', text: '旧会话', timestamp: 1 },
      { id: 'o-a1', role: 'assistant', text: '回答', timestamp: 2 }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === undefined, '旧历史没有用时就是没有（不拿时间戳差冒充）')
    ok(t?.timingRecorded !== true, '旧历史不标记为「有记录」（界面据此说未记录）')
  }

  {
    const turns = groupIntoTurns([
      { id: 'p-u1', role: 'user', text: 'x', timestamp: 1 },
      {
        id: 'p-a1',
        role: 'assistant',
        text: 'y',
        timestamp: 2,
        elapsedMs: 1234,
        turnTiming: {
          logicalTurnId: 'p-a1',
          startedAt: 1,
          endedAt: 2,
          elapsedMs: 9999,
          terminalReason: 'stopped'
        }
      }
    ])
    const t = turns.find((x) => x.kind === 'assistant')
    ok(t?.elapsedMs === 1234, '推送来的本轮用时优先于日志值', `实际 ${t?.elapsedMs}`)
    ok(t?.terminalReason === 'stopped', '终止原因仍取日志（推送不带它）', t?.terminalReason)
  }
}

export async function runTurnTimingStoreTests(ok) {
  const mod = await import('../out/test/turn-timing-store.mjs')
  const {
    appendTurnTiming,
    readTurnTimings,
    applyTurnTimings,
    effectiveTerminalReason,
    sanitizeSessionId,
    turnTimingFile,
    TURN_TIMING_VERSION
  } = mod

  console.log('\n--- 11.9 回合计时元数据：落盘 / 去重 / 挂点 ---')

  const dir = await mkdtemp(join(tmpdir(), 'yan-turntiming-'))
  const sessionId = 'sess-abc.123'

  ok(sanitizeSessionId('a/b\\c') === 'a_b_c', '路径分隔符被换成下划线（不给出目录的口子）', sanitizeSessionId('a/b\\c'))
  ok(sanitizeSessionId('..') === '..', '纯点号保留（不是路径片段）', sanitizeSessionId('..'))
  ok(sanitizeSessionId('a..b/c') === 'a..b_c', '含点的正常 id 保持可读', sanitizeSessionId('a..b/c'))
  ok(sanitizeSessionId('') === 'unknown', '空 id 回落到 unknown', sanitizeSessionId(''))
  ok(
    turnTimingFile(dir, '../../etc/passwd').startsWith(join(dir, 'turn-timing')),
    '恶意 id 不会让文件写到目录外'
  )

  const record = {
    v: TURN_TIMING_VERSION,
    logicalTurnId: 'm-1',
    startedAt: 1000,
    endedAt: 51000,
    elapsedMs: 50000,
    terminalReason: 'completed',
    sourceIds: ['m-1', 'm-2', 'm-3'],
    monotonicMs: 50000
  }
  ok(await appendTurnTiming(dir, sessionId, record), '第一条记录写入成功')
  const back = await readTurnTimings(dir, sessionId)
  ok(back.length === 1, '读回一条记录', `实际 ${back.length}`)
  ok(back[0]?.elapsedMs === 50000, '用时原样读回', `实际 ${back[0]?.elapsedMs}`)
  ok(back[0]?.sourceIds.join(',') === 'm-1,m-2,m-3', '归属消息 id 顺序保留', back[0]?.sourceIds.join(','))

  await appendTurnTiming(dir, sessionId, { ...record, terminalReason: 'stopped', elapsedMs: 12000 })
  const dedup = await readTurnTimings(dir, sessionId)
  ok(dedup.length === 1, '同一回合重写不会变成两个回合', `实际 ${dedup.length}`)
  ok(dedup[0]?.terminalReason === 'stopped', '以后写入的终止原因为准', dedup[0]?.terminalReason)
  ok(dedup[0]?.elapsedMs === 12000, '用时也取后写入的值', `实际 ${dedup[0]?.elapsedMs}`)

  await appendTurnTiming(dir, 'other-sess', { ...record, logicalTurnId: 'o-1', elapsedMs: 7000 })
  const other = await readTurnTimings(dir, 'other-sess')
  ok(other.length === 1 && other[0].elapsedMs === 7000, '另一个会话的记录不会串线', `${other.length}/${other[0]?.elapsedMs}`)
  ok((await readTurnTimings(dir, 'nobody')).length === 0, '没有记录的会话返回空数组（不是报错）')

  const badFile = join(dir, 'turn-timing', `${sanitizeSessionId('bad')}.jsonl`)
  await mkdir(join(dir, 'turn-timing'), { recursive: true })
  await writeFile(
    badFile,
    [
      'not json at all',
      JSON.stringify({ ...record, v: 999, logicalTurnId: 'future' }),
      JSON.stringify({ ...record, v: TURN_TIMING_VERSION, logicalTurnId: 'ok-1', elapsedMs: 3000, sourceIds: ['x-1'] }),
      JSON.stringify({ ...record, v: TURN_TIMING_VERSION, logicalTurnId: '' }),
      JSON.stringify({ ...record, v: TURN_TIMING_VERSION, logicalTurnId: 'bad-reason', terminalReason: '???' }),
      ''
    ].join('\n'),
    'utf8'
  )
  const survived = await readTurnTimings(dir, 'bad')
  ok(survived.length === 1 && survived[0].logicalTurnId === 'ok-1', '脏行 / 未知版本 / 非法字段被跳过，正常行仍读得到', `实际 ${survived.length}`)

  const messages = [
    { id: 'm0', role: 'user', text: '问' },
    { id: 'a-tmp-1', role: 'assistant', text: 'a' },
    { id: 'a-tmp-2', role: 'assistant', text: 'b' },
    { id: 'm1', role: 'user', text: '又问' },
    { id: 'a-other', role: 'assistant', text: 'c' }
  ]
  const applied = applyTurnTimings(messages, [{ ...record, anchorId: 'm0' }])
  ok(applied[2]?.turnTiming?.elapsedMs === 50000, '挂在锚定用户消息之后的最后一条助手消息上', applied[2]?.id)
  ok(applied[1]?.turnTiming === undefined && applied[4]?.turnTiming === undefined, '别的回合不被污染')
  ok(messages[2].turnTiming === undefined, '原数组对象不被修改（返回新数组）')

  const fallback = applyTurnTimings(
    [
      { id: 'm-1', role: 'assistant' },
      { id: 'z', role: 'user' }
    ],
    [{ ...record, anchorId: 'm-gone' }]
  )
  ok(fallback[0]?.turnTiming?.elapsedMs === 50000, '锚不在时回退到 sourceIds 里仍在的那条')
  const orphan = applyTurnTimings([{ id: 'nobody', role: 'assistant' }], [
    { ...record, anchorId: 'm-gone' }
  ])
  ok(orphan[0]?.turnTiming === undefined, '一条都对不上时不挂（宁可不显示，也不挂错回合）')

  {
    ok(
      effectiveTerminalReason({ ...record, final: false }) === 'interrupted',
      '中途快照（final: false）→ 报「被中断」'
    )
    ok(
      effectiveTerminalReason({ ...record, final: true }) === record.terminalReason,
      '已收尾（final: true）→ 用记录自己的终止原因'
    )
    ok(
      effectiveTerminalReason({ ...record, final: undefined }) === record.terminalReason,
      '旧记录没有 final 字段 → 不误报中断（宁可把中断写成完成）'
    )

    const crashSession = 'crash-sess'
    await appendTurnTiming(dir, crashSession, {
      ...record,
      v: TURN_TIMING_VERSION,
      logicalTurnId: 'a-mid',
      anchorId: 'm0',
      anchorId: 'm0',
      elapsedMs: 3000,
      terminalReason: 'completed',
      final: false
    })
    const onlyMid = await readTurnTimings(dir, crashSession)
    ok(onlyMid.length === 1 && onlyMid[0].final === false, '中途快照的 final 字段能读回')
    const crashMsgs = [
      { id: 'm0', role: 'user' },
      { id: 'a1', role: 'assistant' }
    ]
    ok(
      applyTurnTimings(crashMsgs, onlyMid)[1]?.turnTiming?.terminalReason === 'interrupted',
      '盘上只剩中途快照时，挂回的消息就是「中断」（强杀后的真实写照）'
    )

    await appendTurnTiming(dir, crashSession, {
      ...record,
      v: TURN_TIMING_VERSION,
      logicalTurnId: 'a-mid',
      anchorId: 'm0',
      elapsedMs: 9000,
      terminalReason: 'stopped',
      final: true
    })
    const settled = await readTurnTimings(dir, crashSession)
    ok(settled.length === 1 && settled[0].final === true, '后来正常收尾的同回合记录覆盖中途快照')
    ok(
      applyTurnTimings(crashMsgs, settled)[1]?.turnTiming?.terminalReason === 'stopped',
      '正常收尾后不再报中断（不能把已结束的回合误报成崩溃）'
    )
  }

  {
    const s = 'sess-runs'
    const base = {
      v: TURN_TIMING_VERSION,
      anchorId: 'm0',
      startedAt: 1000,
      endedAt: 4000,
      elapsedMs: 3000,
      terminalReason: 'completed',
      sourceIds: ['a1'],
      waitSpans: [{ id: 't1', name: 'bash', startedAt: 1200, endedAt: 2200 }]
    }
    await appendTurnTiming(dir, s, { ...base, logicalTurnId: 'm0', runId: 'run-1', final: false })
    await appendTurnTiming(dir, s, {
      ...base,
      logicalTurnId: 'm0',
      runId: 'run-1',
      elapsedMs: 3200,
      endedAt: 4200,
      final: true
    })
    const same = await readTurnTimings(dir, s)
    ok(same.length === 1, '同一逻辑回合只出一条记录', String(same.length))
    ok(same[0].elapsedMs === 3200, '同一 run 的收尾覆盖中途快照（不累加）', String(same[0].elapsedMs))
    ok(same[0].final === true, '快照的 final 取收尾那条')

    await appendTurnTiming(dir, s, {
      ...base,
      logicalTurnId: 'm0',
      runId: 'run-2',
      final: true,
      startedAt: 9000,
      endedAt: 11000,
      elapsedMs: 2000,
      sourceIds: ['a2'],
      waitSpans: [{ id: 't2', name: 'read', startedAt: 9200, endedAt: 9800 }]
    })
    const merged = await readTurnTimings(dir, s)
    ok(merged.length === 1, '自动继续归同一个逻辑回合（不另起一条）', String(merged.length))
    ok(merged[0].elapsedMs === 5200, '自动继续的用时相加（3200 + 2000）', String(merged[0].elapsedMs))
    ok(merged[0].sourceIds.join('|') === 'a1|a2', 'sourceIds 合并去重', merged[0].sourceIds.join('|'))
    ok(merged[0].startedAt === 1000 && merged[0].endedAt === 11000, 'startedAt 取最早、endedAt 取最晚')
    ok((merged[0].waitSpans ?? []).length === 2, 'waitSpans 合并（两段工作各一条）')

    const legacy = 'sess-legacy'
    await appendTurnTiming(dir, legacy, { ...base, logicalTurnId: 'a-old', elapsedMs: 1000 })
    await appendTurnTiming(dir, legacy, { ...base, logicalTurnId: 'a-old', elapsedMs: 2000 })
    const old = await readTurnTimings(dir, legacy)
    ok(
      old.length === 1 && old[0].elapsedMs === 2000,
      '旧记录（无 runId）保持后者胜，不把历史翻倍',
      String(old[0].elapsedMs)
    )
  }

  {
    const ttDir = await mkdtemp(join(tmpdir(), 'yan-tt-tokens-'))
    const base = {
      v: TURN_TIMING_VERSION,
      logicalTurnId: 'm-1',
      startedAt: 1000,
      endedAt: 2000,
      elapsedMs: 1000,
      terminalReason: 'completed',
      sourceIds: ['m-1']
    }
    ok(await appendTurnTiming(ttDir, 'tok', { ...base, runId: 'r1', outputTokens: 120 }), '带 token 的记录写入成功')
    ok(await appendTurnTiming(ttDir, 'tok', { ...base, runId: 'r2', outputTokens: 80 }), '第二个 run 写入成功')
    ok(await appendTurnTiming(ttDir, 'tok', { ...base, runId: 'r3', startedAt: 3000, endedAt: 4000 }), '第三个 run 没报 token')
    const back2 = await readTurnTimings(ttDir, 'tok')
    ok(back2.length === 1, '三个 run 合成一个逻辑回合', `实际 ${back2.length}`)
    ok(
      back2[0]?.outputTokens === 200,
      '跨 run 的 output token **相加**（目标预算要的是整回合）',
      String(back2[0]?.outputTokens)
    )

    ok(await appendTurnTiming(ttDir, 'dup', { ...base, runId: 'r1', outputTokens: 50 }), '中途快照写入')
    ok(await appendTurnTiming(ttDir, 'dup', { ...base, runId: 'r1', outputTokens: 150 }), '终止快照写入')
    const dup = await readTurnTimings(ttDir, 'dup')
    ok(dup.length === 1 && dup[0].outputTokens === 150, '同一 run 只算最后一次（累积值不相加）', String(dup[0]?.outputTokens))

    ok(await appendTurnTiming(ttDir, 'none', { ...base, runId: 'r1' }), '无 token 记录写入')
    const none = await readTurnTimings(ttDir, 'none')
    ok(none[0]?.outputTokens === undefined, '一条都没报时是 undefined（界面显示未知，不当 0）')

    ok(await appendTurnTiming(ttDir, 'dirty', { ...base, runId: 'r1', outputTokens: -5 }), '脏值写入（负）')
    const dirty = await readTurnTimings(ttDir, 'dirty')
    ok(dirty[0]?.outputTokens === undefined, '负 token 被丢掉')

    await rm(ttDir, { recursive: true, force: true })
  }

  {
    const s = 'sess-entry-anchor'
    ok(
      await appendTurnTiming(dir, s, {
        v: TURN_TIMING_VERSION,
        logicalTurnId: 'm5',
        anchorId: 'm5',
        anchorEntryId: 'entry-root',
        startedAt: 1000,
        endedAt: 4000,
        elapsedMs: 3000,
        terminalReason: 'completed',
        sourceIds: ['a-old']
      }),
      '带入口 id 的记录写入成功'
    )
    const records = await readTurnTimings(dir, s)
    ok(records[0]?.anchorEntryId === 'entry-root', '入口 id 能读回（不依赖投影序号）')
    const shifted = [
      { id: 'm0', entryId: 'entry-prefix', role: 'user' },
      { id: 'm1', entryId: 'entry-root', role: 'user' },
      { id: 'm2', entryId: 'entry-a1', role: 'assistant' },
      { id: 'm3', entryId: 'entry-u2', role: 'user' }
    ]
    ok(
      applyTurnTimings(shifted, records)[2]?.turnTiming?.elapsedMs === 3000,
      '前面插入一条消息后，计时按入口 id 仍落在原回合'
    )
    ok(applyTurnTimings(shifted, records)[3]?.turnTiming === undefined, '下一个回合不被误挂上上一轮的计时')
    const legacyById = [{ id: 'm5', role: 'user' }, { id: 'm9', role: 'assistant' }]
    ok(
      applyTurnTimings(legacyById, records)[1]?.turnTiming?.elapsedMs === 3000,
      '没有入口 id 的消息仍按投影 id 定位（旧行为不变）'
    )
  }

  await rm(dir, { recursive: true, force: true })
}

