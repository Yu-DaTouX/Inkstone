/**
 * 实施-14 F7：保留正式默认交接阈值 2，真实触发两次策略压缩，再验自动交接。
 *
 * 先用隔离 fixture 的小工作集攒压缩计数（标准档，没有活跃目标，所以不会提前交接），
 * 然后设定真实目标、切到自主档，由目标报告触发已达阈值的交接。目的段必须用 bash
 * 写入并读取 proof 文件，最后由宿主记录目标完成。所有数据都在 test-live 沙盒中。
 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
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
  const toolCalls = () => (state().messages ?? []).flatMap((message) => message.toolCalls ?? [])
  const send = async (text, timeoutMs = 150000) => {
    const before = (state().messages ?? []).length
    const result = await state().send(text)
    if (result?.ok === false) return { sent: false, settled: false }
    const settled = await waitFor(() => {
      const current = state()
      const newAssistant = (current.messages ?? []).slice(before).some((message) => message.role === 'assistant')
      const busy = current.session?.isAgentRunning === true || current.session?.isStreaming === true
      return newAssistant && !busy ? true : null
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
    out.push('  conn=' + current.conn + ' running=' + current.session?.isAgentRunning + ' tools=' + toolCalls().length)
    out.push(
      '  压缩=' + (h?.segmentTally?.count ?? '?') + '/' + (h?.threshold ?? '?') +
      ' mode=' + (g?.mode?.mode ?? '?') + ' goal=' + (g?.goal?.phase ?? '?') +
      ' transaction=' + (h?.transaction?.stage ?? '无')
    )
    for (const call of toolCalls().slice(-4)) out.push('  tool=' + JSON.stringify(call.args ?? {}).slice(0, 180))
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
  const sourceSegment = String(initial.segmentTally?.segmentId ?? '')
  const workingSet = state().session?.contextPolicy?.budget?.workingSet ?? null
  out.push('=== 1. 前提 ===')
  ok(!!sourceKey, '隔离源会话文件可识别')
  ok(initial.threshold === 2, '交接使用默认阈值 2（实际 ' + initial.threshold + '）')
  ok(initial.autoCommit === true, '自动提交默认开启')
  ok((initial.segmentTally?.count ?? 0) === 0, '源片段从零开始计数')
  out.push('  当前测试工作集=' + (workingSet ?? '未知') + ' · 仅上下文策略降至 6k，未覆盖交接阈值')
  ok(workingSet === 6000, '真实策略压缩工作集采用隔离测试档 6000')
  if (!sourceKey || initial.threshold !== 2 || initial.autoCommit !== true || workingSet !== 6000) {
    await dump('初始条件不符')
    return out.join('\n')
  }
  await state().setWorkMode('standard')

  out.push('')
  out.push('=== 2. 真实自动压缩：至多 22 轮，达到两次即停止压力输入 ===')
  const compactions = new Map()
  let pressureTurns = 0
  for (let i = 1; i <= 22; i++) {
    const prompt =
      'F7 压缩验收压力轮 ' + i +
      '：必须使用 bash 运行 seq 1 900，然后只回复 F7_PRESSURE_' + i +
      '。保持这条会话内容完整，不要手动压缩。'
    const beforeTools = toolCalls().length
    let turn = await send(prompt)
    if (turn.sent && turn.settled && toolCalls().length === beforeTools) {
      out.push('  · 第 ' + i + ' 轮没有工具调用，再试一次')
      turn = await send(prompt)
    }
    if (!turn.sent || !turn.settled) {
      out.push('  ✗ 压力轮 ' + i + ' 未正常收尾（sent=' + turn.sent + ' settled=' + turn.settled + '）')
      await dump('压力轮未完成')
      break
    }
    pressureTurns++
    const last = state().session?.lastCompaction
    if (last?.status === 'completed' && last.endedAt) compactions.set(String(last.endedAt), last)
    const current = await handoff()
    out.push(
      '  · 第 ' + i + ' 轮后压缩 ' + (current.segmentTally?.count ?? 0) +
      '/2，pi 最近记录=' + (last?.reason ?? last?.reasonRaw ?? '无')
    )
    if ((current.segmentTally?.count ?? 0) >= 2) break
  }
  const compressed = await handoff()
  const observed = Math.max(compactions.size, compressed.segmentTally?.count ?? 0)
  out.push('  已完成压力轮=' + pressureTurns + ' · 独立完成压缩记录=' + observed)
  ok((compressed.segmentTally?.count ?? 0) >= 2, '宿主实际记录至少两次成功自动完整压缩')
  if ((compressed.segmentTally?.count ?? 0) < 2) {
    await dump('未达到默认阈值')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 3. 设定持续目标，交接阈值仍为 2 ===')
  const target = await state().setGoal({
    goal: '在隔离 fixture 中完成自动压缩后的跨会话续跑验收：目的片段写入并核验 handoff-f7-proof.txt，然后报告完成。',
    outcome: '会话链至少两段；新目的片段中有 bash 写入与读取 F7_HANDOFF_RESUMED 的证据，文件存在，目标由宿主记录为 completed。'
  })
  const seededGoal = await window.yan.getGoal()
  ok(target?.ok === true, '宿主接受了带可衡量成果的持续目标')
  const goalRevision = seededGoal.goal.revision
  ok(seededGoal.goal.phase === 'planning' && goalRevision > 0, '目标从 planning 开始（revision ' + goalRevision + '）')
  await state().setWorkMode('autonomous')
  const mode = await window.yan.getWorkMode()
  ok(mode.mode === 'autonomous', '当前会话已切到自主档')

  const reportCommand =
    'yan goal report --report-id f7-handoff-start --phase executing --goal-revision ' + goalRevision
  const reportPrompt = [
    '请只运行下面这一条 bash 命令，然后结束本轮并让目标保持未完成：',
    reportCommand,
    '',
    '本任务需要跨会话继续。目的片段续接后，必须先用 bash 执行：',
    'printf \"F7_HANDOFF_RESUMED\\\\n\" > handoff-f7-proof.txt && cat handoff-f7-proof.txt',
    '核对输出正是 F7_HANDOFF_RESUMED 后，再运行：',
    'yan goal report --report-id f7-handoff-finish --phase completed --goal-revision ' +
      (goalRevision + 1) +
      ' --evidence \"目的片段读取 handoff-f7-proof.txt，内容为 F7_HANDOFF_RESUMED\"',
    '在该命令成功前不要报告完成。'
  ].join('\n')
  const sent = await send(reportPrompt, 120000)
  ok(sent.sent && sent.settled, '模型真实调用 yan goal report 推进目标')
  if (!sent.sent || !sent.settled) {
    await dump('目标报告未完成')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 4. 默认阈值自动提交并由目的片段完成目标 ===')
  const stages = []
  const committed = await waitFor(async () => {
    const h = await handoff()
    const stage = h.transaction?.stage ?? (h.sessionKey ? 'none' : 'no-runner')
    if (stages.at(-1) !== stage) stages.push(stage)
    return h.transaction?.stage === 'resumed' && h.chainSegments >= 2 && h.sessionKey !== sourceKey ? h : null
  }, 300000, 700)
  out.push('  事务阶段=' + (stages.join(' → ') || '无'))
  ok(!!committed, '默认阈值触发真实交接事务至 resumed')
  if (!committed) {
    await dump('等待交接提交')
    return out.join('\n')
  }
  ok(committed.sessionKey !== sourceKey, '活动会话身份已绑定目的片段')
  ok(committed.chainSegments >= 2, '同一逻辑会话链含至少两个片段（' + committed.chainSegments + '）')
  ok(committed.segmentTally?.count === 0, '新目的片段计数从零开始')
  const resumeConfirmed = await waitFor(async () => {
    const h = await handoff()
    return h.events.find((event) => event.outcome === 'resume-confirmed') ?? null
  }, 60000, 600)
  ok(!!resumeConfirmed, '目的片段消费并确认了内部续接')
  const resumeAt = resumeConfirmed?.at ?? Date.now()

  const proofTurn = await waitFor(async () => {
    const calls = toolCalls()
    const wrote = calls.some((call) =>
      (Number(call.startedAt) || 0) >= resumeAt &&
      JSON.stringify(call.args ?? {}).includes('handoff-f7-proof.txt')
    )
    const goal = await window.yan.getGoal()
    return wrote && goal.goal.phase === 'completed' ? goal : null
  }, 240000, 800)
  ok(!!proofTurn, '目的片段运行工具并通过宿主报告目标完成')
  if (!proofTurn) await dump('等待目的片段 proof 与完成报告')
  out.push('handoffautocompact.sourceKey=' + sourceKey)
  out.push('handoffautocompact.sourceSegment=' + sourceSegment)
  out.push('handoffautocompact.compactions=' + observed)
  out.push('handoffautocompact.threshold=' + initial.threshold)
  out.push('handoffautocompact.goalCompleted=' + String(proofTurn?.goal?.phase === 'completed'))
  return out.join('\n')
})()
