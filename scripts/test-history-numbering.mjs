import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { normalizeMessage } = await compile('src/main/normalize.ts', { platform: 'neutral' })
  const { projectHistory } = await compile('src/main/session-items/projector.ts', { platform: 'neutral' })
  const userMsg = { role: 'user', content: '你好' }
  const asstMsg = { role: 'assistant', content: [{ type: 'text', text: '在' }] }

  const legacy = projectHistory([userMsg, asstMsg])
  ok(
    legacy[0]?.id === 'm0' && legacy[1]?.id === 'm1',
    '历史编号：旧版 JSONL（无 system）从 m0 起',
    legacy.map((m) => m.id).join(',')
  )

  const withSystem = projectHistory([{ role: 'system', content: 'prompt' }, userMsg, asstMsg])
  ok(
    withSystem.length === 2 && withSystem[0]?.id === 'm0' && withSystem[0]?.role === 'user',
    '历史编号：跳过 Pi 0.87 写进 JSONL 的 system，用户消息仍是 m0',
    withSystem.map((m) => `${m.id}:${m.role}`).join(',')
  )

  const liveFirst = normalizeMessage(userMsg, 0)
  ok(
    !!liveFirst && liveFirst.id === withSystem[0]?.id,
    '历史与实时的用户消息 id 一致（回合计时锚点才对得上）'
  )

  const withEntry = projectHistory([userMsg, asstMsg], undefined, ['90ac64b9', '23cb6928'])
  ok(
    withEntry[0]?.entryId === '90ac64b9' && withEntry[1]?.entryId === '23cb6928',
    '历史读回：entry.id 挂到消息上（fork 锚点）',
    withEntry.map((m) => m.entryId).join(',')
  )
  const noEntry = normalizeMessage(userMsg, 0)
  ok(noEntry?.entryId === undefined, '实时消息（无文件上下文）不带 entryId')
}, { isolate: true })
