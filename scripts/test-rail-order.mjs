/**
 * 侧栏拖拽排序的纯逻辑测试（N01）。
 *
 * 为什么单独一个文件：拖拽的**几何**（指针落在哪一行、上半还是下半）
 * 只能在真实窗口里用指针事件验（`test:live -- railreorder`），
 * 而这里要钉死的是**顺序计算**：越界、未知 id、移动到原位、
 * 重复 id 这些边界在合成鼠标轨迹里很难摆出来。
 *
 * 两个函数的返回值语义是「调用方据此决定要不要落盘」，所以每种
 * 「原样返回」的情形都要单独断言一次 —— 少一种就会出现
 * 「拖了一下没动，但设置文件被重写了」这种看不见的写盘。
 */

export async function runRailOrderTests(ok) {
  const { orderAfterDrag, beforeFromDrop, rankOf } = await import('../out/test/rail-order.mjs')

  console.log('\n--- 16. 拖拽排序（项目 / 分组顺序）---')

  /* -------------------------------------------------- orderAfterDrag */

  // 16.1 拖到最前面
  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'd', 'a')
    ok(next.join(',') === 'd,a,b,c', '拖到第一行之前 → 放到最前', next.join(','))
  }

  // 16.2 拖到最后（beforeId = null）
  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'a', null)
    ok(next.join(',') === 'b,c,d,a', '拖到末尾 → 放到最后', next.join(','))
  }

  // 16.3 向中间插
  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'd', 'b')
    ok(next.join(',') === 'a,d,b,c', '拖到中间 → 插在目标之前', next.join(','))
  }

  // 16.4 往后拖（from < to 的下标位移不能算错）
  {
    const ids = ['a', 'b', 'c', 'd']
    const next = orderAfterDrag(ids, 'a', 'c')
    ok(next.join(',') === 'b,a,c,d', '向后拖时下标要按移除后的列表算', next.join(','))
  }

  // 16.5 拖到自己身上（落点是自己的行）
  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'b', 'b')
    ok(next.join(',') === 'a,b,c', '落点是自己 → 顺序不变', next.join(','))
  }

  // 16.6 松手时插到自己原位之后（b 的下半部分 = 插到 c 之前）
  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'b', 'c')
    ok(next.join(',') === 'a,b,c', '原位重排 → 顺序不变（不会白写一次设置）', next.join(','))
  }

  // 16.7 未知的 movedId（不是这个列表里的东西）
  {
    const ids = ['a', 'b']
    const next = orderAfterDrag(ids, 'zz', 'a')
    ok(next.join(',') === 'a,b', 'movedId 不在列表 → 原样', next.join(','))
  }

  // 16.8 未知的 beforeId（落点失效）
  {
    const ids = ['a', 'b', 'c']
    const next = orderAfterDrag(ids, 'a', 'zz')
    ok(next.join(',') === 'a,b,c', 'beforeId 不在列表 → 原样（宁可不插也不要瞎插）', next.join(','))
  }

  // 16.9 单元素列表
  {
    const next = orderAfterDrag(['only'], 'only', null)
    ok(next.join(',') === 'only', '单元素列表拖到末尾 → 不变', next.join(','))
  }

  // 16.10 空列表
  {
    const next = orderAfterDrag([], 'a', null)
    ok(next.length === 0, '空列表 → 空', JSON.stringify(next))
  }

  // 16.11 返回值必须是新数组（调用方会直接写进设置）
  {
    const ids = ['a', 'b']
    const next = orderAfterDrag(ids, 'zz', 'a')
    ok(next !== ids, '原样返回也要是新数组，不共享引用')
    ok(ids.join(',') === 'a,b', '输入没有被就地修改')
  }

  // 16.12 不改动输入（不可变）
  {
    const ids = ['a', 'b', 'c']
    orderAfterDrag(ids, 'c', 'a')
    ok(ids.join(',') === 'a,b,c', '函数不就地修改传入的数组')
  }

  /* -------------------------------------------------- beforeFromDrop */

  // 16.13 指针在目标行的上半部分 → 插到这一行之前
  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'b', false) === 'b', '上半部 → 插到目标行之前')
  }

  // 16.14 指针在目标行的下半部分 → 插到下一行之前
  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'b', true) === 'c', '下半部 → 插到下一行之前')
  }

  // 16.15 最后一行的下半部分 → 末尾
  {
    ok(beforeFromDrop(['a', 'b', 'c'], 'c', true) === null, '最后一行的下半部 → 插到末尾')
  }

  // 16.16 目标行不在列表里（行被过滤/重渲染）
  {
    ok(beforeFromDrop(['a', 'b'], 'zz', false) === null, '目标不在列表 → null（按末尾处理）')
  }

  /* -------------------------------------------------- rankOf */

  // 16.17 名次按数组先后
  {
    const rank = rankOf(['c', 'a', 'b'])
    ok(rank.get('c') === 0 && rank.get('a') === 1 && rank.get('b') === 2, '名次按 order 的先后')
  }

  // 16.18 重复 id 取第一次出现的位置（后面那次是被污染的旧数据）
  {
    const rank = rankOf(['a', 'b', 'a'])
    ok(rank.get('a') === 0 && rank.size === 2, '重复 id 只记第一次', `size=${rank.size}`)
  }

  // 16.19 空顺序 → 空表（调用方据此走「没有自定义顺序」的分支）
  {
    const rank = rankOf([])
    ok(rank.size === 0, '空顺序 → 空表')
  }

  /* -------------------------------------------------- 一次完整拖拽的合成 */

  /*
   * 把真实路径串起来：指针落在某行下半部 → 推 beforeId → 算新顺序。
   * 这一段是探针（合成 PointerEvent）走的那条路的纯逻辑镜像：
   * 探针只证明「事件真的接到了、顺序真的落盘」，先后关系由这里钉住。
   */
  // 16.20 把第 1 项拖到第 3 项的下半部（= 第 4 项之前）
  {
    const ids = ['p1', 'p2', 'p3', 'p4']
    const before = beforeFromDrop(ids, 'p3', true)
    ok(before === 'p4', '落点解析：第 3 项下半部 → p4 之前')
    const next = orderAfterDrag(ids, 'p1', before)
    ok(next.join(',') === 'p2,p3,p1,p4', '完整拖拽：p1 落到 p3 与 p4 之间', next.join(','))
  }

  // 16.21 把最后一项拖到第 1 项的上半部
  {
    const ids = ['p1', 'p2', 'p3']
    const before = beforeFromDrop(ids, 'p1', false)
    const next = orderAfterDrag(ids, 'p3', before)
    ok(next.join(',') === 'p3,p1,p2', '完整拖拽：p3 落到最前', next.join(','))
  }

  // 16.22 拖到紧邻上一行的下半部 = 回到自己原位（不能产生一次多余写盘）
  {
    const ids = ['p1', 'p2', 'p3']
    /* p1 的下半部 → 插入点是 p2 之前，而拖的正好就是 p2 → 落点等于自己 */
    const before = beforeFromDrop(ids, 'p1', true)
    const next = orderAfterDrag(ids, 'p2', before)
    ok(before === 'p2', '相邻下行的落点 = 自己（这就是原位）')
    ok(next.join(',') === ids.join(','), '拖回原位 → 顺序等价（不触发落盘）', next.join(','))
  }
}
