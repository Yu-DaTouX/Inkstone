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

  await rm(dir, { recursive: true, force: true })
}
