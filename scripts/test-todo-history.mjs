/**
 * 历史任务快照归并（src/main/todo-snapshots.ts）的纯逻辑测试。
 *
 * 背景（用户报「历史任务还是很杂乱」）：
 *   left-info-panel 在一轮里会随进度反复写快照（0/6 → 1/7 → 7/7），
 *   旧逻辑只去掉“相邻完全相同”的，于是同一轮还是留下好几根任务栏。
 * 现在：一轮只留**最终态**；相邻轮次内容相同再合并。
 */

export async function runTodoHistoryTests(ok) {
  const { todoSnapshotsFromEntries, sameTodos } = await import('../out/test/todo-snapshots.mjs')

  const user = (n) => ({ type: 'message', message: { role: 'user' }, id: `u${n}` })
  const asst = (n) => ({ type: 'message', message: { role: 'assistant' }, id: `a${n}` })
  const snap = (id, todos, customType = 'left-panel-tasks') => ({
    type: 'custom',
    customType,
    id,
    data: { todos }
  })
  const T = (text, done = false) => ({ text, done })

  console.log('\n--- 历史任务快照归并 ---')

  // 1. 一轮里写了多个进度版本 → 只留最后那个
  {
    const entries = [
      user(1),
      snap('s1', [T('甲'), T('乙')]),
      snap('s2', [T('甲', true), T('乙')]),
      snap('s3', [T('甲', true), T('乙', true)])
    ]
    const out = todoSnapshotsFromEntries(entries)
    ok(out.length === 1, '一轮只出一份历史', `实际 ${out.length}`)
    ok(out[0].round === 1, '轮次 = 1')
    ok(out[0].todos.every((t) => t.done), '保留的是该轮的最终态（都已完成）')
    ok(out[0].id === 's3', '保留最后一个快照')
  }

  // 2. 两轮、内容不同 → 两份历史，轮次升序
  {
    const entries = [
      user(1),
      snap('a', [T('甲')]),
      asst(1),
      user(2),
      snap('b', [T('乙')]),
      snap('c', [T('乙'), T('丙')])
    ]
    const out = todoSnapshotsFromEntries(entries)
    ok(out.length === 2, '两轮出两份历史', `实际 ${out.length}`)
    ok(out[0].round === 1 && out[1].round === 2, '轮次升序')
    ok(out[1].todos.length === 2, '第 2 轮保留最终态（2 项）')
  }

  // 3. 两轮内容完全一样 → 合并成一份，保留更近的那轮
  {
    const entries = [
      user(1),
      snap('a', [T('甲'), T('乙')]),
      asst(1),
      user(2),
      snap('b', [T('甲'), T('乙')])
    ]
    const out = todoSnapshotsFromEntries(entries)
    ok(out.length === 1, '内容未变的相邻轮次合并成一份', `实际 ${out.length}`)
    ok(out[0].round === 2, '保留更近的轮次（跳转落到最近一次）')
    ok(out[0].id === 'b', '保留更近的快照')
  }

  // 4. 非任务 custom entry 与空清单要忽略
  {
    const entries = [
      user(1),
      snap('x', [T('甲')], 'something-else'),
      { type: 'custom', customType: 'panel_todos', id: 'y', data: { todos: [] } },
      snap('z', [T('甲')])
    ]
    const out = todoSnapshotsFromEntries(entries)
    ok(out.length === 1 && out[0].id === 'z', '只认任务 customType、跳过空清单')
  }

  // 5. sameTodos 的边界
  {
    ok(sameTodos([T('甲')], [T('甲')]), 'sameTodos：相同为 true')
    ok(!sameTodos([T('甲')], [T('甲', true)]), 'sameTodos：完成态不同为 false')
    ok(!sameTodos([T('甲')], [T('乙')]), 'sameTodos：文字不同为 false')
    ok(!sameTodos([T('甲')], [T('甲'), T('乙')]), 'sameTodos：长度不同为 false')
  }
}
