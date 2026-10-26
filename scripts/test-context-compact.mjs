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
{
  const h = harness(() => ok('摘要'))
  const result = await h.run()
  assert.ok(result.compaction.summary.includes("<user-messages>\nThe user's own messages from the compacted part, verbatim, oldest first:\n[#1.1] 读完整本书\n</user-messages>"), '被压缩部分的用户原话由代码原样附上')
  const prompt = h.calls[0].context.messages[0].content[0].text
  assert.ok(/priorities, highest first/i.test(prompt) && /\[ruled out\]/.test(prompt) && /Never estimate a line number/.test(prompt) && /\[external\]/.test(prompt), '提示词按优先级保留、区分状态、只照抄观测到的位置、外部内容标来源')
  assert.ok(!/Be exhaustive/.test(prompt), '不再要求穷举')
  assert.ok(/under about 16000 tokens/.test(prompt), '给出篇幅目标（输出上限的一半）')
}
{
  const previous = "旧摘要\n\n<user-messages>\nThe user's own messages from the compacted part, verbatim, oldest first:\n[#1.1] 第一条\n多行\n[#1.5] 第二条\n</user-messages>"
  const block = mod.userMessagesBlock(previous, [{ role: 'user', content: '第三条' }, { role: 'assistant', content: [] }], 2, 1_000)
  assert.ok(block.includes('[#1.1] 第一条\n多行\n[#1.5] 第二条\n[#2.1] 第三条'), '上次附的原话加上这次的，按时间顺序')
  const capped = mod.userMessagesBlock(previous, [{ role: 'user', content: '第三条' }], 2, 12)
  assert.ok(capped.includes('(2 older ones omitted)') && capped.includes('[#2.1] 第三条') && !capped.includes('第一条'), '超出上限时从最早的丢，并注明丢了几条')
}
{
  let n = 0
  const h = harness(() => (++n === 1 ? { stopReason: 'length', content: [{ type: 'text', text: '太长' }], usage: { input: 1 } } : ok('短摘要', { input: 1 })))
  const result = await h.run()
  assert.equal(h.calls.length, 2, '输出顶到上限时同一块重试一次')
  assert.ok(/ran past the output limit/.test(h.calls[1].context.messages[0].content[0].text), '重试时要求写短一些')
  assert.equal(result.compaction.details.lengthRetries, 1)
  assert.equal(result.compaction.usage.input, 2)
}
{
  const h = harness(() => ({ stopReason: 'length', content: [], usage: { input: 1 } }))
  assert.equal(await h.run(), undefined, '重试后仍然太长就退回 pi')
  assert.equal(h.calls.length, 2)
  h.compacted(false)
  assert.equal(h.entries[0].data.category, 'length')
}
{
  const payload = { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], tools: [{ type: 'function', name: 'read' }], prompt_cache_key: 'k', reasoning: { effort: 'medium' }, max_output_tokens: 1_000 }
  const next = mod.appendInstruction('openai-responses', payload, '写摘要', 9_000)
  assert.equal(next.input.length, 2)
  assert.equal(next.input[0], payload.input[0], '原有输入原样保留（同一对象，字节不变）')
  assert.deepEqual(next.input[1], { role: 'user', content: [{ type: 'input_text', text: '写摘要' }] }, '指令追加在最后')
  assert.equal(next.tool_choice, 'none', '有工具时用 tool_choice none 禁止调用，不删工具')
  assert.equal(next.tools, payload.tools)
  assert.deepEqual([next.prompt_cache_key, next.reasoning, next.max_output_tokens], ['k', payload.reasoning, 9_000], '缓存键、思考档位不变，只改输出上限')
  assert.equal(payload.input.length, 1, '不改动原请求体')
}
{
  const toolResult = { type: 'tool_result', tool_use_id: 't1', content: 'x', cache_control: { type: 'ephemeral' } }
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [toolResult] },
      { role: 'system', content: [], output_config: { effort: 'high' } }
    ],
    tools: [{ name: 'read' }], max_tokens: 64_000
  }
  const next = mod.appendInstruction('anthropic-messages', payload, '写摘要', 9_000)
  assert.equal(next.messages.length, 4, '不新增消息，保持角色交替')
  assert.deepEqual(next.messages[2].content, [toolResult, { type: 'text', text: '写摘要' }], '指令并进最后一条用户消息、排在带缓存标记的 tool_result 之后')
  assert.equal(next.messages[3], payload.messages[3], '末尾只带 effort 的 system 消息原样留在最后')
  assert.deepEqual(next.tool_choice, { type: 'none' })
  assert.equal(next.max_tokens, 9_000)
  assert.equal(payload.messages[2].content.length, 1, '不改动原请求体')
  const budget = mod.appendInstruction('anthropic-messages', { messages: [{ role: 'assistant', content: 'a' }], thinking: { type: 'enabled', budget_tokens: 4_000 } }, '写摘要', 9_000)
  assert.deepEqual(budget.messages.at(-1), { role: 'user', content: [{ type: 'text', text: '写摘要' }] }, '最后是助手消息时另起一条用户消息')
  assert.equal(budget.max_tokens, 13_000, '固定思考预算时输出上限要加上预算')
  assert.ok(!('tool_choice' in budget), '没有工具就不设 tool_choice')
}
{
  const next = mod.appendInstruction('openai-completions', { messages: [{ role: 'user', content: 'hi' }], tools: [{}], max_completion_tokens: 100 }, '写摘要', 9_000)
  assert.deepEqual(next.messages.at(-1), { role: 'user', content: '写摘要' })
  assert.deepEqual([next.tool_choice, next.max_completion_tokens, 'max_tokens' in next], ['none', 9_000, false], '沿用请求体原有的上限字段名')
  assert.equal(mod.appendInstruction('google-gemini', { contents: [] }, 'x', 1), null, '认不出的格式不走快速路径')
}

const sentUser = { ...messages[0], timestamp: 1 }
const sentResult = { ...messages[2], timestamp: 3 }
const tailMessage = { role: 'assistant', content: [{ type: 'text', text: '最后的回复 ZZ-9' }], timestamp: 4 }
function fastHarness(complete, { reason = 'manual', tokensBefore = 300_000, sentLast = sentResult, modelAtRequest = 'm', withContext = true } = {}) {
  const handlers = {}
  mod.default({ on: (name, fn) => { handlers[name] = fn }, appendEntry: () => {} })
  const calls = []
  const model = { provider: 'p', id: 'm', api: 'openai-responses', contextWindow: 400_000, maxTokens: 64_000, reasoning: false }
  const ctx = {
    model, thinkingLevel: 'off',
    sessionManager: { getSessionId: () => 'S1' },
    modelRegistry: { complete: async (m, context, options) => { calls.push({ context, options }); return complete(calls.length, options) } }
  }
  const payload = { model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: '读完整本书' }] }], tools: [{ type: 'function', name: 'read' }] }
  const branchEntries = [
    { id: 'L0', type: 'message', message: sentUser },
    { id: 'L1', type: 'message', message: sentResult },
    { id: 'L2', type: 'message', message: tailMessage }
  ]
  const event = { preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'e9', tokensBefore, settings: { reserveTokens: 40_000, keepRecentTokens: 2_000 }, fileOps: { read: new Set(['book/ch01.md']) } }, branchEntries, reason, signal: new AbortController().signal }
  return {
    request: () => {
      if (withContext) assert.equal(handlers.context({ messages: [sentUser, sentLast] }), undefined, '只记录，不改上下文')
      return handlers.before_provider_request({ payload }, { ...ctx, model: { ...model, id: modelAtRequest } })
    },
    run: () => handlers.session_before_compact(event, ctx),
    compacted: () => handlers.session_compact({ fromExtension: true }),
    calls, payload
  }
}
{
  const h = fastHarness(() => ok('## Goal\n读书\n\n<read-files>\n旧清单\n</read-files>', { input: 300_000, cacheRead: 299_000 }))
  assert.equal(h.request(), undefined, '截取请求体但不改它')
  const result = await h.run()
  assert.equal(h.calls.length, 1, '快速路径一次调用')
  const sent = h.calls[0].options.onPayload()
  assert.equal(sent.input[0], h.payload.input[0], '重发的是主会话最后一次请求的原样前缀')
  const instruction = sent.input.at(-1).content[0].text
  assert.ok(/^Stop here\. Do not call any tool/.test(instruction) && instruction.includes('最后的回复 ZZ-9'), '指令追加在末尾，并带上请求之后的消息')
  assert.ok(!instruction.includes('钥匙编号'), '请求里已有的最后一条工具结果不再重复附上')
  assert.ok(/source tag naming the tool/.test(instruction) && !/anchor line such as/.test(instruction), '模型看不到锚点行，改用工具和路径做来源标记')
  assert.equal(sent.tool_choice, 'none')
  assert.equal(h.calls[0].options.maxTokens, 32_000)
  assert.equal(h.calls[0].options.sessionId, 'S1', '带上会话 ID，路由和主会话一致')
  assert.equal(result.compaction.details.path, 'prefix')
  assert.ok(result.compaction.details.fastMs >= 0 && !result.compaction.details.fastError)
  assert.ok(!result.compaction.summary.includes('旧清单') && result.compaction.summary.includes('<read-files>\nbook/ch01.md'), '模型抄来的附录去掉，由代码重新附上')
  assert.equal(result.compaction.usage.cacheRead, 299_000)
}
{
  const h = fastHarness((n) => (n === 1 ? { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'x', name: 'read', arguments: {} }], usage: { input: 5 } } : ok('分块摘要', { input: 1 })))
  h.request()
  const result = await h.run()
  assert.equal(h.calls.length, 2, '快速路径调了工具就退回分块')
  assert.equal(result.compaction.details.path, 'chunked')
  assert.ok(result.compaction.details.fastError.startsWith('tool-call'), '记下快速路径失败原因')
  assert.equal(result.compaction.usage.input, 6, '失败那次的用量也计入')
}
for (const [label, opts, expected] of [
  ['溢出触发的压缩不走快速路径（原请求本身就放不下）', { reason: 'overflow' }, 'overflow'],
  ['输出空间不够时不走快速路径', { tokensBefore: 392_000 }, 'no-room'],
  ['请求之后会话分支变了就不用旧请求', { sentLast: { role: 'toolResult', timestamp: 99, toolCallId: 'c1' } }, 'stale'],
  ['没截到上下文就不用请求体', { withContext: false }, 'no-request'],
  ['换过模型就不用旧请求', { modelAtRequest: 'other' }, 'model-changed']
]) {
  const h = fastHarness(() => ok('分块摘要'), opts)
  h.request()
  const result = await h.run()
  assert.equal(result.compaction.details.path, 'chunked', label)
  assert.equal(result.compaction.details.fastError, expected, label)
  assert.ok(!h.calls[0].options.onPayload, label)
}
{
  const h = fastHarness(() => ok('摘要'), { tokensBefore: 380_000 })
  h.request()
  await h.run()
  assert.equal(h.calls[0].options.maxTokens, 16_000, '输出上限不超过窗口剩余空间')
  h.compacted()
  const again = await h.run()
  assert.equal(again.compaction.details.fastError, 'no-request', '压缩之后旧请求作废')
}
{
  const tail = [{ role: 'assistant', content: [], usage: { input: 1_000, cacheRead: 362_000, cacheWrite: 0, output: 80 } }, { role: 'toolResult', content: [] }]
  const est = mod.fastInputTokens(tail, '章'.repeat(30_000), 0.7, 370_000)
  assert.ok(est > 363_000 + 21_000 && est < 363_000 + 25_000, '请求体按实际用量、新消息按会话比例估，不用 pi 偏低的估算')
  assert.equal(mod.fastInputTokens([{ role: 'toolResult', content: [] }], 'x', 0.7, 370_000), 370_000, '没有实际用量时退回 tokensBefore')
}
{
  const h = fastHarness(() => ok('摘要'), { tokensBefore: 300_000 })
  tailMessage.usage = { input: 10_000, cacheRead: 380_000 }
  h.request()
  const result = await h.run()
  delete tailMessage.usage
  assert.equal(result.compaction.details.fastError, 'no-room', '实际请求已接近窗口时不走快速路径，哪怕 pi 估得偏低')
}
{
  const call = (name, path) => ({ role: 'assistant', content: [{ type: 'toolCall', id: path, name, arguments: { path } }] })
  const summarized = [call('read', 'a.js'), call('read', 'b.js'), call('edit', 'a.js'), call('bash', 'x'), call('read', 'c.js'), call('read', 'd.js')]
  assert.deepEqual(mod.recentFiles(summarized, [call('read', 'd.js')]), ['c.js', 'a.js', 'b.js'], '新的在前、去重、保留区里已有的不补')
  assert.equal(mod.recentFiles(Array.from({ length: 9 }, (_, i) => call('read', `f${i}.js`)), []).length, 5, '最多 5 个')
}
{
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'yan-reinject-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.js'), 'const x = 1\nconst key = "sk-abcdefghijklmnopqrstuvwx"\n')
  writeFileSync(join(dir, 'big.txt'), 'y'.repeat(200_000))
  writeFileSync(join(dir, 'bin.dat'), 'a\0b')
  const { block, files } = await mod.currentFilesBlock(['src/a.js', 'big.txt', 'bin.dat', '../outside.txt', 'missing.js'], dir, 0.3)
  assert.ok(block.includes('=== src/a.js (3 lines) ===\n1\tconst x = 1\n2\tconst key = "sk-[REDACTED]"'), '按磁盘当前内容带行号补回，密钥替换成占位符')
  assert.ok(block.includes('=== big.txt (1 lines, too large to include here; read it if you need it) ==='), '超过单个上限的只给路径')
  assert.ok(!block.includes('bin.dat') && !block.includes('outside') && !block.includes('missing'), '不补二进制、工作目录外和不存在的文件')
  assert.deepEqual(files.map((f) => [f.path, f.included]), [['src/a.js', true], ['big.txt', false]])
  assert.equal(mod.stripAppendices(`摘要${block}`), '摘要', '下次压缩前去掉上次补回的文件')

  const handlers = {}
  mod.default({ on: (name, fn) => { handlers[name] = fn }, appendEntry: () => {} })
  const ctx = { cwd: dir, model: { contextWindow: 400_000, maxTokens: 64_000, reasoning: false }, thinkingLevel: 'off', modelRegistry: { complete: async () => ok('摘要') } }
  const summarized = [...messages, { role: 'assistant', content: [{ type: 'toolCall', id: 'c5', name: 'read', arguments: { path: 'src/a.js' } }] }]
  const event = { preparation: { messagesToSummarize: summarized, turnPrefixMessages: [], firstKeptEntryId: 'k1', tokensBefore: 30_000, settings: { reserveTokens: 40_000 }, fileOps: {} }, branchEntries: [{ id: 'k1', type: 'message', message: { role: 'user', content: '继续' } }], signal: new AbortController().signal }
  const result = await handlers.session_before_compact(event, ctx)
  assert.ok(result.compaction.summary.includes('<current-files>') && result.compaction.summary.includes('1\tconst x = 1'), '压缩后补回最近用过的文件')
  assert.deepEqual(result.compaction.details.reinjected.map((f) => f.path), ['src/a.js'], 'details 记下补回了哪些')
  process.env.YAN_COMPACT_REINJECT = '0'
  const off = await handlers.session_before_compact(event, ctx)
  delete process.env.YAN_COMPACT_REINJECT
  assert.ok(!off.compaction.summary.includes('<current-files>') && !off.compaction.details.reinjected, 'YAN_COMPACT_REINJECT=0 时不补回（对照实验用）')
}
{
  const handlers = {}
  mod.default({ on: (name, fn) => { handlers[name] = fn }, appendEntry: () => {} })
  const seen = []
  const ctx = { model: { contextWindow: 400_000, maxTokens: 384_000, reasoning: false }, thinkingLevel: 'off', modelRegistry: { complete: async (m, c, options) => { seen.push(options.maxTokens); return ok('摘要') } } }
  const event = { preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'e9', tokensBefore: 30_000, settings: { reserveTokens: 300_000 } , fileOps: {} }, signal: new AbortController().signal }
  await handlers.session_before_compact(event, ctx)
  assert.equal(seen[0], 32_000, '压缩线调低、reserveTokens 很大时，摘要输出上限仍封顶 32k')
}
console.log('context-compact 测试通过')
