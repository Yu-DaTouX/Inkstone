/**
 * 任务收件箱的单元测试（实施-28 T1）—— 纯投影 + 替身事实源。
 *
 * 重点：
 *   ① 七态映射与优先级（同一会话只出一张卡）；
 *   ② 排序：待审阅 / 等待用户 / 失败排在前面，同档按最近活动；
 *   ③ 缺源降级：某个来源抛错只丢那一项，不丢整张卡、不影响别的会话；
 *   ④ 跨会话隔离：每张卡只带自己的 sessionId；
 *   ⑤ `needs_review` 是**近似**，卡片上必须标出来（不假装精确）。
 */

export async function runTaskInboxTests(ok, mod, serviceMod) {
  const {
    TASK_STATUS_SOURCE,
    projectTaskCard,
    compareTaskCards,
    filterTaskCards,
    inboxCounts,
    actionableCards,
    taskInboxPageQuery
  } = mod
  const { createTaskInboxService } = serviceMod

  const base = { sessionId: 's1', title: '会话一', updatedAt: 1000 }

  /* ---- 契约：七态都有来源说明 ---- */
  {
    const required = ['pending', 'running', 'waiting_user', 'failed', 'needs_review', 'done', 'dismissed']
    ok(required.every((s) => typeof TASK_STATUS_SOURCE[s] === 'string' && TASK_STATUS_SOURCE[s].length > 0), '七态都有事实来源说明')
    ok(/没有精确来源/.test(TASK_STATUS_SOURCE.needs_review), 'needs_review 如实写明没有说话的事实源')
  }

  /* ---- 七态映射 ---- */
  {
    ok(projectTaskCard(base) === null, '什么都没发生 → 不出一张空卡')
    ok(projectTaskCard({ ...base, dismissed: true }).status === 'dismissed', '忽略过就是 dismissed')
    ok(
      projectTaskCard({ ...base, dismissed: true, run: { failed: true } }).status === 'dismissed',
      '忽略优先于失败（用户说过不管了，不该又冒回来）'
    )
    const failed = projectTaskCard({ ...base, run: { failed: true, reason: '连续两次同因失败' } })
    ok(failed.status === 'failed' && failed.reason === '连续两次同因失败', '失败带可读原因')
    ok(projectTaskCard({ ...base, run: { running: true } }).status === 'running', '正在跑 = running')

    const q = projectTaskCard({ ...base, question: { pending: true, text: '选哪个方案' } })
    ok(q.status === 'waiting_user' && q.reason.includes('选哪个方案'), '提问挂起 = waiting_user 且原因可读')
    const goalBlocked = projectTaskCard({ ...base, goal: { phase: 'blocked', title: '迁移', blockedReason: '缺凭据' } })
    ok(goalBlocked.status === 'waiting_user' && goalBlocked.reason.includes('缺凭据'), '目标 blocked = waiting_user（带阻塞原因）')
    ok(
      projectTaskCard({ ...base, run: { running: true, waiting: true } }).status === 'waiting_user',
      '运行在等用户接管时按 waiting_user 报（不是 running）'
    )

    const review = projectTaskCard({ ...base, awaitingReview: { since: 900 } })
    ok(review.status === 'needs_review', '近似标记 → needs_review')
    ok(review.approximate === true, 'needs_review 必须标 approximate（不假装精确）')

    ok(
      projectTaskCard({ ...base, plan: { total: 3, done: 3 } }).status === 'done',
      '计划全部完成 = done'
    )
    ok(
      projectTaskCard({ ...base, goal: { phase: 'completed', title: '迁移' } }).status === 'done',
      '目标 completed = done'
    )
    ok(projectTaskCard({ ...base, plan: { total: 3, done: 1, current: '改 schema' } }).status === 'pending', '有安排但没跑 = pending')
  }

  /* ---- 进度只用有依据的计数 ---- */
  {
    const c = projectTaskCard({ ...base, plan: { total: 4, done: 2, current: '写测试' } })
    ok(c.progress === '第 3 / 4 步：写测试', '进度给「第几步 / 共几步」，不给百分比')
    ok(!/%/.test(c.progress), '进度里没有百分比')
    const g = projectTaskCard({ ...base, goal: { phase: 'executing', title: '迁移' } })
    ok(g.progress === '目标阶段：executing', '没有计划时用目标阶段词（不是数字）')
    const s = projectTaskCard({ ...base, subagents: { running: 2, failed: 1 } })
    ok(s === null, '只有子代理活动、没有别的信号时不占卡片位')
    const s2 = projectTaskCard({ ...base, run: { running: true }, subagents: { running: 2, failed: 1 } })
    ok(/子代理：2 个在跑 · 1 个失败/.test(s2.evidence), '子代理证据单独成句（不合成完成度）')
  }

  /* ---- 排序与筛选 ---- */
  {
    const cards = [
      projectTaskCard({ ...base, sessionId: 'a', updatedAt: 10, plan: { total: 2, done: 1 } }),
      projectTaskCard({ ...base, sessionId: 'b', updatedAt: 20, run: { failed: true } }),
      projectTaskCard({ ...base, sessionId: 'c', updatedAt: 30, awaitingReview: { since: 1 } }),
      projectTaskCard({ ...base, sessionId: 'd', updatedAt: 40, question: { pending: true } }),
      projectTaskCard({ ...base, sessionId: 'e', updatedAt: 50, plan: { total: 1, done: 1 } })
    ].filter(Boolean)
    const sorted = [...cards].sort(compareTaskCards).map((c) => c.sessionId)
    ok(sorted.join('') === 'cdbae', '排序：待审阅 → 等待用户 → 失败 → 待开始 → 已完成')
    const sameTier = [
      { id: 'x', title: 'x', sessionId: 'x', status: 'failed', updatedAt: 1 },
      { id: 'y', title: 'y', sessionId: 'y', status: 'failed', updatedAt: 9 }
    ]
    ok([...sameTier].sort(compareTaskCards)[0].sessionId === 'y', '同档按最近活动排序')

    ok(filterTaskCards(cards, { statuses: ['failed'] }).length === 1, '按状态筛选')
    const failedQuery = taskInboxPageQuery(30, 'failed')
    ok(failedQuery.statuses?.join(',') === 'failed' && !('status' in failedQuery), '界面分页查询使用 IPC 契约字段 statuses')
    ok(!('statuses' in taskInboxPageQuery(30, 'all')), '全部筛选不发送状态约束')
    ok(filterTaskCards(cards, { query: '会话' }).length === 5, '关键词匹配标题')
    ok(filterTaskCards(cards, { query: '不存在的词' }).length === 0, '匹配不到就是空（不是全部）')
    const counts = inboxCounts(cards)
    ok(counts.needs_review === 1 && counts.failed === 1 && counts.done === 1, '计数按状态分开')
    ok(actionableCards(cards).length === 3, '需要人处理的有三类')
  }

  /* ---- 服务：缺源降级 / 跨会话隔离 / 分页 / 缓存 ---- */
  {
    const sessions = [
      { id: 's1', title: '一', updatedAt: 100 },
      { id: 's2', title: '二', updatedAt: 200 },
      { id: 's3', title: '三', updatedAt: 300 }
    ]
    let planReads = 0
    const service = createTaskInboxService({
      listSessions: async () => sessions,
      runners: () => [{ sessionId: 's2', running: true }],
      dismissed: () => ['s3'],
      readPlan: async (id) => {
        planReads++
        if (id === 's1') throw new Error('文件正在被写')
        if (id === 's2') return { total: 3, done: 1 }
        return undefined
      },
      readQuestion: async () => {
        throw new Error('来源坏了')
      },
      /* s1 的 goal 源是好的：证明“一个源坏了不影响其余源” */
      readGoal: async (id) => (id === 's1' ? { phase: 'blocked', title: '迁移', blockedReason: '缺凭据' } : undefined)
    })

    const page = await service.page()
    ok(page.total === 3, '三条会话都出卡（一个源坏掉不丢整张卡）')
    ok(page.degraded === 3, '每个会话都有读失败的来源 → degraded 如实计数（不抛错）')
    ok(page.cards.every((c) => sessions.some((s) => s.id === c.sessionId)), '每张卡的 sessionId 都是自己的（跨会话不串）')
    const s1Card = page.cards.find((c) => c.sessionId === 's1')
    ok(s1Card.status === 'waiting_user', 'plan 与 question 读失败，但 goal 说得清 → 出 waiting_user（不编也不丢）')
    const s2 = page.cards.find((c) => c.sessionId === 's2')
    ok(s2.status === 'running', '运行中优先于未完成计划')
    const s3 = page.cards.find((c) => c.sessionId === 's3')
    ok(s3.status === 'dismissed', '忽略的会话仍出卡（可见性由筛选决定）')

    const readsBefore = planReads
    await service.page()
    ok(planReads === readsBefore, 'TTL 内不重复扫（缓存生效）')
    service.invalidate()
    await service.page()
    ok(planReads > readsBefore, 'invalidate 后重新读')

    const firstPage = await service.page({}, { limit: 2 })
    ok(firstPage.cards.length === 2 && firstPage.total === 3, '分页只切当前页，total 是过滤后的总数')
    const secondPage = await service.page({}, { limit: 2, offset: 2 })
    ok(secondPage.cards.length === 1, '第二页拿到剩下的那条')
    ok(secondPage.counts.pending + secondPage.counts.running + secondPage.counts.dismissed + secondPage.counts.waiting_user === 3, '计数是全量口径（不随分页变）')

    const empty = createTaskInboxService({ listSessions: async () => [], runners: () => [] })
    const emptyPage = await empty.page()
    ok(emptyPage.total === 0 && emptyPage.cards.length === 0, '一条会话都没有时是空态（不报错）')

    const onlyReview = await service.page({ statuses: ['needs_review'] })
    ok(onlyReview.total === 0 && onlyReview.cards.length === 0, '没有来源支持时不出 needs_review（不编状态）')
  }
}
