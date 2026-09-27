/**
 * 预算观察者的**诊断字段**测试。
 *
 * 为什么单独测：`payloadCensus` 是用来定位「估算与实际差 4 倍」的工具本身 ——
 * 它要是统计错了，我会拿着一个错的分布去改公式，越改越偏。所以先把统计口径钉住。
 */
export function runContextBudgetObserverTests(ok, mod) {
  const { payloadCensus } = mod
  ok(typeof payloadCensus === 'function', 'payloadCensus 可用')

  const payload = {
    model: 'x',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'abcd' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(100) }] }
    ],
    tools: [{ function: { name: 'bash', description: 'y'.repeat(50) } }],
    system: 'z'.repeat(10)
  }
  const c = payloadCensus(payload)
  /*
   * 1(model) + [4(user) + 4(text) + 4(abcd)] + [9(assistant) + 8(thinking) + 100]
   *   + [4(bash) + 50(description)] + 10(system) = 194
   */
  ok(c.chars === 194, `统计整份 payload 的字符串总长（实际 ${c.chars}）`)
  ok(c.blockChars === 129, `block 细分只统计 messages 里的字符串（实际 ${c.blockChars}）`)
  ok(c.byBlockField['thinking.thinking'] === 100, 'block 细分按「type.字段」归并')
  ok(c.byBlockField['text.text'] === 4, 'text 块单独归并')
  ok(c.byTopKey.messages === 129 && c.byTopKey.system === 10, '顶层键细分能分开 messages / system')
  ok(c.byTopKey.tools === 54, `tools 的字符串也算进顶层（实际 ${c.byTopKey.tools}）`)

  ok(payloadCensus(null).chars === 0, '空 payload 不炸')
  ok(payloadCensus({ messages: [{ a: { b: { c: 1 } } }] }).chars === 0, '非字符串内容不进字符数')
  const deep = { messages: [{ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 'deep' } } } } } } } } } }] }
  ok(payloadCensus(deep).chars === 0, '超过深度上限的内容不再往下走（不会爆栈）')
}
