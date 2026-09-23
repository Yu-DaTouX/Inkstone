/**
 * 实施-14 F7：**连续两次交接**（cost 1，阈值 0 测试通道）。
 *
 * ── 为什么单独一场 ──
 * 默认阈值 2 的真实自动压缩链已经由 `handoffautocompact` 覆盖（两次压缩 → 一次交接）。
 * 但用户现场是「两次压缩之后交接」，**再压两次又交接** —— 也就是同一条逻辑会话上
 * 连续换段。单次交接验不出这类问题：第二次交接要在「已经换过一段」的实例上再做一遍
 * 停源 / 建目的 / 写链 / 发内部续接，任何一处把身份、模式、目标或计时当一次性状态，
 * 第二次就会露出来。
 *
 * ── 测试通道 ──
 * `YAN_HANDOFF_THRESHOLD=0`：真实链路要攒两次真实自动压缩（那是全项目最贵的场景），
 * 连续两次交接就得攒四次。阈值 0 只把「够不够数」这一步压掉，其余（资格、生成、
 * 提交、内部续接、目标继承、前端单一会话）全部是真的。**它是测试通道行为，
 * 不是生产默认**：生产阈值 2 下第二次交接同样要再压两次。
 *
 * ── 要证明什么 ──
 *   ① 链上真的出现第三段（`chainSegments >= 3`），两次事务都到 resumed；
 *   ② 稳定逻辑身份（`conversationId`）跨两次换段不变 —— 前端仍是同一条会话；
 *   ③ 历史、草稿身份、模式与用户目标跟着走，不因第二次换段丢掉；
 *   ④ 源段的消息仍留在同一条时间线里；
 *   ⑤ 收尾能停住（目标一停就不再排第三次）。
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
  const short = (key) => String(key ?? '').split(/[\\/]/).pop() ?? ''
  const waitFor = async (fn, budgetMs, stepMs = 800) => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(stepMs)
    }
    return null
  }
  const handoff = () => window.yan.getHandoff()
  const dump = async (label) => {
    const h = await handoff().catch(() => null)
    const g = await window.yan.getGoal().catch(() => null)
    out.push('  —— 诊断（' + label + '）——')
    out.push(
      '  片段=' + (h?.chainSegments ?? '?') + ' 阈值=' + (h?.threshold ?? '?') +
      ' pending=' + h?.pending + ' 事务=' + (h?.transaction?.stage ?? '无') +
      ' 目标=' + (g?.goal?.phase ?? '?') + '/' + (g?.goal?.revision ?? '?') +
      ' 模式=' + (g?.mode?.mode ?? '?')
    )
    out.push('  当前段=' + short(h?.sessionKey) + ' 逻辑身份=' + (state().session?.conversationId ?? '（无）'))
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
      await sleep(220)
    } else await sleep(120)
  }

  const ready = await waitFor(() => state().conn === 'ready', 30000, 250)
  ok(!!ready, 'pi RPC 已连接')
  if (!ready) {
    await dump('等待连接')
    return out.join('\n')
  }
  await sleep(800)

  out.push('')
  out.push('=== 1. 前提：自主档 + 阈值 0 测试通道 + 自动提交默认开 ===')
  await state().setWorkMode('autonomous')
  await sleep(600)
  const initial = await handoff()
  const sourceKey = String(initial.sessionKey ?? '')
  /*
   * 稳定逻辑身份（F3）只在**交接后**才由宿主推给前端（`handoff-rebind`），
   * 未换过段时 `conversationId` 本来就是空的 —— 拿它当初次前提会误报。
   * 所以这里记下当前**物理**身份，换段后再断言 conversationId 绑定到了它。
   */
  const sessionId0 = String(state().session?.sessionId ?? '')
  /*
   * 阈值两种跑法：
   *   · 0 —— 测试通道（快、便宜，只验“换段链”本身）；
   *   · 2 —— **生产默认值**：`handoffchaindefault` 用小工作集让两次真实压缩
   *          在有限轮次内凑得齐，验的就是“默认阈值下也能连续两次交接”。
   * 其它值不认：那说明设置被意外改了，不该静默当作某一支跑。
   */
  const threshold = Number(initial.threshold)
  const thresholdOk = threshold === 0 || threshold === 2
  ok(thresholdOk, '阈值是 0（测试通道）或 2（生产默认），实际 ' + initial.threshold)
  ok(initial.autoCommit === true, '自动交接默认开启（本场景不设开关）')
  ok(initial.chainSegments === 1, '起点只有一段（实际 ' + initial.chainSegments + '）')
  ok(!!sourceKey, '源片段可识别')
  ok(!!sessionId0, '源片段有物理会话身份')
  if (!thresholdOk || !sourceKey || !sessionId0) {
    await dump('前提不符')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 2. 建立持续目标并让模型报一次进展 ===')
  /*
   * 生产阈值 2 需要本片段真的攒够两次压缩。阈值 0 的那一支不需要。
   *
   * 为什么把压力轮放在**目标之前**（与 `handoffautocompact` 同一手法）：
   * 带目标时会自动续跑，压力轮会和“交接包生成”抢时间 —— 实测生成请求写出之后
   * 水位还在动，`safety-boundary` 会以 `source-watermark-moved` 放弃生成。
   * 先把计数攒够、回到静止，再上目标，交接才干净。
   *
   * 压力轮走 `standard` 档：关掉自动续跑，回合边界可数。
   */
  const pressurize = async (deadlineMs) => {
    const prevMode = String((await window.yan.getWorkMode())?.mode ?? 'autonomous')
    await state().setWorkMode('standard')
    const deadline = Date.now() + deadlineMs
    for (let i = 1; i <= 22 && Date.now() < deadline; i += 1) {
      const before = (state().messages ?? []).length
      const sent = await state().send(
        'F7 链式交接压力轮 ' + i + '：必须使用 bash 运行 seq 1 900，然后只回复 F7_CHAIN_' + i + '。'
      )
      if (sent && sent.ok === false) break
      await waitFor(() => {
        const current = state()
        const settled = (current.messages ?? []).slice(before).some((m) => m.role === 'assistant')
        const busy = current.session?.isAgentRunning === true || current.session?.isStreaming === true
        return settled && !busy ? true : null
      }, 150000, 350)
      const tally = Number((await handoff())?.segmentTally?.count ?? 0)
      if (tally >= threshold) break
    }
    if (prevMode !== 'standard') await state().setWorkMode(prevMode)
    return Number((await handoff())?.segmentTally?.count ?? 0)
  }
  if (threshold === 2) {
    const driven = await pressurize(300000)
    out.push('  本片段压缩计数 = ' + driven + '（阈值 ' + threshold + '）')
  }
  const target = await state().setGoal({
    goal: '验证同一条逻辑会话连续两次后台换段：身份、历史、模式与目标都不丢。',
    outcome: '链上出现第三段、两次事务都到 resumed、conversationId 保持不变、源段消息仍在时间线里。'
  })
  ok(target?.ok === true, '宿主接受了持续目标')
  const seeded = await window.yan.getGoal()
  const revision = seeded.goal.revision
  const command = 'yan goal report --report-id f7-chain-1 --phase executing --goal-revision ' + revision
  const prompt = [
    '这是一次功能自测，请严格只做两件事：',
    '1) 用 bash 工具**原样、单行**运行下面这条命令，把 stdout 贴出来：',
    '',
    command,
    '',
    '2) 然后**立刻结束本轮回复**（只写一句「收尾」），不要执行其它命令、不要写文件。'
  ].join('\n')
  const sent = await state().send(prompt)
  ok(!sent || sent.ok !== false, '消息已发送')
  const reported = await waitFor(async () => {
    const goal = await window.yan.getGoal()
    return goal.goal.revision > revision ? goal : null
  }, 120000)
  ok(!!reported, '目标进入执行（rev' + (reported?.goal?.revision ?? '?') + '）')
  if (!reported) {
    await dump('等待目标推进')
    return out.join('\n')
  }

  out.push('')
  out.push('=== 3. 第一次交接 ===')
  const first = await waitFor(async () => {
    const h = await handoff()
    return h.transaction?.stage === 'resumed' && h.chainSegments >= 2 && h.sessionKey !== sourceKey ? h : null
  }, 240000)
  const firstKey = String(first?.sessionKey ?? '')
  ok(!!first, '第一次交接走到 resumed，链上出现第二段')
  if (!first) {
    await dump('等待第一次交接')
    return out.join('\n')
  }
  ok(short(firstKey) !== short(sourceKey), '当前段已切到第一份目的片段')
  const conversationId1 = String(state().session?.conversationId ?? '')
  ok(!!conversationId1, '第一次交接后前端拿到了稳定逻辑身份 conversationId')
  ok(conversationId1 === sessionId0, '交接后的 conversationId 绑定的是源片段身份（' + conversationId1 + '）')

  out.push('')
  out.push('=== 4. 第二次交接（在同一份目的片段上再来一遍） ===')
  if (threshold === 2) {
    const driven2 = await pressurize(360000)
    out.push('  目的片段压缩计数 = ' + driven2 + '（阈值 ' + threshold + '）')
  }
  const second = await waitFor(async () => {
    const h = await handoff()
    return h.transaction?.stage === 'resumed' && h.chainSegments >= 3 && h.sessionKey !== firstKey ? h : null
  }, 300000)
  const secondKey = String(second?.sessionKey ?? '')
  ok(!!second, '第二次交接也走到 resumed，链上出现第三段')
  if (!second) {
    await dump('等待第二次交接')
    return out.join('\n')
  }
  ok(short(secondKey) !== short(firstKey), '当前段又前进了一份（三份物理文件）')

  out.push('')
  out.push('=== 5. 稳定身份与历史：第二次换段也不能丢 ===')
  const conversationId2 = String(state().session?.conversationId ?? '')
  ok(!!conversationId2 && conversationId2 === conversationId1, '稳定逻辑身份跨两次换段不变（' + conversationId2 + '）')
  /*
   * 历史是**异步**推上来的：第二次交接后目的实例的 sync 要晚一拍（F4 的 rebind
   * 只换绑定，不搬运历史）。这里等的是前端时间线；宿主侧的链历史用
   * `peekSession` 单独查（它不依赖前端刷新时机，是更硬的证据）。
   */
  const historyBack = await waitFor(
    () => ((state().messages ?? []).some((message) => String(message.text ?? '').includes('这是一次功能自测')) ? true : null),
    60000,
    700
  )
  const peek = await window.yan.peekSession(secondKey).catch(() => null)
  const peekTexts = (peek?.messages ?? []).map((message) => String(message.text ?? ''))
  ok(
    peekTexts.some((text) => text.includes('这是一次功能自测')),
    '宿主侧链历史里保留最初那轮用户消息（三段拼成一条时间线）'
  )
  ok(!!historyBack, '前端时间线也重新拉到了源段消息（不是只显示最后一段）')
  if (!historyBack || !peekTexts.some((text) => text.includes('这是一次功能自测'))) {
    const now = (state().messages ?? []).map((message) => String(message.text ?? ''))
    out.push('  前端时间线（' + now.length + ' 条）：' + now.map((t) => JSON.stringify(t.slice(0, 20))).join(' | '))
    out.push('  链历史（' + peekTexts.length + ' 条）：' + peekTexts.map((t) => JSON.stringify(t.slice(0, 20))).join(' | '))
  }
  const modeAfter = await window.yan.getWorkMode()
  ok(modeAfter.mode === 'autonomous', '模式仍是自主档（实际 ' + modeAfter.mode + '）')
  const goalAfter = await window.yan.getGoal()
  ok(
    goalAfter.goal.phase !== 'completed' && (goalAfter.goal.goalId ?? '') !== '',
    '用户目标仍在推进（phase=' + goalAfter.goal.phase + '）'
  )
  ok(
    String(goalAfter.goal.brief?.goal ?? '').includes('连续两次后台换段'),
    '目标里保留的是**用户原话**，不是摘要改写'
  )

  out.push('')
  out.push('=== 6. 收尾：停住后不再排第三次 ===')
  const stopped = await window.yan.stopGoal().catch(() => null)
  ok(stopped?.ok === true, '宿主接受了停止目标')
  const beforeCount = String(second.transaction?.handoffId ?? '')
  await sleep(8000)
  const settle = await handoff()
  ok(settle.chainSegments === 3, '停止后没有继续排新的交接（仍为 3 段）')
  ok(
    String(settle.transaction?.handoffId ?? '') === beforeCount || settle.transaction === null,
    '没有第三次交接事务在推进'
  )

  out.push('')
  out.push('handoffchain.sourceKey=' + sourceKey)
  out.push('handoffchain.firstKey=' + firstKey)
  out.push('handoffchain.secondKey=' + secondKey)
  out.push('handoffchain.conversationId=' + conversationId2)
  out.push('handoffchain.segments=' + settle.chainSegments)
  out.push('handoffchain.reported=' + String(reported.goal.revision))
  return out.join('\n')
})()
