/**
 * 宿主任务服务（`src/main/task-plan-store.ts`，实施-02 S3）的测试。
 *
 * 这一层是**唯一真的写数据的地方**，所以每条断言都要对着**磁盘上的文件**验，
 * 不能只看返回值：返回值说成功而文件没变（或反过来）正是最坏的失败模式。
 *
 * 覆盖 S3 出口的四条性质：只追加 / 同会话串行 / CAS 与幂等靠磁盘 /
 * 落盘失败不得报成功。全部用隔离临时目录，不碰真实用户数据。
 */

export async function runTaskPlanStoreTests(ok) {
  const store = await import('../out/test/task-plan-store.mjs')
  const {
    applyTaskPlanOperation,
    currentTaskPlan,
    readTaskPlanLog,
    taskPlanLogPath,
    TaskPlanStoreError
  } = store
  const { chmod, mkdir, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  console.log('\n--- 宿主任务服务（S3） ---')

  const root = await mkdtemp(join(tmpdir(), 'yan-task-plan-'))
  const dir = join(root, 'task-plans')
  const at = { dir }
  /** 提交一次；失败就抛（正常路径用） */
  const commit = async (sessionId, action, extra = {}, round = 1) => {
    const res = await applyTaskPlanOperation({
      sessionId,
      round,
      request: { action, operationId: `op-${++seq}-${sessionId}`, ...extra },
      opts: at
    })
    if (!res.ok) throw new Error(`意外失败：${res.code} ${res.message}`)
    return res
  }
  let seq = 0

  try {
    /* ============ 1. 空会话 ============ */
    {
      const cur = await currentTaskPlan('empty-session', at)
      ok(cur.state.todos.length === 0 && cur.state.revision === 0, '没写过 → 空计划（revision 0）')
      ok(cur.record === null, '空会话没有记录')
      ok((await readTaskPlanLog('empty-session', at)).length === 0, '文件不存在 → 空日志（不是错误）')
    }

    /* ============ 2. 首次提交真的落盘 ============ */
    {
      const res = await commit('s1', 'set', { items: [{ text: '甲' }, { text: '乙', done: true }] }, 3)
      ok(res.replayed === false, '首次提交不是重放')
      ok(res.state.revision === 1, '首次提交 revision = 1')

      const lines = (await readFile(taskPlanLogPath('s1', dir), 'utf8')).split('\n').filter(Boolean)
      ok(lines.length === 1, `磁盘上多了一行（实际 ${lines.length} 行）`)
      const row = JSON.parse(lines[0])
      ok(row.data?.schemaVersion === 1, '行里带 schemaVersion（漏了读回来会读歪）')
      ok(row.data?.todos?.length === 2 && row.data.todos[1].done === true, '行里是提交后的完整清单')
      ok(row.round === 3, `行里记下了当时的轮次（实际 ${row.round}）`)
      ok(typeof row.at === 'string' && row.at.length > 0, '行里有提交时间（诊断用）')
      ok(row.id === res.state.operationId, '行的 id 就是这次操作的 operationId')
    }

    /* ============ 3. 幂等：同一 operationId 重放 ============ */
    {
      const first = await commit('s2', 'add', { items: [{ text: '唯一' }] })
      const replay = await applyTaskPlanOperation({
        sessionId: 's2',
        round: 1,
        request: { action: 'add', items: [{ text: '唯一' }], operationId: first.state.operationId },
        opts: at
      })
      ok(replay.ok && replay.replayed === true, '同 operationId 重放被识别')
      ok(replay.ok && replay.changed.length === 0, '重放回的 changed 为空（没有真的再改一次）')
      ok(replay.ok && replay.state.revision === first.state.revision, '重放不涨 revision')
      const lines = (await readFile(taskPlanLogPath('s2', dir), 'utf8')).split('\n').filter(Boolean)
      ok(lines.length === 1, `重放没有多写一行（实际 ${lines.length} 行）`)
      const todos = (await currentTaskPlan('s2', at)).state.todos
      ok(todos.length === 1, `重放没有重复 add（清单仍是 1 项，实际 ${todos.length}）`)
    }

    /* ============ 4. 同一会话串行（两次快速 add 不互相覆盖） ============ */
    {
      const [a, b] = await Promise.all([
        applyTaskPlanOperation({
          sessionId: 's3',
          round: 1,
          request: { action: 'add', items: [{ text: '第一个' }], operationId: 'op-s3-a' },
          opts: at
        }),
        applyTaskPlanOperation({
          sessionId: 's3',
          round: 1,
          request: { action: 'add', items: [{ text: '第二个' }], operationId: 'op-s3-b' },
          opts: at
        })
      ])
      ok(a.ok && b.ok, '两次并发提交都成功')
      ok(
        a.ok && b.ok && new Set([a.state.revision, b.state.revision]).size === 2,
        '两次提交拿到**不同** revision（说明第二个读到了第一个的结果）'
      )
      const todos = (await currentTaskPlan('s3', at)).state.todos
      ok(todos.length === 2, `清单是 2 项（漏了串行会只剩 1 项，实际 ${todos.length}）`)
      const lines = (await readFile(taskPlanLogPath('s3', dir), 'utf8')).split('\n').filter(Boolean)
      ok(lines.length === 2, '两次提交写了两行')
    }

    /* ============ 5. 失败即不动（越界不得改状态） ============ */
    {
      const before = await readFile(taskPlanLogPath('s3', dir), 'utf8')
      const bad = await applyTaskPlanOperation({
        sessionId: 's3',
        round: 1,
        request: { action: 'complete', index: 99, operationId: 'op-s3-bad' },
        opts: at
      })
      ok(!bad.ok && bad.code === 'index_out_of_range', '越界被拒（可读错误码）')
      ok((await readFile(taskPlanLogPath('s3', dir), 'utf8')) === before, '失败后文件一个字节没变')
      ok((await currentTaskPlan('s3', at)).state.revision === 2, '失败不涨 revision')
    }

    /* ============ 6. 只追加：新提交不重写已有行 ============ */
    {
      const before = await readFile(taskPlanLogPath('s3', dir), 'utf8')
      await commit('s3', 'complete', { index: 1 })
      const after = await readFile(taskPlanLogPath('s3', dir), 'utf8')
      ok(after.startsWith(before), '旧内容作为前缀逐字节保留（只追加）')
      ok(after.length > before.length, '文件确实变长了')
    }

    /* ============ 7. 坏行宽容：一行坏数据不该让整份历史消失 ============ */
    {
      const path = taskPlanLogPath('s4', dir)
      await commit('s4', 'add', { items: [{ text: '好行' }] })
      const good = await readFile(path, 'utf8')
      await writeFile(
        path,
        good + '{ 这不是 JSON\n' + '{"id":"x","data":{"todos":"不是数组"}}\n' + good.split('\n')[0] + '\n',
        'utf8'
      )
      const records = await readTaskPlanLog('s4', at)
      ok(records.length === 2, `坏行被跳过、好行都读回（实际 ${records.length} 条）`)
      const cur = await currentTaskPlan('s4', at)
      ok(cur.state.todos.length === 1 && cur.state.todos[0].text === '好行', '当前状态仍读得出来')
      const next = await commit('s4', 'add', { items: [{ text: '接着写' }] })
      ok(next.state.revision === 2, `坏行不影响 revision 递增（实际 ${next.state.revision}）`)
    }

    /* ============ 8. 会话隔离 ============ */
    {
      await commit('s5-a', 'add', { items: [{ text: 'A 的' }] })
      await commit('s5-b', 'add', { items: [{ text: 'B 的' }] })
      const a = (await currentTaskPlan('s5-a', at)).state.todos
      const b = (await currentTaskPlan('s5-b', at)).state.todos
      ok(a.length === 1 && a[0].text === 'A 的', 'A 会话读到自己的清单')
      ok(b.length === 1 && b[0].text === 'B 的', 'B 会话读到自己的清单（没有串数据）')
      ok(
        taskPlanLogPath('s5-a', dir) !== taskPlanLogPath('s5-b', dir),
        '两个会话各写一个文件'
      )
    }

    /* ============ 9. 落盘失败不得报成功 ============ */
    {
      const path = taskPlanLogPath('s6', dir)
      await commit('s6', 'add', { items: [{ text: '先写成功' }] })
      const before = await readFile(path, 'utf8')
      await chmod(path, 0o444)
      let caught = null
      try {
        await commit('s6', 'add', { items: [{ text: '写不进去' }] })
      } catch (err) {
        caught = err
      }
      ok(
        caught instanceof TaskPlanStoreError && caught.code === 'write_failed',
        `写不进去时报 write_failed（实际 ${caught ? caught.code : '没报错'}）`
      )
      ok((await readFile(path, 'utf8')) === before, '失败后文件内容没变')
      await chmod(path, 0o666)

      /* 回读也失败（把日志路径换成目录）→ 必须报错，不能当成「空清单」 */
      await mkdir(join(dir, 's7.jsonl'), { recursive: true })
      let readCaught = null
      try {
        await currentTaskPlan('s7', at)
      } catch (err) {
        readCaught = err
      }
      ok(
        readCaught instanceof TaskPlanStoreError && readCaught.code === 'read_failed',
        `读不了时报 read_failed（不能退化成空清单）`
      )
    }

    /* ============ 10. 非法会话 id 不进文件名 ============ */
    {
      let caught = null
      try {
        await currentTaskPlan('../逃逸', at)
      } catch (err) {
        caught = err
      }
      ok(
        caught instanceof TaskPlanStoreError && caught.code === 'bad_session_id',
        '带路径分隔符的会话 id 被拒（不写到别的目录去）'
      )
      let caught2 = null
      try {
        await currentTaskPlan('pending:runner-1', at)
      } catch (err) {
        caught2 = err
      }
      ok(
        caught2 instanceof TaskPlanStoreError && caught2.code === 'bad_session_id',
        '会话就绪前的 pending id 被拒（那份清单不知道该属于谁）'
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
