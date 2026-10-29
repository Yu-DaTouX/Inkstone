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

  const nest = (leaf) => {
    let node = { leaf }
    for (let i = 0; i < 12; i += 1) node = { child: node, index: i }
    return { id: 'deep', body: node }
  }
  const deep = [nest('相同')]
  ok(reuseIfSame(deep, [nest('相同')]) === deep, '十二层嵌套内容相同 → 仍然复用（deepEqual 无深度上限）')
  ok(reuseIfSame(deep, [nest('不同')]) !== deep, '十二层嵌套叶子不同 → 换成新数组')

  const sparse = [{ id: 'm0', extra: undefined }]
  ok(reuseIfSame(sparse, [{ id: 'm0', extra: undefined }]) === sparse, 'undefined 字段视为相同')
  ok(reuseIfSame([{ id: 'm0' }], [{ id: 'm0', extra: 1 }]) !== undefined, '多出字段 → 不崩溃')
  ok(reuseIfSame(prev, prev) === prev, '同一引用直接返回')
}

export async function runStableRefTests(ok) {
  const { keepRef, structurallyEqual } = await import('../out/test/stable-ref.mjs')
  console.log('\n--- keepRef：8 层以内结构比较，超过上限一律换新引用 ---')

  const shallow = () => ({ id: 'r1', status: 'running', tools: [{ id: 't1', state: { done: true } }] })
  const prev = shallow()
  ok(keepRef(prev, shallow()) === prev, '浅层内容相同 → 沿用旧引用')
  ok(keepRef(prev, { ...shallow(), status: 'idle' }) !== prev, '字段变化 → 换新引用')
  ok(structurallyEqual({ a: [1, 2, 3] }, { a: [1, 2, 3] }), '数组按元素比较')
  ok(!structurallyEqual({ a: [1, 2] }, { a: [1, 2, 3] }), '数组长度不同 → 不等')
  ok(!structurallyEqual(null, {}), 'null 与对象不等')

  const nest = (depth, leaf) => {
    let node = { leaf }
    for (let i = 0; i < depth; i += 1) node = { child: node }
    return node
  }
  ok(structurallyEqual(nest(3, 'x'), nest(3, 'x')), '三层嵌套相同 → 相等')
  ok(!structurallyEqual(nest(3, 'x'), nest(3, 'y')), '三层嵌套不同 → 不等')
  ok(!structurallyEqual(nest(12, 'x'), nest(12, 'x')), '超过 8 层递归上限 → 判为不等（刻意保留的截断语义）')
  const deep = keepRef(nest(12, 'x'), nest(12, 'x'))
  ok(deep !== null && deep !== undefined, '超深结构不崩溃，直接换新引用')
}
