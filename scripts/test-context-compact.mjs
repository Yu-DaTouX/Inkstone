// context-compact.js：不截断工具结果、放不下才分段、出错退回 pi 默认压缩
import assert from 'node:assert/strict'
const mod = await import('../resources/pi-extensions/context-compact.js')

const long = '甲'.repeat(10_000) + '钥匙编号 XQ-1234' + '乙'.repeat(10_000)
const messages = [
  { role: 'user', content: '读完整本书' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '先读第一章' }, { type: 'toolCall', name: 'read', arguments: { path: 'book/ch01.md' } }] },
  { role: 'toolResult', content: [{ type: 'text', text: long }] }
]
const text = messages.map(mod.serializeMessage).join('\n\n')
assert.ok(text.includes('钥匙编号 XQ-1234'), '工具结果中间的内容没有被截掉')
assert.ok(!text.includes('more characters truncated'), '不出现截断标记')
assert.ok(text.includes('[Assistant tool calls]: read(path="book/ch01.md")'), '工具调用格式和 pi 一致')

assert.equal(mod.chunkParts(['a'.repeat(100), 'b'.repeat(100)], 1, 1_000).length, 1, '放得下就一块')
assert.equal(mod.chunkParts(Array(5).fill('c'.repeat(900)), 1, 1_000).length, 5, '放不下按段切')
assert.ok(Math.abs(mod.tokensPerChar(354_000, 20_000, 480_000) - 0.696) < 0.01, '按会话实测比例估算')

function harness(complete, window = 400_000) {
  let handler
  mod.default({ on: (name, fn) => { if (name === 'session_before_compact') handler = fn } })
  const calls = []
  const ctx = { model: { contextWindow: window, maxTokens: 64_000, reasoning: false }, thinkingLevel: 'off', modelRegistry: { complete: async (model, context, options) => { calls.push({ context, options }); return complete(calls.length) } } }
  const event = { preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'e9', tokensBefore: 30_000, settings: { reserveTokens: 40_000, keepRecentTokens: 2_000 }, fileOps: { read: new Set(['book/ch01.md']), written: new Set(), edited: new Set() } }, signal: new AbortController().signal }
  return { run: () => handler(event, ctx), calls }
}

{
  const h = harness(() => ({ stopReason: 'stop', content: [{ type: 'text', text: '## Goal\n读书\n## Facts & Details\n- ch01: XQ-1234' }], usage: { input: 10, output: 5 } }))
  const result = await h.run()
  assert.equal(h.calls.length, 1, '一次调用')
  assert.ok(h.calls[0].context.messages[0].content[0].text.includes('钥匙编号 XQ-1234'), '摘要模型拿到完整工具结果')
  assert.equal(h.calls[0].options.maxTokens, 32_000, '输出上限沿用 pi 的 0.8 × reserveTokens')
  assert.equal(result.compaction.firstKeptEntryId, 'e9')
  assert.ok(result.compaction.summary.includes('<read-files>\nbook/ch01.md'), '附上文件清单')
}
{
  // 窗口很小：分段，后一段带上前一段的摘要
  const h = harness((n) => ({ stopReason: 'stop', content: [{ type: 'text', text: `摘要${n}` }] }), 60_000)
  const result = await h.run()
  assert.ok(h.calls.length >= 2, '分段调用')
  assert.ok(h.calls[1].context.messages[0].content[0].text.includes('<previous-summary>\n摘要1'), '滚动更新带上前一段摘要')
  assert.ok(result.compaction.summary.startsWith(`摘要${h.calls.length}`))
}
{
  const h = harness(() => ({ stopReason: 'error', errorMessage: 'boom', content: [] }))
  assert.equal(await h.run(), undefined, '出错退回默认压缩')
}
console.log('context-compact 测试通过')
