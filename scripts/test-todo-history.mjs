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
    /*
     * status 不参与比较：一轮里 `pending → running` 只是进度变化，
     * 清单本身没变 —— 算成新历史的话，同一个计划会冒出好几份。
     */
    ok(
      sameTodos([{ text: '甲', done: false, status: 'pending' }], [{ text: '甲', done: false, status: 'running' }]),
      'sameTodos：只看清单内容（status 变化不算新历史）'
    )
  }

  /*
   * 6. 显式 status（方案 4.5）。
   *
   * 写清单的是 pi 侧的**扩展**，字段名不归我们管 —— 所以用别名表认，
   * 认不出来就当「没有显式状态」（退回 `done`），**不猜**。
   */
  {
    const entries = [
      user(1),
      snap('s1', [
        { text: '甲', done: false, status: 'in_progress' },
        { text: '乙', done: false, status: 'pending' },
        { text: '丙', done: true, status: 'completed' },
        { text: '丁', done: false, status: 'not-a-real-status' },
        { text: '戊', done: false },
        { text: '己', done: true, status: 'running' }
      ])
    ]
    const out = todoSnapshotsFromEntries(entries)
    const t = out[0]?.todos ?? []
    ok(t[0]?.status === 'running' && t[0].done === false, 'in_progress → running（且不算完成）')
    ok(t[1]?.status === 'pending', 'pending 原样保留')
    ok(t[2]?.status === 'done' && t[2].done === true, 'completed → done')
    ok(t[3]?.status === undefined && t[3].done === false, '认不出的状态不带 status（宁可不猜）')
    ok(t[4]?.status === undefined, '老数据（没有 status）保持原样')
    ok(t[5]?.status === 'done' && t[5].done === true, 'done 与 status=running 冲突时以完成为准')
  }

  // 7. 别名：大小写 / 连字符 / 空格都该认
  {
    const out = todoSnapshotsFromEntries([
      user(1),
      snap('s1', [
        { text: '甲', done: false, status: 'IN-PROGRESS' },
        { text: '乙', done: false, status: ' Doing ' }
      ])
    ])
    ok(out[0]?.todos[0]?.status === 'running', `'IN-PROGRESS' → running`)
    ok(out[0]?.todos[1]?.status === 'running', `' Doing ' → running`)
  }

  /*
   * 8. 来源白名单与单写者优先（实施-02 S1 契约定稿）。
   *
   * 旧实现用 `/task|todo/i` 认身份 —— 任何名叫 `my-task-log` 的 custom entry
   * 只要带 `{todos:[...]}` 就会被当成任务清单显示出来，那不是兼容是冒充。
   */
  {
    const host = (id, todos, extra = {}) => ({
      type: 'custom',
      customType: 'yan-task-plan',
      id,
      data: { schemaVersion: 1, revision: 1, operationId: 'op-' + id, todos, ...extra }
    })

    const others = todoSnapshotsFromEntries([
      user(1),
      { type: 'custom', customType: 'other-task-log', id: 'x', data: { todos: [T('甲')] } },
      { type: 'custom', customType: 'my-todos', id: 'y', data: { todos: [T('乙')] } }
    ])
    ok(others.length === 0, '只认精确标识：第三方 task/todo 命名的条目不算任务')

    const hostOnly = todoSnapshotsFromEntries([user(1), host('h1', [T('甲')])])
    ok(hostOnly.length === 1 && hostOnly[0].todos[0].text === '甲', '宿主日志条目被解析（todos 是兼容字段）')

    /*
     * 同一轮两种来源都写了：**宿主日志优先**，且与落盘先后无关。
     * 「后写的覆盖先写的」在这里不够 —— 宿主与旧扩展是两个进程，
     * 谁先落盘是时序骰子。
     */
    const legacyFirst = todoSnapshotsFromEntries([user(1), snap('l1', [T('旧')]), host('h1', [T('宿主')])])
    ok(
      legacyFirst.length === 1 && legacyFirst[0].todos[0].text === '宿主' && legacyFirst[0].id === 'h1',
      '旧条目在前：宿主日志胜出'
    )
    const hostFirst = todoSnapshotsFromEntries([user(1), host('h1', [T('宿主')]), snap('l1', [T('旧')])])
    ok(hostFirst.length === 1 && hostFirst[0].todos[0].text === '宿主', '旧条目在后：也不会盖掉宿主日志')

    // 不同轮次互不影响（优先只是同一轮内的规则）
    const twoRounds = todoSnapshotsFromEntries([
      user(1),
      snap('l1', [T('第一轮旧')]),
      user(2),
      host('h2', [T('第二轮宿主')])
    ])
    ok(twoRounds.length === 2, '不同轮次各自成一份历史（优先规则不跨轮）')
    ok(twoRounds[0].todos[0].text === '第一轮旧', '第一轮仍是旧条目（该轮没有宿主快照）')
  }

  /*
   * 9. 宿主日志条目自带轮次（实施-02 S3）。
   *
   * 宿主任务日志是**另一个文件**（`YAN_DIR/task-plans/<sessionId>.jsonl`），
   * 里面的行推不出「第几轮」—— 写入时就把当时的轮次记进行里（`taskPlanLogEntry`
   * 把它带进条目）。这里钉两件事：轮次取自记录、**不**被位置覆盖；
   * 与旧条目混在一起时仍然按同一套规则归并。
   */
  {
    const hostRow = (id, round, todos) => ({
      type: 'custom',
      customType: 'yan-task-plan',
      id,
      round,
      data: { schemaVersion: 1, revision: 1, operationId: 'op-' + id, todos }
    })

    const out = todoSnapshotsFromEntries([
      user(1),
      snap('l1', [T('第一轮旧')]),
      user(2),
      hostRow('h2', 2, [T('第二轮宿主')]),
      user(3),
      hostRow('h3', 3, [T('第三轮宿主')])
    ])
    ok(out.length === 3, `旧条目与宿主日志各成一份历史（实际 ${out.length} 份）`)
    ok(out[0].round === 1 && out[0].todos[0].text === '第一轮旧', '旧条目照旧按位置算轮次')
    ok(out[1].round === 2 && out[1].todos[0].text === '第二轮宿主', '宿主条目的轮次取自记录')
    ok(out[2].round === 3, '第三轮也对得上')

    /* 记录里的轮次优先：它们可能不是连续写在一起的（中间切过会话 / 重建过实例） */
    const skewed = todoSnapshotsFromEntries([user(1), hostRow('h9', 5, [T('第五轮')])])
    ok(skewed[0].round === 5, '记录里写的轮次优先（位置推不准的时候不会把它挤成第 1 轮）')

    /* 同一轮两种来源：宿主日志胜出，且只出一份 */
    const mixed = todoSnapshotsFromEntries([
      user(1),
      snap('l1', [T('旧')]),
      hostRow('h1', 1, [T('宿主')])
    ])
    ok(mixed.length === 1 && mixed[0].todos[0].text === '宿主', '同一轮带轮次的宿主日志仍然胜出')
  }
}
