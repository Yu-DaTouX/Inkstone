/**
 * 子代理在普通会话流里的归属过滤与人类操作（实施-20 U4 后的行为）。
 *
 * 用合成 MainPush 快照在真实 Electron 渲染树回放；不启动子代理进程、
 * 不调用模型。原来靠右侧专用详情页验证的长转录 / 滚动断言随专用页撤下。
 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeoutMs = 5000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = predicate()
      if (value) return value
      await sleep(50)
    }
    return predicate()
  }
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const prefix = `probe-h10-${Date.now()}`
  const currentId = `${prefix}-current`
  const foreignId = `${prefix}-foreign`
  const sessionId = store?.getState().session?.sessionId
  const makeRun = (id, parentSessionId) => ({
    id,
    task: `H-10 fixture ${id.endsWith('current') ? '当前会话' : '其它会话'}`,
    cwd: store?.getState().session?.cwd ?? '',
    parentSessionId,
    isolation: 'controlled-cwd',
    status: 'running',
    startedAt: Date.now() - 5000,
    latestActivity: '事件回放',
    transcript: [],
    review: 'none'
  })
  const push = (run) => store.getState().applyPush({ ch: 'subagent', payload: run })

  try {
    if (!store || !sessionId) return '  ✗ 当前页面没有可用的渲染 store / sessionId'

    out.push('=== 1. 当前会话归属过滤 ===')
    push(makeRun(currentId, sessionId))
    push(makeRun(foreignId, `${prefix}-another-session`))
    const ownRow = await until(() => q(`[data-testid="subagent-note-${currentId}"]`))
    await sleep(150)
    ok(!!ownRow, '当前会话推送出现在会话流状态行')
    ok(!q(`[data-testid="subagent-note-${foreignId}"]`), '其它会话推送不出现在当前会话')
    ok(!q('[data-testid="subagent-new"]'), '专用「调用子代理」入口已撤下（U4）')

    out.push('')
    out.push('=== 2. 运行中给出「停止」 ===')
    ok(!!q(`[data-testid="subagent-note-stop-${currentId}"]`), '运行中的 run 有停止按钮')

    out.push('')
    out.push('=== 3. 待审阅时给出「合并 / 放弃」 ===')
    push({
      ...makeRun(currentId, sessionId),
      status: 'done',
      endedAt: Date.now(),
      review: 'pending',
      diff: { files: 2, additions: 10, deletions: 3, paths: ['src/a.ts'], patchPath: null, truncated: false }
    })
    await sleep(250)
    ok(!!q(`[data-testid="subagent-note-merge-${currentId}"]`), '待审阅时给出「合并到主目录」')
    ok(!!q(`[data-testid="subagent-note-discard-${currentId}"]`), '待审阅时给出「放弃并归档」')
    ok(!q(`[data-testid="subagent-note-stop-${currentId}"]`), '结束后不再显示停止')

    out.push('')
    out.push('=== 4. 已合并的 run 安静退场 ===')
    push({ ...makeRun(currentId, sessionId), status: 'done', endedAt: Date.now(), review: 'merged' })
    await sleep(250)
    ok(!q(`[data-testid="subagent-note-${currentId}"]`), '已合并的 run 不再占会话流')
  } catch (error) {
    out.push(`  探针出错: ${error?.message ?? String(error)}`)
  } finally {
    for (const id of [currentId, foreignId]) {
      store?.getState().applyPush({ ch: 'subagent-remove', payload: id })
    }
  }

  return out.join('\n')
})()
