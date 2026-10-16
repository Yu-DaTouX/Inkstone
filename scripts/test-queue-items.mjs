function eq(ok, actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, label, a === b ? '' : `实际 ${a} ≠ 期望 ${b}`)
}

export function runQueueItemsTests(ok, { consumeQueuedItem, reclaimedTexts }) {
  const item = (id, text) => ({ id, text })
  const state = (steering, followUp) => ({ steering, followUp })

  {
    const before = state([item('q-1', '插话一'), item('q-2', '插话二')], [item('q-3', '排队一')])
    const after = consumeQueuedItem(before, '插话一')
    ok(!!after, '匹配到插话 → 返回新状态')
    eq(ok, after?.steering.map((i) => i.text), ['插话二'], '只摘掉那一条 steering')
    eq(ok, after?.followUp.map((i) => i.text), ['排队一'], 'followUp 不受影响')
  }

  {
    const before = state([], [item('q-1', '排队一'), item('q-2', '排队二')])
    const after = consumeQueuedItem(before, '排队二')
    eq(ok, after?.followUp.map((i) => i.text), ['排队一'], '从 followUp 里摘掉第二条（不是第一条）')
    eq(ok, after?.steering.length, 0, 'steering 仍为空')
  }

  {
    const before = state([item('q-1', '同一句')], [item('q-2', '同一句')])
    const after = consumeQueuedItem(before, '同一句')
    eq(ok, after?.steering.length, 0, '同文本时先摘 steering')
    eq(ok, after?.followUp.length, 1, 'followUp 里的同文本再等下一次')
  }

  {
    const before = state([], [item('q-1', '再说一次'), item('q-2', '别的'), item('q-3', '再说一次')])
    const after = consumeQueuedItem(before, '再说一次')
    eq(ok, after?.followUp.map((i) => i.id), ['q-2', 'q-3'], '摘掉最靠前的一条，后面的同文本保留')
  }

  {
    const before = state([], [item('q-1', '带空格的插话')])
    eq(ok, consumeQueuedItem(before, '  带空格的插话\n')?.followUp.length, 0, 'trim 后能匹配上')
  }

  {
    const before = state([item('q-1', 'a')], [item('q-2', 'b')])
    eq(ok, consumeQueuedItem(before, '不存在的文本'), null, '没匹配 → null（不推空更新）')
    eq(ok, consumeQueuedItem(before, ''), null, '空文本 → null')
    eq(ok, consumeQueuedItem(before, '   '), null, '纯空白 → null')
    eq(ok, consumeQueuedItem(state([], []), 'a'), null, '两个队列都空 → null')
  }

  {
    const before = state([item('q-1', 'x')], [])
    consumeQueuedItem(before, 'x')
    eq(ok, before.steering.length, 1, '原快照保持不变（避免渲染端拿到同一个引用）')
  }

  eq(ok, reclaimedTexts({ steering: ['a'], followUp: ['b'] }), ['a', 'b'], 'steering 排在 followUp 前面')
  eq(ok, reclaimedTexts({ followUp: ['b'] }), ['b'], '只有 followUp 时也能回收')
  eq(ok, reclaimedTexts({ steering: ['a', '', '   '] }), ['a'], '空/纯空白文本不进草稿')
  eq(ok, reclaimedTexts({}), [], 'pi 说队列空时不凭空造文本')
}
