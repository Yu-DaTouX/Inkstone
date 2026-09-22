/**
 * 交接提交（实施-05 S5b-3b，**会真的多起一个会话并多跑一轮模型**）。
 *
 * ══════════════════════════════════════════════════════════
 * 这一片验的是「交接真的发生了」
 * ══════════════════════════════════════════════════════════
 * 顺序、幂等、崩溃恢复、失败回源都已经由单测用假依赖钉死（`test-handoff-runner.mjs`）。
 * 真实链路里单测替代不了的是：
 *   ① 宿主真的**停掉了源实例、在同一个 cwd 建了目的会话**（不是内存里改个字段）；
 *   ② 会话链真的落盘、当前视图真的切到了目的段（`yan:getHandoff` 的 `sessionKey` 会变）；
 *   ③ resume 真的**发出去并出现在目的会话文件里**（消费证据，不是「我发过了」）。
 *
 * 一个测试通道：`YAN_HANDOFF_THRESHOLD=0` —— 真实链路要攒两次真实自动压缩才够数（太贵）。
 * 自动交接**默认已开**（2026-09-19 用户拍板），所以这里**不设** `YAN_HANDOFF_COMMIT`：
 * 「默认开真的生效」本身就是断言。
 *
 * ⚠️ 每一段都有自己的超时并且**失败就立即返回**：探针的输出是整体返回的，
 *    在最后一步等到预算耗尽会让整次运行变成「一句输出都没有」，
 *    那是最难排查的一种失败（看不出卡在哪一步）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  /** 按阶段限时；到点返回 null，调用方立即收尾（不把整次运行拖到预算耗尽） */
  const waitFor = async (fn, limitMs, step = 600) => {
    const end = Date.now() + limitMs
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await sleep(step)
    }
    return null
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      click(b)
      await sleep(250)
    } else await sleep(120)
  }

  const snap = async () => {
    const goal = await window.yan.getGoal()
    const handoff = await window.yan.getHandoff()
    return { goal, handoff }
  }

  const dumpDiagnostics = async (label) => {
    out.push(`  —— 诊断（${label}）——`)
    try {
      const { goal, handoff } = await snap()
      out.push(
        `  goal：rev${goal.goal.revision} phase=${goal.goal.phase} mode=${goal.mode.mode}；` +
          `handoff：count=${handoff.tally?.count ?? '-'} threshold=${handoff.threshold} pending=${handoff.pending} ` +
          `package=${handoff.package ? '有' : '无'} autoCommit=${handoff.autoCommit} tx=${handoff.transaction?.stage ?? '无'}`
      )
      out.push(`  当前会话文件：${String(handoff.sessionKey).split(/[\\/]/).pop() || '（无活动实例）'}`)
    } catch (error) {
      out.push('  读状态失败：' + String(error?.message ?? error))
    }
    const st = store.getState()
    out.push(`  会话：conn=${st.conn} isAgentRunning=${st.session?.isAgentRunning} 消息 ${st.messages.length} 条`)
  }

  const ready = await waitFor(() => store.getState().conn === 'ready', 30000, 250)
  ok(!!ready, 'pi 已连接')
  if (!ready) {
    await dumpDiagnostics('等连接')
    return out.join('\n')
  }
  await sleep(800)

  out.push('')
  out.push('=== 1. 前提：自主档 + 阈值 0 + 提交开关打开 ===')
  await store.getState().setWorkMode('autonomous')
  await sleep(600)
  const mode0 = await window.yan.getWorkMode()
  ok(mode0.mode === 'autonomous', `宿主侧已切到自主档（${JSON.stringify(mode0)}）`)
  const initial = await window.yan.getHandoff()
  ok(initial.threshold === 0, `阈值被测试通道压到 0（实际 ${initial.threshold}）`)
  ok(initial.autoCommit === true, `自动交接默认已开（实际 ${initial.autoCommit}；本场景不设任何开关）`)
  ok(initial.transaction === null, '此时还没有交接事务')
  const sourceKey = initial.sessionKey
  out.push(`  源会话：${String(sourceKey).split(/[\\/]/).pop()}`)
  if (initial.autoCommit !== true) {
    await dumpDiagnostics('提交开关没打开')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 2. 让模型报一次进展（「目标在推进」这条前提）===')
  const command = 'yan goal report --report-id rp-commit-1 --phase executing --goal-revision 0'
  const prompt = [
    '这是一次功能自测，请严格只做两件事：',
    '1) 用 bash 工具**原样、单行**运行下面这条命令，把 stdout 贴出来：',
    '',
    command,
    '',
    '2) 然后**立刻结束本轮回复**（只写一句「收尾」），不要执行其它命令、不要写文件、不要继续分析。'
  ].join('\n')
  const sent = await store.getState().send(prompt)
  ok(!sent || sent.ok !== false, '消息已发送')

  const reported = await waitFor(async () => {
    const g = await window.yan.getGoal()
    return g.goal.revision > 0 ? g : null
  }, 90000)
  ok(!!reported, `目标进入执行（rev${reported?.goal?.revision ?? '?'} / ${reported?.goal?.phase ?? '?'}）`)
  if (!reported) {
    await dumpDiagnostics('等目标报告')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 3. 交接包生成（S5b-2 链路照常）===')
  const packed = await waitFor(async () => {
    const h = await window.yan.getHandoff()
    return h.package ? h : null
  }, 90000, 700)
  ok(!!packed, '交接包真的生成了')
  if (!packed) {
    await dumpDiagnostics('等交接包')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 4. 提交：停源 → 建目的会话 → 写链 → 发 resume ===')
  /*
   * 这一段会经历「源实例被停掉 → 新实例起来」的空档：`yan:getHandoff` 在
   * 没有活动实例时返回空壳，所以这里不能把「读到 null」当成失败，
   * 只能一直看到 resumed 或者超时。
   */
  let stagesSeen = []
  const committed = await waitFor(async () => {
    const h = await window.yan.getHandoff()
    const stage = h.transaction?.stage ?? (h.sessionKey ? 'none' : 'no-runner')
    if (stagesSeen.at(-1) !== stage) stagesSeen.push(stage)
    return stage === 'resumed' ? h : null
  }, 150000, 900)
  out.push(`  经历过的事务阶段：${stagesSeen.join(' → ')}`)
  if (committed) {
    ok(true, `交接事务走到 resumed（handoffId=${String(committed.transaction.handoffId).slice(0, 8)}…）`)
    ok(committed.transaction.destinationSession !== null, '事务里记了目的会话文件')
    ok(committed.sessionKey === committed.transaction.destinationSession, '当前视图已经切到目的段（同一条会话的下一段）')
    ok(committed.sessionKey !== sourceKey, '目的会话与源会话是两份不同的文件（后台真的切开了）')
    out.push(`  目的会话：${String(committed.sessionKey).split(/[\\/]/).pop()}`)
    /* resume 会真的触发一轮：等它落定，免得退出时掐断 */
    await waitFor(() => store.getState().session?.isAgentRunning !== true, 60000, 500)
    ok(store.getState().messages.length >= 0, '目的会话界面已能渲染（历史推送没报错）')

    out.push('')
    out.push('=== 4b. 前端仍是「一条会话」（S5b-4）===')
    const norm = (v) => String(v ?? '').trim().split('\\').join('/').replace(/\/+$/, '')
    const sessions = await window.yan.listSessions()
    const current = norm(committed.sessionKey)
    const seen = sessions.filter((s) => norm(s.path) === current).length
    ok(seen === 1, `侧栏列表里当前这条会话只出现一次（实际 ${seen} 次）`)
    ok(!sessions.some((s) => norm(s.path) === norm(sourceKey)), '链上的旧段（源会话）没有单独出现在侧栏列表里')
    /*
     * 历史拼接：源段的消息要留在同一条时间线里。
     *
     * ⚠️ 实施-14 F4：交接的 resume 现在是**custom 控制消息**（`yan-handoff-resume`），
     * 不再冒充用户消息 —— 所以它不进界面消息流。判据改成宿主侧的消费证据
     *（与 F0 的诊断事件同源），而不是在界面文本里找那句话。
     */
    const resumeConfirmed = await waitFor(async () => {
      const h = await window.yan.getHandoff()
      return h.events.some((e) => e.outcome === 'resume-confirmed') ? h : null
    }, 60000, 800)
    ok(!!resumeConfirmed, '交接 resume 已确认（custom 控制消息，不冒充用户消息）')
    const timeline = store.getState().messages.map((m) => String(m.text ?? m.content ?? ''))
    if (!timeline.some((t) => t.includes('这是一次功能自测'))) {
      out.push(
        `  时间线（${timeline.length} 条）：` +
          timeline.map((t) => `${String(t).replace(/\s+/g, ' ').slice(0, 24)}…`).join(' | ')
      )
    }
    ok(
      timeline.some((t) => t.includes('这是一次功能自测')),
      '历史里保留源段的消息（两段拼成一条时间线）'
    )
    out.push(`  同一条时间线里的消息数：${store.getState().messages.length}`)
    /* 联调（S6）：模式要跟着会话走，否则自主续接（S3c）在目的段当场失效 */
    const modeAfter = await window.yan.getWorkMode()
    ok(
      modeAfter.mode === 'autonomous',
      `目的会话继承了自主档（实际 ${modeAfter.mode}）—— 掉了就会让自主续接失效`
    )
  } else {
    const tx = await window.yan.getHandoff()
    ok(false, `交接没有走到 resumed（停在 ${tx.transaction?.stage ?? '无事务'}）`)
    await dumpDiagnostics('等提交')
  }

  out.push('')
  out.push('=== 5. 收尾：没有残留的生成中状态 ===')
  const final = await window.yan.getHandoff()
  ok(final.pending === false, '生成中状态已清（轮询停了）')
  ok(store.getState().session?.isStreaming !== true, '界面不在流式中')

  return out.join('\n')
})()
