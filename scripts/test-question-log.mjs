/**
 * 宿主提问记录的两段逻辑：
 *   · `src/shared/question-log.ts` —— 把记录合并成对话流里的用户消息（纯函数）
 *   · `src/main/question-log.ts` —— 按会话分组落盘（可注入文件路径）
 *
 * 为什么要有：这两段决定「用户在界面上看到的问答是什么」。合并算错会把问答
 * 插到别的轮次里；落盘错了会把别的会话的问答贴到当前对话上 —— 两者都不会
 * 抛错，只会静静地显示错内容。
 *
 * 用法：npm run test:unit
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runQuestionLogTests(ok) {
  const { mergeQuestionLog } = await import('../out/test/question-log.mjs')
  const { QuestionLogStore } = await import('../out/test/question-log-store.mjs')

  const msg = (id, role, timestamp, text) => ({ id, role, timestamp, text })
  const entry = (id, at, question, answer) => ({ id, question, options: [], answer, cancelled: answer == null, at })

  /* ── 合并：位置与顺序 ─────────────────────────────── */

  const base = [
    msg('u1', 'user', 1000, '第一个问题'),
    msg('a1', 'assistant', 2000, '我先看看'),
    msg('a2', 'assistant', 5000, '这是拿到答案后的回复')
  ]
  const merged = mergeQuestionLog(base, [entry('q1', 3000, '选哪个？', '选 A')])
  ok(merged.length === 4, '问答被插入成一条消息', String(merged.length))
  ok(merged[2].id === 'qlog:q1', '插在「提问时刻之前/之后」的正确位置（5000 那条之前）', merged.map((m) => m.id).join(','))
  ok(merged[2].role === 'user' && merged[2].question === true, '合成的是标记为提问的用户消息')
  ok(merged[2].text === '选哪个？\n\n选 A', '正文是「问题 + 回答」', JSON.stringify(merged[2].text))
  ok(merged[2].timestamp === 3000, '时间戳保留回答时刻（排序与位置恢复靠它）')
  ok(base.length === 3 && !base.some((m) => m.question), '不改动原数组（渲染侧不能污染 messages）')

  ok(mergeQuestionLog(base, []).length === 3, '没有记录时原样返回')

  /* 时间戳晚于全部消息 → 追加到末尾（刚答完、模型还没回复） */
  const appended = mergeQuestionLog(base, [entry('q2', 9000, '还要问吗？', null)])
  ok(appended[3].id === 'qlog:q2', '比所有消息都晚的记录排在末尾', appended.map((m) => m.id).join(','))
  ok(appended[3].text === '还要问吗？', '取消 / 超时的记录只显示问题，不编造答案')

  /* 同一位置的连续问答合并成一条 */
  const grouped = mergeQuestionLog(base, [entry('q1', 3000, '一？', '1'), entry('q2', 3500, '二？', '2')])
  ok(grouped.filter((m) => m.question).length === 1, '同一轮里连续两条问答合成一条消息', String(grouped.length))
  ok(grouped[2].text === '一？\n\n1\n\n二？\n\n2', '合并后的正文按顺序列出两组问答', JSON.stringify(grouped[2].text))

  /* 消息缺 timestamp 时不能把问答插到最前面（宁可放最后） */
  const noStamp = [msg('u1', 'user', undefined, '没有时间戳')]
  const tailed = mergeQuestionLog(noStamp, [entry('q1', 3000, '问？', '答')])
  ok(tailed[1]?.id === 'qlog:q1', '缺时间戳的历史不参与比较，问答落在末尾', tailed.map((m) => m.id).join(','))

  /* ── 落盘：按会话分组 ────────────────────────────── */

  const dir = mkdtempSync(join(tmpdir(), 'yan-qlog-'))
  const file = join(dir, 'question-log.json')
  const store = new QuestionLogStore(() => file)

  ok(store.list('session-a').length === 0, '首次读取：文件不存在也返回空表')

  const a1 = store.append('session-a', { question: '甲', options: ['x'], answer: 'x', cancelled: false, at: 1 })
  ok(a1?.length === 1 && a1[0].id, 'append 返回更新后的完整列表（渲染端整表覆盖）')
  store.append('session-b', { question: '乙', options: [], answer: null, cancelled: true, at: 2 })
  ok(store.list('session-a').length === 1 && store.list('session-b').length === 1, '两个会话的记录互不干扰')
  ok(store.list('session-a')[0].question === '甲', '记录内容按会话对上')

  ok(store.append(undefined, { question: '丙', options: [], answer: null, cancelled: true, at: 3 }) === null, '没有会话身份时不记录（避免挂到别的会话上）')
  ok(store.list('../../etc/passwd').length === 0, '会话 id 不合法时读不到任何东西')

  const fresh = new QuestionLogStore(() => file)
  ok(fresh.list('session-a').length === 1, '新实例从磁盘读回同一份记录（重启后仍在）')

  /* 裁剪：只留最近 50 条 */
  for (let i = 0; i < 60; i += 1) {
    store.append('session-c', { question: `q${i}`, options: [], answer: 'a', cancelled: false, at: 100 + i })
  }
  const capped = store.list('session-c')
  ok(capped.length === 50, '每个会话最多留 50 条', String(capped.length))
  ok(capped[capped.length - 1].question === 'q59' && capped[0].question === 'q10', '裁剪保留最近的那一批', `${capped[0].question}..${capped[capped.length - 1].question}`)

  /* 坏文件 / 手改过的内容不能让界面崩掉 */
  writeFileSync(file, '{ not json', 'utf8')
  ok(store.list('session-a').length === 0, '文件坏了按空表处理（不抛错）')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      sessions: {
        'session-a': [
          { question: '好条目', at: 10, options: ['a'], answer: 'a' },
          { question: '', at: 11 },
          { question: '没有时间', at: 'x' },
          'not an object'
        ],
        '../bad': [{ question: '越界', at: 12 }]
      }
    }),
    'utf8'
  )
  const cleaned = store.list('session-a')
  ok(cleaned.length === 1 && cleaned[0].question === '好条目', '读盘时逐条校验，坏条目被丢掉', JSON.stringify(cleaned))
  ok(store.list('../bad').length === 0, '非法会话 key 直接跳过')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  ok(!!raw.sessions['session-a'], '（读操作不会重写文件）')
}
