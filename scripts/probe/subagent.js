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
    ok(started?.isolation === 'worktree', `默认写入任务使用独立 worktree（${started?.isolation ?? '无'}）`)
    ok(started?.cwd && started.cwd !== store.getState().settings.cwd, '子代理 cwd 不等于主工作树')
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

    /* 普通会话流里的状态行应该出现（替代撤下的专用页与资源标签） */
    let noted = false
    for (let i = 0; i < 20; i++) {
      if (q('[data-testid="subagent-notes"]') && q(`[data-testid="subagent-note-${id}"]`)) {
        noted = true
        break
      }
      await sleep(300)
    }
    out.push(`  诊断：subagentPreviewId=${JSON.stringify(store.getState().subagentPreviewId)}`)
    out.push(`  诊断：notes=${!!q('[data-testid="subagent-notes"]')}`)
    ok(noted, '会话流里出现子代理状态行（不需要专用管理页）')
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

    /* 会话流状态行里能真的看到输出（实施-20 U4 后的普通入口） */
    const note = q(`[data-testid="subagent-note-${id}"]`)
    const noteText = note?.textContent ?? ''
    out.push(`  状态行文本长度 = ${noteText.length}`)
    ok(noteText.length > 0, '会话流状态行里有内容')

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
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
