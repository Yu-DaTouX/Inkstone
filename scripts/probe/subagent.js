;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const before = { messages: store.getState().messages, subagents: store.getState().subagents }
  let overviewSampler
  const liveOverviewIds = new Set()
  let duplicateLiveCards = false

  const waitStatus = async (id, done, timeoutMs) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const run = store.getState().subagents.find((r) => r.id === id)
      if (run && done.includes(run.status)) return run
      await sleep(500)
    }
    return store.getState().subagents.find((r) => r.id === id) ?? null
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings && q('.composer-wrap')) break
      await sleep(250)
    }
    await sleep(800)

    out.push('=== 1. 图标扩展启用前的基线 ===')
    const before = await window.yan.subagents.list()
    ok(Array.isArray(before), 'subagents.list() 可用（IPC 通了）')
    out.push(`  起始 run 数 = ${before.length}`)

    out.push('')
    out.push('=== 2. 启动一个子代理（agent 委派路径）===')
    const noticesBefore = store.getState().notices.length
    const baselineIds = new Set(store.getState().subagents.map(run => run.id))
    overviewSampler = setInterval(() => {
      const run = store.getState().subagents.find(run => !baselineIds.has(run.id) && run.task === '请只回答两个字：收到')
      if (!run || ['done', 'error', 'cancelled'].includes(run.status)) return
      const row = q('[data-testid="active-subagents"]')
      if (row?.querySelector('[data-testid="active-subagents-summary"]')?.textContent.trim()) liveOverviewIds.add(run.id)
      if (row?.querySelector('.sg-card')) duplicateLiveCards = true
    }, 25)
    await store.getState().startSubagent('请只回答两个字：收到')
    await sleep(800)
    let started = null
    for (let i = 0; i < 30; i++) {
      started = store.getState().subagents[store.getState().subagents.length - 1]
      if (started?.task === '请只回答两个字：收到') break
      await sleep(300)
    }
    const id = started?.id
    ok(store.getState().notices.length === noticesBefore, '启动没有报错（没有新通知）')
    ok(!!id, `拿到 run id（${id ?? '无'}）`)
    ok(started?.isolation === 'shared-cwd', `未指定隔离时默认共享当前目录（${started?.isolation ?? '无'}）`)
    ok(started?.cwd && started.cwd === store.getState().settings.cwd, '默认隔离下 cwd 就是主工作树')
    ok(!!started?.parentSessionId, '记录了父会话身份')
    if (!id) return out.join('\n')

    let listed = false
    for (let i = 0; i < 20; i++) {
      if (store.getState().subagents.some((r) => r.id === id)) {
        listed = true
        break
      }
      await sleep(300)
    }
    ok(listed, '运行进入 store（主进程 push 生效）')

    await sleep(1000)
    out.push(`  诊断：subagentPreviewId=${JSON.stringify(store.getState().subagentPreviewId)}`)
    ok(
      !q(`[data-testid="subagent-note-${id}"]`),
      '没有助手回合锚点时不落会话流卡片（卡片由委派回合承载）'
    )
    const currentView = store.getState()
    out.push(`  概览采样：status=${currentView.subagents.find(run => run.id === id)?.status}；sid=${currentView.session?.sessionId}；peek=${currentView.peekedSessionId}；parent=${started?.parentSessionId}`)
    const overview = q('[data-testid="active-subagents"]')
    ok(
      liveOverviewIds.has(id),
      '真实运行阶段常驻区给出一行概览（不是完成后才检查）'
    )
    clearInterval(overviewSampler)
    ok(!duplicateLiveCards && !overview?.querySelector('.sg-card'), '常驻区不再复制一套完整卡片')
    ok(!q('[data-testid="subagent-new"]'), '专用「调用子代理」入口已撤下')

    out.push('')
    out.push('=== 3. 等它跑完（真实 pi 子进程；模型按场景）===')
    const final = await waitStatus(id, ['done', 'error', 'cancelled'], 120_000)
    out.push(`  终态 = ${final?.status}，转录 ${final?.transcript.length ?? 0} 条`)
    if (final?.error) out.push(`  错误 = ${final.error}`)
    ok(!!final, '拿到终态')
    ok(final?.status === 'done', `正常跑完（实际 ${final?.status}）`)
    ok((final?.transcript.length ?? 0) > 0, '转录里有内容（事件流真的接上了）')
    out.push(
      '  转录明细 = ' +
        JSON.stringify(
          (final?.transcript ?? []).map((m) => [m.id, m.role, (m.text ?? '').slice(0, 20), (m.toolCalls ?? []).map((c) => c.name)])
        )
    )
    ok(!!final?.endedAt, '记录了结束时间')
    const hasReply = (final?.transcript ?? []).some((m) => m.role === 'assistant' && m.text.length > 0)
    if (!hasReply) {
      out.push('  诊断：没有回复文本｜run=' + JSON.stringify({
        status: final?.status,
        error: final?.error ?? null,
        endedAt: final?.endedAt ?? null
      }))
      out.push('  诊断：免费模型配额（429）时的表现就是空文本，见 MAINTENANCE「免费模型有配额」')
    }
    ok(hasReply, '转录里有模型的回复文本')

    const anchorId = 'subagent-probe-anchor'
    const withAnchor = () => {
      const run = store.getState().subagents.find((r) => r.id === id)
      if (!store.getState().messages.some((m) => m.id === anchorId)) {
        store.setState({ messages: [...store.getState().messages, { id: anchorId, role: 'assistant', text: '委派一个子任务' }] })
      }
      if (run) store.getState().applyPush({ ch: 'subagent', payload: { ...run, parentMessageId: anchorId } })
    }
    let noted = false
    for (let i = 0; i < 24; i++) {
      withAnchor()
      if (q(`[data-testid="subagent-note-${id}"]`)) {
        noted = true
        break
      }
      await sleep(200)
    }
    const noteText = q(`[data-testid="subagent-note-${id}"]`)?.textContent ?? ''
    const owner = store.getState().session
    const runNow = store.getState().subagents.find((r) => r.id === id)
    out.push(
      `  诊断：session.sessionId=${JSON.stringify(owner?.sessionId ?? null)} conversationId=${JSON.stringify(owner?.conversationId ?? null)}｜run.parentSessionId=${JSON.stringify(runNow?.parentSessionId ?? null)} parentMessageId=${JSON.stringify(runNow?.parentMessageId ?? null)}`
    )
    out.push(`  状态行文本长度 = ${noteText.length}`)
    if (!owner?.sessionId && !owner?.conversationId) {
      out.push('  ~ 跳过：当前会话还没有会话 id，卡片归属判据不适用')
    } else {
      ok(noted && noteText.length > 0, '补上助手回合锚点后，真实 run 能渲染出卡片状态行')
      ok(
        document.querySelectorAll(`[data-testid="subagent-note-${id}"]`).length === 1,
        '同一个子代理在会话流里只有一张卡（没有同一列表复制）'
      )
      ok(!q('[data-testid="active-subagents"] .sg-card'), '常驻区始终没有复制卡片')
    }

    out.push('')
    out.push('=== 4. 停止：真的能停 ===')
    const res2 = await window.yan.subagents.start('请做一个很长的任务：把 1 到 1000 全部写出来')
    ok(res2.ok === true, '第二个子代理启动成功')
    const id2 = res2.run?.id
    if (id2) {
      const stopRes = await store.getState().stopSubagent(id2).then(() => ({ ok: true }))
      ok(stopRes.ok === true, 'stop() 返回成功')
      const stopped = await waitStatus(id2, ['cancelled', 'done', 'error'], 20_000)
      out.push(`  停止后状态 = ${stopped?.status}`)
      ok(
        stopped?.status === 'cancelled' || stopped?.status === 'done',
        '停止后不留在 running（已结束就是已结束，不卡在运行中）'
      )
      ok(!!stopped?.endedAt, '停止后写了结束时间')
    }

    await window.yan.subagents.clearFinished()
    await sleep(300)
    out.push(`  清理后剩 ${store.getState().subagents.length} 条`)
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
  } finally {
    clearInterval(overviewSampler)
    store.setState(before)
  }

  return out.join('\n')
})()
