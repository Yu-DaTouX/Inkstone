/**
 * 任务计划的纯逻辑（`src/shared/task-plan.ts`，实施-02 S2）测试。
 *
 * 这一层是「不可信输入 → 确定状态」的唯一入口：`yan tasks apply` 的参数、
 * 模型的六种操作、历史载荷的读取都经过它。所以断言要同时覆盖
 * **正常路径**与**失败路径下的「状态一个字节都不能动」**。
 *
 * 末节真的落盘（临时文件）—— 写入方在 S3，但「写出去的东西读不回来」
 * 是最难查的那类错，先把文件往返钉在纯逻辑层。
 */

export async function runTaskPlanTests(ok) {
  const TP = await import('../out/test/task-plan.mjs')
  const {
    applyTaskRequest,
    emptyTaskPlan,
    normalizeTaskItems,
    normalizeTaskStatus,
    parseRequestItems,
    readTaskPlanEntry,
    toTaskPlanEntryData,
    TASK_PLAN_CUSTOM_TYPE,
    validateTaskRequest,
    TASK_PLAN_LIMITS,
    TASK_PLAN_SCHEMA_VERSION
  } = TP

  console.log('\n--- 任务计划纯逻辑（S2） ---')

  const T = (text, done = false) => ({ text, done })
  const state = (todos, revision = 0, operationId = null) => ({ todos, revision, operationId })
  /** 应用一次请求，失败就直接抛（正常路径用） */
  const apply = (prev, req) => {
    const res = applyTaskRequest(prev, { operationId: `op${++seq}`, ...req })
    if (!res.ok) throw new Error(`意外失败：${res.code} ${res.message}`)
    return res
  }
  let seq = 0

  /* ============ 1. 六个操作 ============ */
  {
    const set = apply(emptyTaskPlan(), { action: 'set', items: [T('甲'), T('乙', true)] })
    ok(set.state.todos.length === 2, 'set：写入两项')
    ok(set.state.todos[1].done === true, 'set：done 原样保留')
    ok(set.changed[0]?.kind === 'replaced', 'set：回执照实说 replaced')
    ok(set.state.revision === 1, 'set：revision 1（首次提交）')

    const add = apply(set.state, { action: 'add', items: [T('丙')] })
    ok(add.state.todos.length === 3 && add.state.todos[2].text === '丙', 'add：追加到尾部')
    ok(add.changed[0]?.kind === 'added' && add.changed[0]?.index === 3, 'add：回执给出 1-based 序号')
    ok(add.state.todos[0].text === '甲', 'add：原有顺序不变')

    const done1 = apply(add.state, { action: 'complete', index: 1 })
    ok(done1.state.todos[0].done === true, 'complete：勾上第一项')
    ok(done1.state.todos[0].status === 'done', 'complete：status 同步为 done')
    ok(done1.changed[0]?.kind === 'completed' && done1.changed[0]?.index === 1, 'complete：回执')

    const undone = apply(done1.state, { action: 'uncomplete', index: 1 })
    ok(undone.state.todos[0].done === false, 'uncomplete：取消勾选')
    ok(undone.state.todos[0].status === 'pending', 'uncomplete：status 回到 pending（不留 running/done）')

    const removed = apply(undone.state, { action: 'remove', index: 2 })
    ok(removed.state.todos.length === 2, 'remove：数量减一')
    ok(removed.state.todos.map((t) => t.text).join(',') === '甲,丙', 'remove：删的是第 2 项')
    ok(removed.changed[0]?.kind === 'removed' && removed.changed[0]?.text === '乙', 'remove：回执带上被删的文字')

    const cleared = apply(removed.state, { action: 'clear' })
    ok(cleared.state.todos.length === 0, 'clear：清空')
    ok(cleared.state.revision === removed.state.revision + 1, 'clear：也是新提交（revision 涨）')
  }

  /* ============ 2. 空数组与空列表 ============ */
  {
    const prev = apply(emptyTaskPlan(), { action: 'set', items: [T('甲')] }).state
    const cleared = apply(prev, { action: 'set', items: [] })
    ok(cleared.state.todos.length === 0, 'set []：明确等同清空')

    const bad = applyTaskRequest(prev, { action: 'add', items: [], operationId: 'empty-add' })
    ok(!bad.ok && bad.code === 'empty_add', 'add []：拒绝（多半是漏了参数）')
    ok(bad.ok === false && bad.message.length > 0, 'add []：给出可读原因')

    const onEmpty = emptyTaskPlan()
    const clearEmpty = apply(onEmpty, { action: 'clear' })
    ok(clearEmpty.ok && clearEmpty.state.todos.length === 0, '空列表上 clear：成功且仍是空')

    const doneEmpty = applyTaskRequest(onEmpty, { action: 'complete', index: 1, operationId: 'e1' })
    ok(!doneEmpty.ok && doneEmpty.code === 'index_out_of_range', '空列表上 complete：越界错误（不是崩溃）')
    const rmEmpty = applyTaskRequest(onEmpty, { action: 'remove', index: 1, operationId: 'e2' })
    ok(!rmEmpty.ok && rmEmpty.code === 'index_out_of_range', '空列表上 remove：越界错误')
  }

  /* ============ 3. 非法输入：一律不修改状态 ============ */
  {
    const prev = apply(emptyTaskPlan(), { action: 'set', items: [T('甲'), T('乙')] }).state
    const snapshot = JSON.stringify(prev)
    const cases = [
      [{ action: 'set', items: 'not-an-array' }, 'bad_items', 'items 不是数组'],
      [{ action: 'set', items: [null] }, 'bad_items', '项不是对象'],
      [{ action: 'set', items: [['甲']] }, 'bad_items', '项是数组'],
      [{ action: 'set', items: [{ text: 123 }] }, 'empty_text', 'text 不是字符串'],
      [{ action: 'set', items: [{ text: '   ' }] }, 'empty_text', 'text 只有空白'],
      [{ action: 'set', items: [{ text: '甲', done: 'true' }] }, 'bad_done', 'done 不是 boolean'],
      [{ action: 'set', items: [{ text: 'x'.repeat(TASK_PLAN_LIMITS.maxTextLength + 1) }] }, 'text_too_long', '单项超长'],
      [{ action: 'complete', index: 0 }, 'bad_index', 'index 0'],
      [{ action: 'complete', index: -1 }, 'bad_index', 'index 负数'],
      [{ action: 'complete', index: 1.5 }, 'bad_index', 'index 小数'],
      [{ action: 'complete', index: '1' }, 'bad_index', 'index 是字符串'],
      [{ action: 'complete', index: 3 }, 'index_out_of_range', 'index 越界'],
      [{ action: 'remove', index: 99 }, 'index_out_of_range', 'remove 越界'],
      [{ action: 'explode' }, 'unknown_action', '未知操作']
    ]
    let allRejected = true
    let allUnchanged = true
    for (const [req, code, label] of cases) {
      const res = applyTaskRequest(prev, { operationId: `bad${++seq}`, ...req })
      if (res.ok || res.code !== code) {
        allRejected = false
        console.log(`  ✗ ${label}：期望 ${code}，实际 ${res.ok ? '成功' : res.code}`)
      }
      if (JSON.stringify(prev) !== snapshot) allUnchanged = false
    }
    ok(allRejected, `14 类非法输入全部被拒（且错误码正确）`)
    ok(allUnchanged, '非法输入没有修改状态（不变式 ②）')

    const noId = applyTaskRequest(prev, { action: 'clear', operationId: '' })
    ok(!noId.ok && noId.code === 'missing_operation_id', '缺少 operationId 被拒（幂等靠它）')
    const noId2 = applyTaskRequest(prev, { action: 'clear' })
    ok(!noId2.ok && noId2.code === 'missing_operation_id', '完全没传 operationId 同样被拒')
  }

  /* ============ 4. 上限（不静默截断） ============ */
  {
    const max = TASK_PLAN_LIMITS.maxItems
    const many = Array.from({ length: max }, (_, i) => T(`任务 ${i + 1}`))
    const atLimit = applyTaskRequest(emptyTaskPlan(), { action: 'set', items: many, operationId: 'm1' })
    ok(atLimit.ok && atLimit.state.todos.length === max, `正好 ${max} 项：允许`)

    const over = applyTaskRequest(emptyTaskPlan(), {
      action: 'set',
      items: [...many, T('第 201 项')],
      operationId: 'm2'
    })
    ok(!over.ok && over.code === 'too_many_items', `set ${max + 1} 项：拒绝`)
    ok(over.ok === false && over.message.includes(String(max + 1)), '错误消息里说了实际会变成多少项')

    const addOver = applyTaskRequest(atLimit.state, { action: 'add', items: [T('溢出')], operationId: 'm3' })
    ok(!addOver.ok && addOver.code === 'too_many_items', 'add 撑破上限：拒绝（不是截断）')
    ok(atLimit.state.todos.length === max, '被拒的 add 没有改动清单')

    /* 恰好 2000 字符（按 code point 数），以及 emoji 不能被当成两个字符 */
    const exact = '好'.repeat(TASK_PLAN_LIMITS.maxTextLength)
    const exactOk = applyTaskRequest(emptyTaskPlan(), {
      action: 'set',
      items: [{ text: exact }],
      operationId: 'm4'
    })
    ok(exactOk.ok, '正好 2000 个字符：允许')
    const emoji = '👍'.repeat(TASK_PLAN_LIMITS.maxTextLength)
    const emojiOk = applyTaskRequest(emptyTaskPlan(), {
      action: 'set',
      items: [{ text: emoji }],
      operationId: 'm5'
    })
    ok(emojiOk.ok, '2000 个 emoji：按 code point 数（UTF-16 长度 4000 也允许）')
    const emojiOver = applyTaskRequest(emptyTaskPlan(), {
      action: 'set',
      items: [{ text: '👍'.repeat(TASK_PLAN_LIMITS.maxTextLength + 1) }],
      operationId: 'm6'
    })
    ok(!emojiOver.ok && emojiOver.code === 'text_too_long', '2001 个 emoji：拒绝')
  }

  /* ============ 5. revision 与幂等 ============ */
  {
    let st = emptyTaskPlan()
    ok(st.revision === 0 && st.operationId === null, '初始状态：revision 0 / 没有 operationId')
    const r1 = applyTaskRequest(st, { action: 'set', items: [T('甲')], operationId: 'same' })
    ok(r1.ok && r1.state.revision === 1 && r1.replayed === false, '第一次提交：revision 1')
    const again = applyTaskRequest(r1.state, { action: 'add', items: [T('乙')], operationId: 'same' })
    ok(again.ok && again.replayed === true, '同一 operationId 重放：标记 replayed')
    ok(again.ok && again.state.todos.length === 1, '重放不重复 add（清单仍是 1 项）')
    ok(again.ok && again.state === r1.state, '重放原样返回上一次的状态（没有新对象）')
    ok(again.ok && again.changed.length === 0, '重放没有「实际变更项」')

    const other = applyTaskRequest(again.state, { action: 'add', items: [T('乙')], operationId: 'different' })
    ok(other.ok && other.state.todos.length === 2, '换个 operationId：真的执行（2 项）')
    ok(other.ok && other.state.revision === 2, '新提交：revision 2')

    const failed = applyTaskRequest(other.state, { action: 'complete', index: 99, operationId: 'f1' })
    ok(!failed.ok, '越界失败')
    const afterFail = applyTaskRequest(other.state, { action: 'add', items: [T('丙')], operationId: 'f2' })
    ok(afterFail.ok && afterFail.state.revision === 3, '失败不涨 revision（3 = 2 + 1）')
  }

  /* ============ 6. 不变性：不修改入参 ============ */
  {
    const prev = Object.freeze({
      todos: Object.freeze([Object.freeze(T('甲')), Object.freeze(T('乙'))]),
      revision: 0,
      operationId: null
    })
    const snapshot = JSON.stringify(prev)
    const req = Object.freeze({ action: 'add', items: Object.freeze([Object.freeze(T('丙'))]), operationId: 'imm' })
    const res = applyTaskRequest(prev, req)
    ok(res.ok, '冻结的入参也能正常执行（没有原地修改）')
    ok(JSON.stringify(prev) === snapshot, '执行后入参逐字段不变')
    ok(res.ok && res.state.todos !== prev.todos, '返回的是新数组（不复用入参引用）')
    ok(res.ok && res.state.todos.length === 3 && prev.todos.length === 2, '入参清单仍是 2 项')

    const src = [{ text: '甲' }]
    const parsed = parseRequestItems(src)
    src[0].text = '改了'
    ok(parsed.ok && parsed.items[0].text === '甲', '校验结果不复用请求里的对象（调用方改写不会反向污染）')
  }

  /* ============ 7. 校验与 reducer 的口径一致 ============ */
  {
    const st = state([T('甲')], 3, 'prev-op')
    ok(validateTaskRequest({ action: 'clear', operationId: 'x' }, st).ok, 'validate：clear 合法')
    const bad = validateTaskRequest({ action: 'complete', index: 5, operationId: 'x' }, st)
    ok(!bad.ok && bad.code === 'index_out_of_range', 'validate 与 reducer 用同一套越界判据')
    const range = TP.validateTaskRequest({ action: 'add', items: [T('乙')], operationId: 'x' }, {
      todos: Array.from({ length: TASK_PLAN_LIMITS.maxItems }, (_, i) => T(`t${i}`)),
      revision: 1,
      operationId: null
    })
    ok(!range.ok && range.code === 'too_many_items', 'validate 也检查 add 后的总数')
  }

  /* ============ 8. 历史解析（旧载荷 / 宿主载荷） ============ */
  {
    const legacy = readTaskPlanEntry({
      todos: [
        { text: '甲', done: true },
        { text: '乙', done: false, status: 'in_progress' },
        { text: '', done: false },
        null
      ]
    })
    ok(!!legacy, '旧载荷能读出来')
    ok(legacy.schemaVersion === 0, '旧载荷的 schemaVersion 记为 0（宿主写入之前的世界）')
    ok(legacy.revision === 0 && legacy.operationId === null, '旧载荷没有 revision / operationId')
    ok(legacy.todos.length === 2, '旧载荷里的坏项被丢掉（不是丢掉整份历史）')
    ok(legacy.todos[1].status === 'running', '旧载荷的状态别名照旧认（in_progress → running）')

    const host = readTaskPlanEntry({
      schemaVersion: TASK_PLAN_SCHEMA_VERSION,
      revision: 7,
      operationId: 'op-7',
      todos: [{ text: '丙', done: false }]
    })
    ok(!!host && host.revision === 7 && host.operationId === 'op-7', '宿主载荷读出 revision / operationId')
    ok(host.schemaVersion === TASK_PLAN_SCHEMA_VERSION, '宿主载荷版本号原样')

    ok(readTaskPlanEntry({ schemaVersion: 999, todos: [] }) === undefined, '版本不认识：读不了就当没有')
    ok(readTaskPlanEntry({ schemaVersion: 2, todos: [{ text: '甲' }] }) === undefined, '未来版本同样拒绝')
    ok(readTaskPlanEntry({ todos: 'nope' }) === undefined, 'todos 不是数组：拒绝')
    ok(readTaskPlanEntry(null) === undefined, 'data 不是对象：拒绝')
    ok(readTaskPlanEntry({}) === undefined, '没有 todos 字段：拒绝')

    const weird = readTaskPlanEntry({ revision: -5, operationId: '  ', todos: [{ text: '甲' }] })
    ok(!!weird && weird.revision === 0 && weird.operationId === null, 'revision 非法 / operationId 是空白：退回默认值')

    /* 往返：写出去的东西必须读得回来（S3 的写入方靠这个） */
    const round = toTaskPlanEntryData(state([T('甲', true)], 4, 'op-round'))
    const back = readTaskPlanEntry(round)
    ok(!!back && back.revision === 4 && back.operationId === 'op-round', 'toTaskPlanEntryData → read 往返一致')
    ok(back.todos.length === 1 && back.todos[0].done === true, '往返后清单内容一致')
    ok(round.schemaVersion === TASK_PLAN_SCHEMA_VERSION, '写出去的载荷带版本号（漏了会让读回来读歪）')
  }

  /* ============ 9. 规范化工具（历史宽容路径） ============ */
  {
    ok(normalizeTaskStatus('IN-PROGRESS') === 'running', "normalizeTaskStatus：'IN-PROGRESS'")
    ok(normalizeTaskStatus(' Doing ') === 'running', "normalizeTaskStatus：' Doing '")
    ok(normalizeTaskStatus('nope') === undefined, 'normalizeTaskStatus：认不出回 undefined（不猜）')
    ok(normalizeTaskStatus(3) === undefined, 'normalizeTaskStatus：非字符串回 undefined')

    const items = normalizeTaskItems([
      { text: '甲', done: false, status: 'doing' },
      { text: '乙', done: true, status: 'running' },
      { text: '丙' },
      { text: '' },
      'junk'
    ])
    ok(items.length === 3, 'normalizeTaskItems：坏项丢掉，好的留下')
    ok(items[0].status === 'running', 'normalizeTaskItems：别名生效')
    ok(items[1].done === true && items[1].status === 'done', 'normalizeTaskItems：done 与 status 冲突时以完成为准')
    ok(items[2].status === undefined, 'normalizeTaskItems：没有显式状态就不带 status')
    ok(normalizeTaskItems('nope').length === 0, 'normalizeTaskItems：非数组回空')
  }

  /* ============ 10. 真实文件往返（会话 JSONL 的形状） ============ */
  /*
   * 前九节都在内存里。这一节真的落盘：把一个「旧扩展写的会话」读到状态、
   * 应用一次操作、把新载荷写进**另一个文件**再读回来。
   * 为什么值得：S3 的写入方就沿这条路径（写出去的东西读不回来是最难查的那类错），
   * 顺带把单写者原则钉在文件层 —— 旧文件一个字节都不许动。
   */
  {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'yan-taskplan-'))
    try {
      const legacyFile = join(dir, 'legacy.jsonl')
      const hostFile = join(dir, 'host.jsonl')
      const entries = [
        { type: 'session', version: 3, id: 's1' },
        { type: 'message', id: 'm0', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        {
          type: 'custom',
          id: 'c1',
          customType: 'left-panel-tasks',
          data: { todos: [{ text: '旧甲', done: true }, { text: '旧乙' }] }
        }
      ]
      const serialize = (list) => list.map((e) => JSON.stringify(e)).join('\n') + '\n'
      await writeFile(legacyFile, serialize(entries), 'utf8')

      const lines = (await readFile(legacyFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const legacy = readTaskPlanEntry(lines.find((e) => e.customType === 'left-panel-tasks').data)
      ok(legacy.todos.length === 2 && legacy.revision === 0, '真实 JSONL 文件里读回旧历史（revision 0）')

      const applied = apply({ todos: legacy.todos, revision: legacy.revision, operationId: legacy.operationId }, {
        action: 'add',
        items: [{ text: '宿主新增' }]
      })
      await writeFile(
        hostFile,
        serialize([...lines, { type: 'custom', id: 'c2', customType: 'yan-task-plan', data: toTaskPlanEntryData(applied.state) }]),
        'utf8'
      )

      const hostLines = (await readFile(hostFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const hostEntry = hostLines.filter((e) => e.customType === 'yan-task-plan').pop()
      const back = readTaskPlanEntry(hostEntry.data)
      ok(back.todos.length === 3 && back.todos[2].text === '宿主新增', '写回新文件后读回：三项内容一致')
      ok(back.revision === 1, '读回 revision = 1')
      ok(back.operationId === applied.state.operationId, '读回 operationId（幂等靠它）')
      ok(
        (await readFile(legacyFile, 'utf8')) === serialize(entries),
        '旧会话文件逐字节未动（单写者原则）'
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /*
   * 11. 宿主任务日志行（S3 写入侧的形状）。
   *
   * 这一段钉的是「宿主日志与旧条目走同一套归并」的前提：
   * 行能往返、能变成条目形状；坏行/对不上版本的行**单独丢掉**，
   * 而不是让它把整份历史带崩。
   */
  {
    const { parseTaskPlanLogLine, serializeTaskPlanLogRecord, taskPlanLogEntry } = TP
    const applied = apply(emptyTaskPlan(), { action: 'set', items: [T('甲'), T('乙')] })
    const record = {
      id: applied.state.operationId,
      round: 4,
      at: '2026-09-18T00:00:00.000Z',
      data: toTaskPlanEntryData(applied.state)
    }
    const line = serializeTaskPlanLogRecord(record)
    ok(!line.includes('\n'), '一行一条（序列化不带换行）')
    const back = parseTaskPlanLogLine(line)
    ok(back?.round === 4 && back?.id === record.id, '行往返：id / round 一致')
    const state = readTaskPlanEntry(back.data)
    ok(state.todos.length === 2 && state.revision === 1, '行往返：清单与 revision 一致')

    ok(parseTaskPlanLogLine('') === undefined, '空行不算一行数据')
    ok(parseTaskPlanLogLine('   ') === undefined, '只有空白的行不算一行数据')
    ok(parseTaskPlanLogLine('{坏') === undefined, '坏 JSON 被跳过（一行坏数据不该毁掉整份历史）')
    ok(parseTaskPlanLogLine('{"data":{"todos":"不是数组"}}') === undefined, '认不出的 data 被跳过')
    ok(
      parseTaskPlanLogLine('{"data":{"schemaVersion":9,"todos":[]}}') === undefined,
      '版本对不上的行被跳过（不拿旧规则猜新格式）'
    )

    const lax = parseTaskPlanLogLine(JSON.stringify({ data: toTaskPlanEntryData(applied.state) }))
    ok(lax?.round === 1, '没写 round 的行按第 1 轮处理')
    ok(lax?.id === '', '没写 id 的行回空串（界面另有 key 兜底）')

    const entry = taskPlanLogEntry(record)
    ok(
      entry.customType === TASK_PLAN_CUSTOM_TYPE && entry.round === 4,
      '日志行 → 条目形状（带轮次，喂给同一套历史归并）'
    )
  }
}
