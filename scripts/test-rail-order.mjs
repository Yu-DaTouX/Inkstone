export async function runRailOrderTests(ok) {
  const { orderAfterDrag, beforeFromDrop, rankOf } = await import('../out/test/rail-order.mjs')

  console.log('\n--- 16. 拖拽排序（项目 / 分组顺序）---')

  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'd', 'a')
    ok(next.join(',') === 'd,a,b,c', '拖到第一行之前 → 放到最前', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'a', null)
    ok(next.join(',') === 'b,c,d,a', '拖到末尾 → 放到最后', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'd', 'b')
    ok(next.join(',') === 'a,d,b,c', '拖到中间 → 插在目标之前', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'a', 'c')
    ok(next.join(',') === 'b,a,c,d', '向后拖时下标要按移除后的列表算', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'b', 'b')
    ok(next.join(',') === 'a,b,c', '落点是自己 → 顺序不变', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'b', 'c')
    ok(next.join(',') === 'a,b,c', '原位重排 → 顺序不变（不会白写一次设置）', next.join(','))
  }

  {
    const ids = ['a', 'b']
    const next = orderAfterDrag(ids, 'zz', 'a')
    ok(next.join(',') === 'a,b', 'movedId 不在列表 → 原样', next.join(','))
  }

  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'a', 'zz')
    ok(next.join(',') === 'a,b,c', 'beforeId 不在列表 → 原样（宁可不插也不要瞎插）', next.join(','))
  }

  {
    const next = orderAfterDrag(['only'], 'only', null)
    ok(next.join(',') === 'only', '单元素列表拖到末尾 → 不变', next.join(','))
  }

  {
    const next = orderAfterDrag([], 'a', null)
    ok(next.length === 0, '空列表 → 空', JSON.stringify(next))
  }

  {
    const ids = ['a', 'b']
    const next = orderAfterDrag(ids, 'zz', 'a')
    ok(next !== ids, '原样返回也要是新数组，不共享引用')
    ok(ids.join(',') === 'a,b', '输入没有被就地修改')
  }

  {
    const ids = ['a', 'b', 'c']
    orderAfterDrag(ids, 'c', 'a')
    ok(ids.join(',') === 'a,b,c', '函数不就地修改传入的数组')
  }

  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'b', false) === 'b', '上半部 → 插到目标行之前')
  }

  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'b', true) === 'c', '下半部 → 插到下一行之前')
  }

  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'c', true) === null, '最后一行的下半部 → 插到末尾')
  }

  {
    ok(beforeFromDrop(['a', 'b'], 'zz', false) === null, '目标不在列表 → null（按末尾处理）')
  }

  {
    const rank = rankOf(['c', 'a', 'b'])
    ok(rank.get('c') === 0 && rank.get('a') === 1 && rank.get('b') === 2, '名次按 order 的先后')
  }

  {
    const rank = rankOf(['a', 'b', 'a'])
    ok(rank.get('a') === 0 && rank.size === 2, '重复 id 只记第一次', `size=${rank.size}`)
  }

  {
    const rank = rankOf([])
    ok(rank.size === 0, '空顺序 → 空表')
  }

  {
    const ids = ['p1', 'p2', 'p3', 'p4']
    const before = beforeFromDrop(ids, 'p3', true)
    ok(before === 'p4', '落点解析：第 3 项下半部 → p4 之前')
    const next = orderAfterDrag(ids, 'p1', before)
    ok(next.join(',') === 'p2,p3,p1,p4', '完整拖拽：p1 落到 p3 与 p4 之间', next.join(','))
  }

  {
    const ids = ['p1', 'p2', 'p3']
    const before = beforeFromDrop(ids, 'p1', false)
    const next = orderAfterDrag(ids, 'p3', before)
    ok(next.join(',') === 'p3,p1,p2', '完整拖拽：p3 落到最前', next.join(','))
  }

  {
    const ids = ['p1', 'p2', 'p3']
    const before = beforeFromDrop(ids, 'p1', true)
    const next = orderAfterDrag(ids, 'p2', before)
    ok(before === 'p2', '相邻下行的落点 = 自己（这就是原位）')
    ok(next.join(',') === ids.join(','), '拖回原位 → 顺序等价（不触发落盘）', next.join(','))
  }
}
