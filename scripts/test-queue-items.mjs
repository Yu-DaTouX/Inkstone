/**
 * 队列快照的消费/回收规则（D9）。
 *
 * 这些断言盯的是“界面上的排队项什么时候该消失”：pi 只在队列变化时推
 * `queue_update`，而排队项被拿去当普通消息消费时不一定推 —— 主进程必须
 * 用“消息真的出现了”自己摘掉它，否则用户会一直看到「排队中」。
 *
 * 传入的是 esbuild 现场编译出来的 `src/main/queue-items.ts`（见 test-unit.mjs），
 * 所以这里不需要自己 import 源码。
 */

/** 断言相等（只借 test-unit 的 ok 报告，不引入第二套计数） */
function eq(ok, actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(a === b, label, a === b ? '' : `实际 ${a} ≠ 期望 ${b}`)
}

export function runQueueItemsTests(ok, { consumeQueuedItem, reclaimedTexts }) {
  const item = (id, text) => ({ id, text })
  const state = (steering, followUp) => ({ steering, followUp })

  /* ---- 插话先被消费：steering 优先，followUp 不动 ---- */
  {
    const before = state([item('q-1', '插话一'), item('q-2', '插话二')], [item('q-3', '排队一')])
    const after = consumeQueuedItem(before, '插话一')
    ok(!!after, '匹配到插话 → 返回新状态')
    eq(ok, after?.steering.map((i) => i.text), ['插话二'], '只摘掉那一条 steering')
    eq(ok, after?.followUp.map((i) => i.text), ['排队一'], 'followUp 不受影响')
  }

  /* ---- steering 里没有就找 followUp ---- */
  {
    const before = state([], [item('q-1', '排队一'), item('q-2', '排队二')])
    const after = consumeQueuedItem(before, '排队二')
    eq(ok, after?.followUp.map((i) => i.text), ['排队一'], '从 followUp 里摘掉第二条（不是第一条）')
    eq(ok, after?.steering.length, 0, 'steering 仍为空')
  }

  /* ---- steer 与 followUp 有相同文本时，先摘 steering（先被消费的是它） ---- */
  {
    const before = state([item('q-1', '同一句')], [item('q-2', '同一句')])
    const after = consumeQueuedItem(before, '同一句')
    eq(ok, after?.steering.length, 0, '同文本时先摘 steering')
    eq(ok, after?.followUp.length, 1, 'followUp 里的同文本再等下一次')
  }

  /* ---- FIFO：同文本多条只摘第一条 ---- */
  {
    const before = state([], [item('q-1', '再说一次'), item('q-2', '别的'), item('q-3', '再说一次')])
    const after = consumeQueuedItem(before, '再说一次')
    eq(ok, after?.followUp.map((i) => i.id), ['q-2', 'q-3'], '摘掉最靠前的一条，后面的同文本保留')
  }

  /* ---- 前后空白不影响匹配（用户在输入框里可能多打空格） ---- */
  {
    const before = state([], [item('q-1', '带空格的插话')])
    eq(ok, consumeQueuedItem(before, '  带空格的插话\n')?.followUp.length, 0, 'trim 后能匹配上')
  }

  /* ---- 没匹配上 / 空文本：不动队列（返回 null，调用方不推） ---- */
  {
    const before = state([item('q-1', 'a')], [item('q-2', 'b')])
    eq(ok, consumeQueuedItem(before, '不存在的文本'), null, '没匹配 → null（不推空更新）')
    eq(ok, consumeQueuedItem(before, ''), null, '空文本 → null')
    eq(ok, consumeQueuedItem(before, '   '), null, '纯空白 → null')
    eq(ok, consumeQueuedItem(state([], []), 'a'), null, '两个队列都空 → null')
  }

  /* ---- 不可变：原状态不被改写（推送用的是新对象） ---- */
  {
    const before = state([item('q-1', 'x')], [])
    consumeQueuedItem(before, 'x')
    eq(ok, before.steering.length, 1, '原快照保持不变（避免渲染端拿到同一个引用）')
  }

  /* ---- 中止时回收的文本 ---- */
  eq(ok, reclaimedTexts({ steering: ['a'], followUp: ['b'] }), ['a', 'b'], 'steering 排在 followUp 前面')
  eq(ok, reclaimedTexts({ followUp: ['b'] }), ['b'], '只有 followUp 时也能回收')
  eq(ok, reclaimedTexts({ steering: ['a', '', '   '] }), ['a'], '空/纯空白文本不进草稿')
  eq(ok, reclaimedTexts({}), [], 'pi 说队列空时不凭空造文本')
}
