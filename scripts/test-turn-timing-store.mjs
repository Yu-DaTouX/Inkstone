/**
 * 回合计时元数据存储的纯逻辑测试（实施-11 H-6）。
 *
 * 被测对象：`src/main/turn-timing-store.ts`。它解决的是「pi 的会话 JSONL 不存
 * `elapsedMs`，所以切会话 / 重载后整轮用时丢失」——把宿主算出来的整轮结果留一份，
 * 读历史时挂回对应消息。
 *
 * 为什么必须单测：
 *   · 挂点错了不会报错，只会让**别的回合**显示这一轮的用时（比不显示更坏）；
 *   · 会话 id 直接进文件名，白名单是安全边界，不能靠运气；
 *   · 日志是只追加的，一条脏行不能把整个会话的用时全弄没。
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

  /* ---- 1. 会话 id 进文件名前的白名单 ---- */
  ok(sanitizeSessionId('a/b\\c') === 'a_b_c', '路径分隔符被换成下划线（不给出目录的口子）', sanitizeSessionId('a/b\\c'))
  ok(sanitizeSessionId('..') === '..', '纯点号保留（不是路径片段）', sanitizeSessionId('..'))
  ok(sanitizeSessionId('a..b/c') === 'a..b_c', '含点的正常 id 保持可读', sanitizeSessionId('a..b/c'))
  ok(sanitizeSessionId('') === 'unknown', '空 id 回落到 unknown', sanitizeSessionId(''))
  ok(
    turnTimingFile(dir, '../../etc/passwd').startsWith(join(dir, 'turn-timing')),
    '恶意 id 不会让文件写到目录外'
  )

  /* ---- 2. 往返 ---- */
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

  /* ---- 3. 同一 logicalTurnId 写两次：后者胜（终止原因会变） ---- */
  await appendTurnTiming(dir, sessionId, { ...record, terminalReason: 'stopped', elapsedMs: 12000 })
  const dedup = await readTurnTimings(dir, sessionId)
  ok(dedup.length === 1, '同一回合重写不会变成两个回合', `实际 ${dedup.length}`)
  ok(dedup[0]?.terminalReason === 'stopped', '以后写入的终止原因为准', dedup[0]?.terminalReason)
  ok(dedup[0]?.elapsedMs === 12000, '用时也取后写入的值', `实际 ${dedup[0]?.elapsedMs}`)

  /* ---- 4. 每个会话各读自己那份 ---- */
  await appendTurnTiming(dir, 'other-sess', { ...record, logicalTurnId: 'o-1', elapsedMs: 7000 })
  const other = await readTurnTimings(dir, 'other-sess')
  ok(other.length === 1 && other[0].elapsedMs === 7000, '另一个会话的记录不会串线', `${other.length}/${other[0]?.elapsedMs}`)
  ok((await readTurnTimings(dir, 'nobody')).length === 0, '没有记录的会话返回空数组（不是报错）')

  /* ---- 5. 坏行 / 未知版本跳过 ---- */
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

  /* ---- 6. 挂点：锚定的用户消息之后、这一轮的最后一条助手消息 ---- */
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

  /* ---- 7. 锚丢失时回退；全丢就不挂 ---- */
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

  /* ---- 7.5 H-6b：飞行中被拿掉的那一轮 = 中断 ---- */
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

    /* 真写一遍：中途快照 + 正常收尾写在同一回合上，后者胜 */
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

  /* ---- H-6b：runId 决定「覆盖」还是「累加」 ---- */
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
    /* 同一 run：中途快照 + 收尾 → 后者胜，**不累加** */
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

    /* 不同 run（自动继续）：同一 anchor → 归一个逻辑回合、用时相加 */
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

    /* 旧记录（没有 runId）保持「后者胜」，不把历史翻倍 */
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

  /* ---- 8. output token 落盘与跨 run 聚合（实施-15 A-2） ---- */
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

    /* 同一 run 的两次快照：累积值，后者胜（不相加） */
    ok(await appendTurnTiming(ttDir, 'dup', { ...base, runId: 'r1', outputTokens: 50 }), '中途快照写入')
    ok(await appendTurnTiming(ttDir, 'dup', { ...base, runId: 'r1', outputTokens: 150 }), '终止快照写入')
    const dup = await readTurnTimings(ttDir, 'dup')
    ok(dup.length === 1 && dup[0].outputTokens === 150, '同一 run 只算最后一次（累积值不相加）', String(dup[0]?.outputTokens))

    /* 一条都没报 → undefined（未知），不是 0 */
    ok(await appendTurnTiming(ttDir, 'none', { ...base, runId: 'r1' }), '无 token 记录写入')
    const none = await readTurnTimings(ttDir, 'none')
    ok(none[0]?.outputTokens === undefined, '一条都没报时是 undefined（界面显示未知，不当 0）')

    /* 脏值丢掉：负数 / 字符串 / NaN 都不收 */
    ok(await appendTurnTiming(ttDir, 'dirty', { ...base, runId: 'r1', outputTokens: -5 }), '脏值写入（负）')
    const dirty = await readTurnTimings(ttDir, 'dirty')
    ok(dirty[0]?.outputTokens === undefined, '负 token 被丢掉')

    await rm(ttDir, { recursive: true, force: true })
  }

  await rm(dir, { recursive: true, force: true })
}
