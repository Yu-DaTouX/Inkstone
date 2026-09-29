/**
 * 「内容相同就沿用旧引用」（state/same-messages.ts）的纯逻辑测试。
 * 两个方向都要有断言：相同要复用（否则千条会话重复渲染），不同必须替换（否则界面看不到更新）。
 */
export async function runSameMessagesTests(ok) {
  const { reuseIfSame } = await import('../out/test/same-messages.mjs')
  console.log('\n--- 消息列表内容相同时沿用旧引用 ---')

  const a = () => [
    { id: 'm0', role: 'user', text: '你好' },
    { id: 'm1', role: 'assistant', text: '好的', toolCalls: [{ id: 't1', status: 'ok', output: 'x' }] }
  ]
  const prev = a()
  ok(reuseIfSame(prev, a()) === prev, '内容完全相同 → 返回旧数组（引用不变）')

  const grown = [...a(), { id: 'm2', role: 'user', text: '继续' }]
  const out = reuseIfSame(prev, grown)
  ok(out !== prev && out.length === 3, '多了一条 → 是新数组')
  ok(out[0] === prev[0] && out[1] === prev[1], '前面没变的条目沿用旧对象')

  const changed = a()
  changed[1].toolCalls[0].status = 'error'
  const out2 = reuseIfSame(prev, changed)
  ok(out2 !== prev && out2[1] !== prev[1] && out2[1].toolCalls[0].status === 'error', '嵌套字段变了 → 该条被替换')
  ok(out2[0] === prev[0], '同一批里没变的那条仍沿用旧对象')

  ok(reuseIfSame(prev, prev.slice(0, 1)) !== prev, '变短 → 是新数组')
  ok(reuseIfSame([], []).length === 0, '空列表不出错')
}
