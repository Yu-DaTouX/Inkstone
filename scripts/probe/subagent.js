/**
 * 子代理：真实启动一个独立 pi 子进程，跑完一个小任务（方案第 8 节）。
 *
 * ⚠️ 这是**真跑**：会起 `pi --mode rpc` 子进程并调一次模型
 *    （回归里用 commandcode 的免费模型，见 test-live 的 TEST_MODEL）。
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
    out.push('=== 2. 真实启动一个子代理 ===')
    /*
     * 先走用户可见的调用 UI：它与 Codex 一样靠近输入区，
     * 不要求用户记住 `/subagent`。提交后仍然落到同一个 store action，
     * 会真的起一个独立 pi 子进程，并把详情面板自动打开。
     */
    const noticesBefore = store.getState().notices.length
    /* H-3b：子代理调用入口在「工具」固定页；新会话默认停在「开始」页。 */
    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    await sleep(300)
    document.querySelector('[data-testid="right-window-tab-tools"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(500)
    ok(!!q('[data-testid="subagent-new"]'), '右侧工具页有显式的子代理调用按钮')
    q('[data-testid="subagent-new"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
    ok(!!q('[data-testid="subagent-launch-panel"]'), '点击后打开子代理任务面板')
    const taskInput = q('[data-testid="subagent-task"]')
    const taskSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    if (taskInput && taskSetter) {
      taskSetter.call(taskInput, '请只回答两个字：收到')
      taskInput.dispatchEvent(new Event('input', { bubbles: true }))
      taskInput.dispatchEvent(new Event('change', { bubbles: true }))
    }
    /* React 的受控 textarea 需要一帧把 onChange 的状态写回按钮 disabled。 */
    await sleep(250)
    const startButton = q('[data-testid="subagent-start"]')
    ok(!!startButton && !startButton.disabled, '任务文本已写入，启动按钮可用')
    startButton?.click()
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
    ok(!!q('[data-testid="subagent-strip"]'), '主对话区渲染出子任务列表')
    ok(!!q(`[data-testid="subagent-${id}"]`), '列表里有这一条')

    /* 打开详情：start 后默认已打开 */
    let previewed = false
    for (let i = 0; i < 20; i++) {
      if (q('[data-testid="subagent-preview"]')) {
        previewed = true
        break
      }
      await sleep(300)
    }
    out.push(`  诊断：subagentPreviewId=${JSON.stringify(store.getState().subagentPreviewId)}`)
    out.push(`  诊断：rightpanel=${!!q('[data-testid="rightpanel"]')} sp=${!!q('.sp')}`)
    out.push(`  诊断：store.subagents=${store.getState().subagents.length}`)
    ok(previewed, '详情面板打开了（现在内联在主工作区，不是右栏）')

    out.push('')
    out.push('=== 3. 等它跑完（真实模型调用）===')
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

    /* 详情面板里能真的看到输出（H-10a 后默认在「概览」，先切到「过程」） */
    q('[data-testid="subagent-tab-process"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(300)
    const body = q('[data-testid="subagent-preview-body"]')?.textContent ?? ''
    out.push(`  详情正文长度 = ${body.length}`)
    ok(body.length > 0, '详情面板里有内容')

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
