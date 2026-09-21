/**
 * 交接包生成（实施-05 S5b-2，**会真的多调一次模型**）。
 *
 * ══════════════════════════════════════════════════════════
 * 这一片验的是「模型真的写得出这两栏」
 * ══════════════════════════════════════════════════════════
 * 契约与文件交换已经由单测钉住（含「请求 → 结果 → 解析 → 清洗 → 落盘」全链路）；
 * 真实链路里唯一单测替代不了的是：
 *   ① 薄层真的在 `agent_settled` 时**调了**一次 completion（不是 file 交换假装成功）；
 *   ② 模型回的原文真的能过 `parseHandoffOutput` + `sanitizeHandoffPackage`（两栏必填）；
 *   ③ 来源字段确实是**宿主**填的（`sourceSession` 指回会话文件、`sourceHead` 有水位）。
 *
 * 阈值由 `YAN_HANDOFF_THRESHOLD=0` 压到 0（真实链路要攒两次真实自动压缩才够数，
 * 那是全项目最贵的场景之一）—— 压阈值不改变任何生产判定，只是让「够数」这一条先成立。
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
  /** 硬截止：约 240s（一次工具回合 + 一次写包 completion） */
  const deadline = Date.now() + 240000
  const waitFor = async (fn, step = 500) => {
    while (Date.now() < deadline) {
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

  const snapshot = async () => {
    const goal = await window.yan.getGoal()
    const handoff = await window.yan.getHandoff()
    return { goal, handoff }
  }

  /** 失败时的现场：分清「资格没过」「薄层没跑」「模型回的不能解析」 */
  const dumpDiagnostics = async (label) => {
    const st = store.getState()
    out.push(`  —— 诊断（${label}）——`)
    try {
      const { goal, handoff } = await snapshot()
      out.push(
        `  goal：rev${goal.goal.revision} phase=${goal.goal.phase} mode=${goal.mode.mode}；` +
          `handoff：count=${handoff.tally?.count ?? '-'} threshold=${handoff.threshold} pending=${handoff.pending} package=${handoff.package ? '有' : '无'}`
      )
    } catch (error) {
      out.push('  读状态失败：' + String(error?.message ?? error))
    }
    out.push(
      `  会话：conn=${st.conn} isStreaming=${st.session?.isStreaming} isAgentRunning=${st.session?.isAgentRunning} 消息 ${st.messages.length} 条`
    )
    const assistants = st.messages.filter((m) => m.role === 'assistant')
    for (const m of assistants.slice(-2)) out.push('  助手：' + JSON.stringify(String(m.content ?? '').slice(0, 200)))
  }

  const ready = await waitFor(() => store.getState().conn === 'ready', 250)
  ok(!!ready, 'pi 已连接')
  await sleep(800)

  out.push('')
  out.push('=== 1. 自主档 + 阈值压到 0（测试通道）===')
  await store.getState().setWorkMode('autonomous')
  await sleep(600)
  const mode0 = await window.yan.getWorkMode()
  ok(mode0.mode === 'autonomous', `宿主侧已切到自主档（${JSON.stringify(mode0)}）`)
  const initial = await window.yan.getHandoff()
  ok(initial.threshold === 0, `阈值被测试通道压到 0（实际 ${initial.threshold}）`)
  ok(initial.package === null, '此时还没有交接包')
  ok(initial.pending === false, '此时没有在生成中')

  out.push('')
  out.push('=== 2. 让模型报一次进展（「目标在推进」这条前提）===')
  const command = 'yan goal report --report-id rp-pack-1 --phase executing --goal-revision 0'
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
  })
  ok(!!reported, `目标进入执行（rev${reported?.goal?.revision ?? '?'} / ${reported?.goal?.phase ?? '?'}）`)
  if (!reported) await dumpDiagnostics('等目标报告')

  out.push('')
  out.push('=== 3. 回合结束后薄层真的写了一份包（一次额外模型调用）===')
  const produced = await waitFor(async () => {
    const h = await window.yan.getHandoff()
    return h.package ? h : null
  }, 700)
  ok(!!produced, '交接包真的生成了')
  if (!produced) await dumpDiagnostics('等交接包')

  if (produced) {
    const pkg = produced.package
    out.push(`  包摘要：goal=${JSON.stringify(pkg.goal.slice(0, 60))} deliverable=${JSON.stringify(pkg.deliverable.slice(0, 60))}`)
    out.push(
      `  栏位计数：constraints=${pkg.constraints.length} acceptance=${pkg.acceptance.length} done=${pkg.done.length} ` +
        `remaining=${pkg.remaining.length} nextActions=${pkg.nextActions.length} files=${pkg.files.length}`
    )
    ok(pkg.goal.trim().length > 0, '`goal` 非空（必填栏）')
    ok(pkg.deliverable.trim().length > 0, '`deliverable` 非空（必填栏）')
    ok(pkg.generator === 'model', `generator 标记为 model（实际 ${pkg.generator}）`)
    ok(/\.jsonl$/.test(pkg.sourceSession), `sourceSession 指回会话文件（${pkg.sourceSession.split(/[\\/]/).pop()}）`)
    ok(pkg.mode === 'autonomous', `来源模式是自主档（实际 ${pkg.mode}）`)
    ok(typeof pkg.sourceHead === 'string' && pkg.sourceHead.length > 0, '记了截取水位 sourceHead')
    ok(pkg.generatedAt > 0, '记了生成时间')
  }

  out.push('')
  out.push('=== 4. 收尾：没有残留的生成中状态 ===')
  const final = await window.yan.getHandoff()
  ok(final.pending === false, '生成中状态已清（轮询停了）')
  ok(final.threshold === 0, '阈值覆盖只影响本次运行（不被写进任何持久状态）')
  ok(store.getState().session?.isStreaming !== true, '界面不在流式中（生成没有卡会话）')

  return out.join('\n')
})()
