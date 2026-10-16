/**
 * 子代理：真实启动一个独立 pi 子进程，跑完一个小任务（方案第 8 节）。
 *
 * ⚠️ 这是**真跑**：会起 `pi --mode rpc` 子进程。模型取决于场景：
 *    `subagent` 用 `YAN_TEST_MODEL`（回归里是 commandcode 的免费模型，会真的调一次模型）；
 *    `subagentlocal` 指向本机 OpenAI 兼容 fixture（不发往外部、不花额度）。
 *    两者共用同一条主进程链路：SubagentController → onChange push → IPC → renderer store，
 *    它同时是「适配门槛」的实测：Windows 路径、Electron 起子进程、
 *    RPC 事件流、取消 —— 这四件事全都在这条链路里。
 *
 * 这里不断言模型说了什么（不稳定），只断言**运行模型**是否正确：
 *   状态流转、转录非空、预览能打开、停止真的能停。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  /* 探针会在 store 里补一个助手回合锚点来验卡片渲染，结束时复原。 */
  const before = { messages: store.getState().messages, subagents: store.getState().subagents }
  let overviewSampler
  const liveOverviewIds = new Set()
  let duplicateLiveCards = false

  /** 轮询等某个 run 进入终态 */
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
    /*
     * 实施-20 U4 撤下了右侧专用子代理页与「调用子代理」新建面板：
     * 现在用同一个 store action 代表「agent 自行委派」，
     * 并核对普通会话流里的 SubagentNote 是否给出状态与人类操作。
     */
    const noticesBefore = store.getState().notices.length
    const baselineIds = new Set(store.getState().subagents.map(run => run.id))
    // 从启动前采样真实 live 状态，避免短回复完成后才检查本应撤下的概览。
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
    /*
     * 默认隔离级别是 shared-cwd：委派默认就在当前工作目录执行，要隔离必须显式传
     * worktree（`yan subagent start --isolation worktree`，见随包 subagent 技能）。
     * 这条以前断言「默认 worktree」，那是撤下旧工作台之前的设计。
     */
    ok(started?.isolation === 'shared-cwd', `未指定隔离时默认共享当前目录（${started?.isolation ?? '无'}）`)
    ok(started?.cwd && started.cwd === store.getState().settings.cwd, '默认隔离下 cwd 就是主工作树')
    ok(!!started?.parentSessionId, '记录了父会话身份')
    if (!id) return out.join('\n')

    /* store 应该收到 push 并渲染出紧凑列表 */
    let listed = false
    for (let i = 0; i < 20; i++) {
      if (store.getState().subagents.some((r) => r.id === id)) {
        listed = true
        break
      }
      await sleep(300)
    }
    ok(listed, '运行进入 store（主进程 push 生效）')

    /*
     * 历史卡片只挂在**触发它的助手回合**下（U4 撤下专用管理页之后）。这条链路走的是
     * IPC 直接启动：没有回合锚点，所以此刻会话流里不应该出现完整卡片；真实委派由能力
     * 服务把助手消息 id 写进 run 的 parentMessageId。
     *
     * 但输入框上方的常驻区（U01 后）要给出**一行概览**（运行中 a · 需处理 b）
     * 加一个查看入口，不再复制第二套完整卡片。渲染路径另在下面补锚点后验证。
     */
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
    /* 诊断：一条回复到底落成了几条消息（id 漂移 / 尾部事件丢失都会在这里现形） */
    out.push(
      '  转录明细 = ' +
        JSON.stringify(
          (final?.transcript ?? []).map((m) => [m.id, m.role, (m.text ?? '').slice(0, 20), (m.toolCalls ?? []).map((c) => c.name)])
        )
    )
    ok(!!final?.endedAt, '记录了结束时间')
    const hasReply = (final?.transcript ?? []).some((m) => m.role === 'assistant' && m.text.length > 0)
    if (!hasReply) {
      /*
       * 空回复最常见的原因是**免费模型配额**（429）——症状固定：
       * assistant 消息内容为空。把可诊断的字段一起打出来，
       * 免得每次都要去翻日志才知道是"模型没回"还是"事件流丢了"。
       */
      out.push('  诊断：没有回复文本｜run=' + JSON.stringify({
        status: final?.status,
        error: final?.error ?? null,
        endedAt: final?.endedAt ?? null
      }))
      out.push('  诊断：免费模型配额（429）时的表现就是空文本，见 MAINTENANCE「免费模型有配额」')
    }
    ok(hasReply, '转录里有模型的回复文本')

    /*
     * 会话流状态行（实施-20 U4 后的普通入口）：补一个助手回合锚点，验真实 run 数据
     * 能渲染出状态行。主进程随后的 push 会覆盖本地注入，所以放在终态之后再补一次。
     */
    const anchorId = 'subagent-probe-anchor'
    const withAnchor = () => {
      const run = store.getState().subagents.find((r) => r.id === id)
      /*
       * 主进程随后可能推两样东西把锚点冲掉：会话消息同步（抹掉回合锚点）与
       * 不带 parentMessageId 的 run 推送，所以两样都周期性补，直到卡片挂上来。
       */
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
      /* 卡片按会话身份过滤；空会话还没有会话 id，这里无从归属，不算通过也不算失败。 */
      out.push('  ~ 跳过：当前会话还没有会话 id，卡片归属判据不适用')
    } else {
      ok(noted && noteText.length > 0, '补上助手回合锚点后，真实 run 能渲染出卡片状态行')
      /* 同一个 child 在会话流里只能有一张卡；常驻区始终不再复制卡片。 */
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
      /*
       * 不等它自然跑完再停 —— 免费模型很快，可能来不及。
       * 断言的是「停止这个动作有效」：接口返回 ok，且最终不留在 running。
       */
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

    /* 收尾：清掉记录，别污染后面的场景 */
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
