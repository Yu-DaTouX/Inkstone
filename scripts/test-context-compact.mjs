// context-compact.js：不截断工具结果、放不下才分段、超长单段切片、出错退回 pi 默认压缩并留记录
import assert from 'node:assert/strict'
const mod = await import('../resources/pi-extensions/context-compact.js')

const long = '甲'.repeat(10_000) + '钥匙编号 XQ-1234' + '乙'.repeat(10_000)
const messages = [
  { role: 'user', content: '读完整本书' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '先读第一章' }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'book/ch01.md' } }] },
  { role: 'toolResult', toolCallId: 'c1', toolName: 'read', isError: false, content: [{ type: 'text', text: long }] }
]
const text = messages.map((m, i) => mod.serializeMessage(m, i + 1)).join('\n\n')
assert.ok(text.includes('钥匙编号 XQ-1234'), '工具结果中间的内容没有被截掉')
assert.ok(!text.includes('more characters truncated'), '不出现截断标记')
assert.ok(text.includes('[Assistant tool calls]: read(path="book/ch01.md") call=c1'), '工具调用带调用 ID')
assert.ok(text.includes('[Tool result #3 read call=c1]: 甲'), '工具结果带序号、工具名、调用 ID')
assert.ok(mod.serializeMessage({ role: 'toolResult', toolName: 'bash', toolCallId: 'c2', isError: true, content: [] }, 7) === '[Tool result #7 bash call=c2 error]: (empty)', '失败的工具结果带 error 标记，空结果也留一行')

{
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
  const pieces = mod.splitPart(lines, 2_000)
  assert.ok(pieces.length > 1 && pieces.every((p) => p.length <= 2_000), '超长段按行切成不超过预算的几片')
  assert.ok(pieces[0].startsWith(`[piece 1/${pieces.length} of one message]`), '每片标明第几片')
  const joined = pieces.map((p) => p.slice(p.indexOf('\n') + 1)).join('\n')
  assert.equal(joined, lines, '切片拼回来和原文一致，不丢内容')
  const oneLine = mod.splitPart('y'.repeat(5_000), 1_000)
  assert.ok(oneLine.length >= 5 && oneLine.map((p) => p.slice(p.indexOf('\n') + 1)).join('') === 'y'.repeat(5_000), '单行太长按字符切，也不丢内容')
}
{
  const parts = ['a'.repeat(100), 'b'.repeat(5_000), 'c'.repeat(100)]
  const first = mod.takeChunk(parts, 0, 1_000)
  assert.equal(first.end, 1, '下一段放不下就先交这一块')
  const second = mod.takeChunk(parts, first.end, 1_000)
  assert.ok(parts.length > 3 && second.text.startsWith('[piece 1/'), '第一段就超预算时原地切片再取')
}
assert.ok(Math.abs(mod.tokensPerChar(354_000, 20_000, 480_000) - 0.696) < 0.01, '按会话实测比例估算')
assert.deepEqual(
  mod.addUsage({ input: 1, output: 2, cost: { input: 0.1, total: 0.3 } }, { input: 3, output: 4, cost: { input: 0.2, output: 0.5, total: 0.7 } }),
  { input: 4, output: 6, cost: { input: 0.1 + 0.2, total: 0.3 + 0.7, output: 0.5 } },
  '费用按嵌套结构逐项累加'
)

function harness(complete, { window = 400_000, previousSummary } = {}) {
  const handlers = {}
  const entries = []
  mod.default({ on: (name, fn) => { handlers[name] = fn }, appendEntry: (type, data) => entries.push({ type, data }) })
  const calls = []
  const ctx = { model: { contextWindow: window, maxTokens: 64_000, reasoning: false }, thinkingLevel: 'off', modelRegistry: { complete: async (model, context, options) => { calls.push({ context, options }); return complete(calls.length, context) } } }
  const event = { preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'e9', tokensBefore: 30_000, previousSummary, settings: { reserveTokens: 40_000, keepRecentTokens: 2_000 }, fileOps: { read: new Set(['book/ch01.md']), written: new Set(), edited: new Set() } }, signal: new AbortController().signal }
  return {
    run: () => handlers.session_before_compact(event, ctx),
    compacted: (fromExtension) => handlers.session_compact({ fromExtension }),
    calls,
    entries
  }
}
const ok = (text, usage) => ({ stopReason: 'stop', content: [{ type: 'text', text }], usage })

{
  const h = harness(() => ok('## Goal\n读书\n## Facts & Details\n- ch01: XQ-1234', { input: 10, output: 5, cost: { total: 0.01 } }))
  const result = await h.run()
  assert.equal(h.calls.length, 1, '一次调用')
  assert.ok(h.calls[0].context.messages[0].content[0].text.includes('钥匙编号 XQ-1234'), '摘要模型拿到完整工具结果')
  assert.equal(h.calls[0].options.maxTokens, 32_000, '输出上限沿用 pi 的 0.8 × reserveTokens')
  assert.equal(result.compaction.firstKeptEntryId, 'e9')
  assert.ok(result.compaction.summary.includes('<read-files>\nbook/ch01.md'), '附上文件清单')
  assert.equal(result.compaction.details.path, 'chunked')
  assert.equal(result.compaction.details.untruncated, true)
  assert.deepEqual(result.compaction.usage.cost, { total: 0.01 })
}
{
  const h = harness((n) => ok(`摘要${n}`, { input: 100, cost: { total: 1 } }), { window: 60_000 })
  const result = await h.run()
  assert.ok(h.calls.length >= 2, '分段调用')
  assert.ok(h.calls[1].context.messages[0].content[0].text.includes('<previous-summary>\n摘要1'), '滚动更新带上前一段摘要')
  assert.ok(result.compaction.summary.startsWith(`摘要${h.calls.length}`))
  const seen = h.calls.map((c) => c.context.messages[0].content[0].text).join('')
  assert.ok(seen.includes('钥匙编号 XQ-1234') && !seen.includes('truncated'), '超长段切片后整段都交给了摘要模型')
  assert.ok(seen.includes('[piece 1/'), '切片带片号')
  assert.equal(result.compaction.usage.cost.total, h.calls.length, '每次调用的费用都累加')
  assert.equal(result.compaction.details.chunks, h.calls.length)
}
{
  let first = true
  const h = harness(() => {
    if (first) {
      first = false
      return { stopReason: 'error', errorMessage: 'This model maximum context length is exceeded', content: [], usage: { input: 5, cost: { total: 0.5 } } }
    }
    return ok('摘要', { input: 1, cost: { total: 0.1 } })
  })
  const result = await h.run()
  assert.ok(result?.compaction, '服务端报容量不够时拆小重试')
  assert.equal(result.compaction.details.capacityRetries, 1)
  assert.ok(Math.abs(result.compaction.usage.cost.total - 0.6) < 1e-9, '失败那次的费用也计入')
}
{
  const h = harness(() => ({ stopReason: 'error', errorMessage: 'boom', content: [], usage: { input: 7 } }))
  assert.equal(await h.run(), undefined, '出错退回默认压缩')
  h.compacted(false)
  assert.equal(h.entries.length, 1, '退回 pi 默认后留一条会话记录')
  assert.equal(h.entries[0].type, mod.ENTRY_TYPE)
  assert.equal(h.entries[0].data.path, 'pi-default')
  assert.equal(h.entries[0].data.category, 'error')
  assert.equal(h.entries[0].data.usage.input, 7, '记录里有失败尝试的用量')
  await h.run()
  await h.run()
  const callsBefore = h.calls.length
  assert.equal(await h.run(), undefined)
  assert.equal(h.calls.length, callsBefore, '连续失败 3 次后熔断，不再调用模型')
  h.compacted(false)
  assert.equal(h.entries.at(-1).data.category, 'circuit-open')
}
{
  const h = harness(() => ok('很长'.repeat(20_000)))
  assert.equal(await h.run(), undefined, '摘要不比原文小就丢弃')
  h.compacted(false)
  assert.equal(h.entries[0].data.category, 'grew')
}
{
  const h = harness(() => ok('短摘要'))
  await h.run()
  h.compacted(true)
  assert.equal(h.entries.length, 0, '自己生成的压缩不额外记条目（细节在 compaction 条目里）')
}
{
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'yan-snapshot-'))
  const sessionFile = join(dir, 's1.jsonl')
  const secretMessages = [...messages, { role: 'toolResult', toolCallId: 'c9', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123' }] }]
  const handlers = {}
  mod.default({ on: (name, fn) => { handlers[name] = fn }, appendEntry: () => {} })
  const prompts = []
  const ctx = {
    model: { contextWindow: 400_000, maxTokens: 64_000, reasoning: false }, thinkingLevel: 'off',
    sessionManager: { getSessionFile: () => sessionFile },
    modelRegistry: { complete: async (model, context) => { prompts.push(context.messages[0].content[0].text); return ok('## Facts & Details\n- 钥匙 XQ-1234 (#1.3)') } }
  }
  const event = { preparation: { messagesToSummarize: secretMessages, turnPrefixMessages: [], firstKeptEntryId: 'e9', tokensBefore: 30_000, settings: { reserveTokens: 40_000 }, fileOps: {} }, signal: new AbortController().signal }
  const first = await handlers.session_before_compact(event, ctx)
  const history = readFileSync(`${sessionFile}.history.txt`, 'utf8')
  assert.ok(history.startsWith('=== compaction 1 · '), '快照文件头写压缩序号')
  assert.ok(history.includes('### [#1.3 tool_result read call=c1 ok]') && history.includes('钥匙编号 XQ-1234'), '快照带锚点和完整原文')
  assert.ok(history.includes('### [#1.4 tool_result bash call=c9 error]'), '失败的工具结果锚点标 error')
  assert.ok(!history.includes('sk-abcdefghijklmnop') && !history.includes('Bearer abcdefghijklmnop') && history.includes('[REDACTED]'), '写盘时替换常见密钥格式')
  assert.ok(prompts[0].includes('### [#1.3 tool_result read call=c1 ok]'), '摘要模型看到的原文也带锚点')
  assert.ok(first.compaction.summary.includes(`<history-snapshot>\nThe full text of the conversation compacted so far, tool outputs included, is saved at ${sessionFile}.history.txt (${history.length} characters)`), '摘要末尾给出快照路径和字符数')
  assert.equal(first.compaction.details.snapshot, `${sessionFile}.history.txt`)
  assert.equal(first.compaction.details.compactionNo, 1)
  const second = await handlers.session_before_compact(event, ctx)
  const history2 = readFileSync(`${sessionFile}.history.txt`, 'utf8')
  assert.ok(history2.startsWith(history) && history2.includes('=== compaction 2 · ') && history2.includes('### [#2.3 tool_result read'), '第二次压缩往后追加，锚点用新序号')
  assert.equal(second.compaction.details.compactionNo, 2)
  assert.deepEqual(readdirSync(dir).sort(), ['s1.jsonl.history.txt'], '临时文件改名后不留残余')
}
assert.equal(
  mod.stripAppendices('## Goal\n读书\n\n<read-files>\na.md\n</read-files>\n\n<history-snapshot>\nsaved at x (10 characters)\n</history-snapshot>'),
  '## Goal\n读书',
  '滚动更新前去掉上次附的文件清单和快照路径，由代码重新附上'
)
{
  const h = harness(() => ok('摘要'), { previousSummary: '旧摘要\n\n<history-snapshot>\nold\n</history-snapshot>' })
  await h.run()
  const sent = h.calls[0].context.messages[0].content[0].text
  assert.ok(sent.includes('<previous-summary>\n旧摘要\n</previous-summary>') && !sent.includes('old'), '交给摘要模型的旧摘要不带附录')
}
{
  const h = harness(() => ok('摘要'))
  const result = await h.run()
  assert.ok(!result.compaction.summary.includes('<history-snapshot>') && !result.compaction.details.snapshot, '没有会话文件时不写快照也不给路径')
}
console.log('context-compact 测试通过')
