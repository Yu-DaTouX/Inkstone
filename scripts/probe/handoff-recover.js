/**
 * 实施-14 F7：交接包生成失败后的**故障恢复**（cost 0，本机 fixture provider）。
 *
 * ── 为什么要有这一场 ──
 * §7.1 要求「包错误 / 模型不可用」时：原进度保留、错误按阶段分类、可恢复，
 * 且不虚报「已继续」。此前只有宿主函数的 vm 单测（`test-handoff-host-regression.mjs`）
 * 覆盖过这条路径，**没有真实 Electron + 真实 pi + 真实模型的运行证据**。
 *
 * ── 故障从哪来 ──
 * 本场景用隔离的本机 OpenAI 兼容 provider（`startHandoffFailureProvider`）：
 *   · 普通回合 → 回一段长文本，把上下文推长，让宿主的策略压缩**真实触发**；
 *   · 交接包生成请求（system prompt 里带「跨会话交接」）→ 回一句不是 JSON 的话，
 *     模拟「模型没能写出交接包」。
 * 所以链路是真的（真实 RPC、真实压缩、真实 host 资格判定与恢复），
 * 只有「模型写了什么」是 fixture 决定的 —— 因此本场是 **cost 0**，
 * 也不能当作模型写包质量的证据（那份证据在 `handoffpack` / `handoffautocompact`）。
 *
 * ── 要证明什么 ──
 *   ① 两次真实策略压缩后资格成立，宿主确实写下了生成请求；
 *   ② 薄层拿到坏输出 → 宿主把这一份丢弃并**释放占用**（pending 归零）；
 *   ③ 会话没有被换掉（仍绑定源片段、链上还只有一段）；
 *   ④ 目标没有被伪报完成，源片段恢复续跑；
 *   ⑤ 诊断事件里留下可追溯的失败原因（不是静默吞掉）。
 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
  }
  const bad = (label) => {
    out.push('  ✗ ' + label)
    return false
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const state = () => store.getState()
  const waitFor = async (fn, budgetMs, stepMs = 500) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(stepMs)
    }
    return null
  }
  const handoff = () => window.yan.getHandoff()
  const messages = () => state().messages ?? []
  const send = async (text, timeoutMs = 120000) => {
    const before = messages().length
    const result = await state().send(text)
    if (result?.ok === false) return { sent: false, settled: false }
    const settled = await waitFor(() => {
      const current = state()
      const fresh = messages().length > before
      const busy = current.session?.isAgentRunning === true || current.session?.isStreaming === true
      return fresh && !busy ? true : null
    }, timeoutMs, 350)
    if (settled) {
      await waitFor(() => {
        const session = state().session
        return session?.isAgentRunning !== true && session?.isStreaming !== true && session?.isCompacting !== true
          ? true
          : null
      }, 60000, 400)
    }
    return { sent: true, settled: !!settled }
  }
  const dump = async (label) => {
    const current = state()
    const h = await handoff().catch(() => null)
    const g = await window.yan.getGoal().catch(() => null)
    out.push('  —— 诊断（' + label + '）——')
    out.push('  conn=' + current.conn + ' running=' + current.session?.isAgentRunning + ' 消息=' + messages().length)
    out.push('  tokens=' + (current.stats?.contextUsage?.tokens ?? 'null') + ' 工作集=' + (current.session?.contextPolicy?.budget?.workingSet ?? '?'))
    out.push(
      '  压缩=' + (h?.segmentTally?.count ?? '?') + '/' + (h?.threshold ?? '?') +
      ' pending=' + h?.pending + ' 片段=' + h?.chainSegments +
      ' 目标=' + (g?.goal?.phase ?? '?') + ' 事务=' + (h?.transaction?.stage ?? '无')
    )
    for (const event of (h?.events ?? []).slice(-6)) {
      out.push('  event=' + event.stage + '/' + event.outcome + (event.reason ? '（' + event.reason + '）' : ''))
    }
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = document.querySelector('.ob-card')
    if (!card) break
    const button = [...card.querySelectorAll('button')].find((item) => /开始使用|完成/.test(item.textContent))
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(200)
    } else await sleep(100)
  }

  const ready = await waitFor(() => state().conn === 'ready', 30000, 250)
  ok(!!ready, 'pi RPC 已连接')
  if (!ready) {
    await dump('等待 RPC')
    return out.join('\n')
  }
  await sleep(700)

  const initial = await handoff()
  const sourceKey = String(initial.sessionKey ?? '')
  const workingSet = state().session?.contextPolicy?.budget?.workingSet ?? null
  out.push('=== 1. 前提（默认阈值 2，工作集只降测试档） ===')
  ok(!!sourceKey, '隔离源会话文件可识别')
  ok(initial.threshold === 2, '交接使用默认阈值 2（实际 ' + initial.threshold + '）')
  ok(initial.autoCommit === true, '自动交接默认开启')
  ok((initial.segmentTally?.count ?? 0) === 0, '源片段从零开始计数')
  ok(workingSet === 6000, '策略压缩工作集为隔离测试档 6000（实际 ' + workingSet + '）')
  if (!sourceKey || initial.threshold !== 2 || workingSet !== 6000) {
    await dump('初始条件不符')
    return out.join('\n')
  }
  await state().setWorkMode('standard')

  out.push('')
  out.push('=== 2. 真实策略压缩攒到阈值（标准档，没有目标所以不会交接） ===')
  let pressureTurns = 0
  for (let i = 1; i <= 20; i++) {
    const turn = await send('F7R 压力轮 ' + i + '：请把上下文继续写长，不要用手动压缩。')
    if (!turn.sent || !turn.settled) {
      bad('压力轮 ' + i + ' 未正常收尾（sent=' + turn.sent + ' settled=' + turn.settled + '）')
      await dump('压力轮未完成')
      break
    }
    pressureTurns++
    /*
     * 轮间必须停下 4 秒：策略触发的压缩有 **30 秒冷却**
     * （`POLICY_COOLDOWN_MS`），而本机 fixture provider 一轮只要一两秒 ——
     * 不等就直接跑完 20 轮，只会压到一次（实测就是这样）。
     */
    await sleep(4000)
    const current = await handoff()
    const tokens = state().stats?.contextUsage?.tokens
    const last = state().session?.lastCompaction
    out.push(
      '  · 第 ' + i + ' 轮后压缩 ' + (current.segmentTally?.count ?? 0) + '/2 · tokens=' +
      (typeof tokens === 'number' ? tokens : 'null') +
      ' · 最近压缩=' + (last?.status ?? '无') +
      (last?.error ? '（' + String(last.error).slice(0, 120) + '）' : '')
    )
    if ((current.segmentTally?.count ?? 0) >= 2) break
  }
  const compressed = await handoff()
  const tally = compressed.segmentTally?.count ?? 0
  ok(tally >= 2, '宿主实际记录至少两次成功自动完整压缩（' + tally + ' 次，压力轮 ' + pressureTurns + '）')
  if (tally < 2) {
    await dump('未达到默认阈值')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 3. 建立持续目标并切自主档，让资格成立 ===')
  const target = await state().setGoal({
    goal: '在隔离 fixture 中验证交接包生成失败后原会话继续推进，不虚报已继续。',
    outcome: '源片段保留、目标未完成、诊断里有可追溯的生成失败原因。'
  })
  ok(target?.ok === true, '宿主接受了持续目标')
  const seeded = await window.yan.getGoal()
  await state().setWorkMode('autonomous')
  const mode = await window.yan.getWorkMode()
  ok(mode.mode === 'autonomous', '当前会话已切到自主档（目标仍在 ' + seeded.goal.phase + '）')

  out.push('')
  out.push('=== 4. 触发一次回合，等待宿主的生成失败与释放 ===')
  const trigger = await send('F7R 触发轮：请只回复一句「继续」，然后结束本轮。')
  ok(trigger.sent && trigger.settled, '触发回合正常收尾')
  const failure = await waitFor(async () => {
    const h = await handoff()
    return (
      (h.events ?? []).find(
        (event) => event.stage === 'generate' && (event.outcome === 'unparsable' || event.outcome === 'failed')
      ) ?? null
    )
  }, 180000, 600)
  ok(!!failure, '诊断事件里记录了交接包生成失败（' + (failure ? failure.outcome : '没等到') + '）')
  if (!failure) {
    await dump('等待生成失败')
    return out.join('\n')
  }
  out.push('  失败原因=' + (failure.reason ?? '（无）'))

  const released = await waitFor(async () => {
    const h = await handoff()
    return h.pending === false ? h : null
  }, 60000, 500)
  ok(!!released, '失败后占用被释放（pending 归零，不会一直占着这一轮）')

  const after = await handoff()
  ok(after.sessionKey === sourceKey, '会话仍绑定源片段（没有被换掉）')
  ok(after.chainSegments === 1, '会话链仍是一段（没有建第二个目的片段）')
  ok(!after.transaction || after.transaction.stage !== 'resumed', '交接事务没有走到 resumed')

  const goalAfter = await window.yan.getGoal().catch(() => null)
  ok(goalAfter?.goal?.phase !== 'completed', '目标没有被伪报完成（实际 ' + (goalAfter?.goal?.phase ?? '?') + '）')

  out.push('')
  out.push('=== 5. 源片段恢复续跑（不是卡在失败态） ===')
  const beforeResume = messages().length
  const resumed = await waitFor(() => (messages().length > beforeResume ? true : null), 180000, 700)
  ok(!!resumed, '失败之后源片段又收到了新的回合（续行恢复）')
  const historyKept = messages().some((message) => message.role === 'user')
  ok(historyKept, '原有用户消息仍在（失败没有清历史）')

  out.push('')
  out.push('handoffrecover.sourceKey=' + sourceKey)
  out.push('handoffrecover.tally=' + tally)
  out.push('handoffrecover.pressureTurns=' + pressureTurns)
  out.push('handoffrecover.failureOutcome=' + failure.outcome)
  out.push('handoffrecover.failureOp=' + (failure.op ?? ''))
  out.push('handoffrecover.failureReason=' + (failure.reason ?? ''))
  out.push('handoffrecover.resumed=' + String(!!resumed))
  return out.join('\n')
})()
