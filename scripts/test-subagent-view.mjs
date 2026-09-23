/** 子代理运行选择与归属（实施-11 H-10a）的纯函数测试。 */
export async function runSubagentViewTests(ok) {
  const { dedupeRuns, selectSubagentRuns, subagentTabId } = await import('../out/test/subagent-view.mjs')

  console.log('\n--- H-10a 子代理运行归属 ---')
  const run = (id, extra = {}) => ({
    id,
    task: id,
    cwd: '/x',
    isolation: 'worktree',
    status: 'running',
    startedAt: 1,
    transcript: [],
    review: 'none',
    ...extra
  })

  const runs = [
    run('a', { parentSessionId: 'S', parentMessageId: 'm1' }),
    run('b', { parentSessionId: 'S' }),
    run('c', { parentSessionId: 'OTHER' }),
    run('d'),
    /* 同一个 run 的两次推送：只保留最后一份 */
    run('a', { parentSessionId: 'S', parentMessageId: 'm1', status: 'done' })
  ]

  const groups = selectSubagentRuns(runs, { sessionIds: ['S'] })
  ok(groups.attached.length === 1 && groups.attached[0].id === 'a', '挂回助手消息的归 attached')
  ok(groups.detached.length === 1 && groups.detached[0].id === 'b', '独立任务归 detached')
  ok(groups.foreign.length === 1 && groups.foreign[0].id === 'c', '别的会话的任务归 foreign，不混进当前会话')
  ok(groups.unattributed.length === 1 && groups.unattributed[0].id === 'd', '没有归属字段的旧记录不猜归属')
  ok(groups.all.length === 2, '当前会话任务 = attached + detached')
  ok(dedupeRuns(runs).filter((r) => r.id === 'a').length === 1, '同一 runId 只保留一份')
  ok(groups.all.find((r) => r.id === 'a')?.status === 'done', '去重保留最后一次推送的状态')
  ok(groups.running === 1, 'running 计数只算当前会话的运行中任务')

  const chainGroups = selectSubagentRuns([run('e', { parentSessionId: 'CHILD' })], { sessionIds: ['S', 'CHILD'] })
  ok(chainGroups.detached.length === 1, '显式会话链里的任务算当前会话')

  ok(subagentTabId('run-7') === 'subagent:run-7', '子代理资源标签身份带 runId')
  const empty = selectSubagentRuns([], { sessionIds: ['S'] })
  ok(empty.all.length === 0 && empty.running === 0, '没有任务时为空且不报错')

  /* 0 / 1 / 20 个任务：计数与去重稳定 */
  const one = selectSubagentRuns([run('only', { parentSessionId: 'S' })], { sessionIds: ['S'] })
  ok(one.all.length === 1 && one.detached.length === 1, '1 个任务时计数为 1')
  const manyRuns = Array.from({ length: 20 }, (_, i) => run(`r${i}`, { parentSessionId: 'S', status: i % 2 === 0 ? 'running' : 'done' }))
  const twenty = selectSubagentRuns(manyRuns, { sessionIds: ['S'] })
  ok(twenty.all.length === 20 && twenty.running === 10, '20 个任务计数与 running 正确')
  const withDuplicate = [...manyRuns, run('r0', { parentSessionId: 'S', status: 'done' })]
  ok(selectSubagentRuns(withDuplicate, { sessionIds: ['S'] }).all.length === 20, '20 个任务重复推送不会变成 21')
}
