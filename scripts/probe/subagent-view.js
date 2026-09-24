/**
 * 实施-11 H-10：用合成 MainPush 快照在真实 Electron 渲染树回放列表和长转录。
 * 不启动子代理进程、不调用模型；主进程 IPC / 模型执行由既有 subagent 场景覆盖。
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
  const makeRun = (id, parentSessionId, transcript = []) => ({
    id,
    task: `H-10 fixture ${id.endsWith('current') ? '当前会话' : '其它会话'}`,
    cwd: store?.getState().session?.cwd ?? '',
    parentSessionId,
    isolation: 'controlled-cwd',
    status: 'running',
    startedAt: Date.now() - 5000,
    latestActivity: '事件回放',
    transcript,
    review: 'none'
  })
  const message = (n) => ({
    id: `${prefix}-message-${n}`,
    role: 'assistant',
    text: `长任务过程行 ${n}: ` + '保留用户阅读位置并验证滚动跟随。'.repeat(18),
    timestamp: Date.now() + n
  })
  const push = (run) => store.getState().applyPush({ ch: 'subagent', payload: run })

  try {
    if (!store || !sessionId) return '  ✗ 当前页面没有可用的渲染 store / sessionId'

    await store.getState().setRightPanelOpen(true)
    await until(() => q('[data-testid="right-window-tab-tools"]'))
    q('[data-testid="right-window-tab-tools"]')?.click()
    const list = await until(() => q('[data-testid="subagent-new"]'))
    if (!list) return '  ✗ 右侧工具页未挂载子代理列表'

    out.push('=== 1. 当前会话归属过滤 ===')
    push(makeRun(currentId, sessionId))
    push(makeRun(foreignId, `${prefix}-another-session`))
    const ownRow = await until(() => q(`[data-testid="subagent-${currentId}"]`))
    await sleep(150)
    ok(!!ownRow, '当前会话推送出现在子代理列表')
    ok(!q(`[data-testid="subagent-${foreignId}"]`), '其它会话推送不出现在当前列表')

    out.push('')
    out.push('=== 2. 长过程输出与滚动位置 ===')
    const longRun = makeRun(currentId, sessionId, Array.from({ length: 36 }, (_, i) => message(i + 1)))
    push(longRun)
    q(`[data-testid="subagent-view-${currentId}"]`)?.click()
    const processTab = await until(() => q('[data-testid="subagent-tab-process"]'))
    if (!processTab) return out.concat('  ✗ 详情没有打开').join('\n')
    processTab.click()

    const body = await until(() => {
      const el = q('[data-testid="subagent-preview-body"]')
      return el && el.scrollHeight > el.clientHeight ? el : null
    })
    if (!body) return out.concat('  ✗ 长转录正文没有形成可滚动区域').join('\n')
    await sleep(120)
    const initialMax = body.scrollHeight - body.clientHeight
    ok(initialMax > 0 && initialMax - body.scrollTop < 24, '打开过程页后长转录自动定位到最新内容')

    body.scrollTop = 0
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    const beforeAppend = body.scrollHeight
    push({ ...longRun, transcript: [...longRun.transcript, message(37)] })
    await sleep(160)
    ok(body.scrollHeight > beforeAppend, '新推送扩展了长转录正文')
    ok(body.scrollTop < 24, '用户上滚后新输出没有把阅读位置抢回底部')

    body.scrollTop = body.scrollHeight
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    const latest = { ...longRun, transcript: [...longRun.transcript, message(37), message(38)] }
    push(latest)
    await sleep(160)
    ok(body.scrollHeight - body.clientHeight - body.scrollTop < 24, '用户回到底部后后续输出恢复自动跟随')
  } catch (error) {
    out.push(`  探针出错: ${error?.message ?? String(error)}`)
  } finally {
    for (const id of [currentId, foreignId]) {
      store?.getState().applyPush({ ch: 'subagent-remove', payload: id })
    }
  }

  return out.join('\n')
})()
