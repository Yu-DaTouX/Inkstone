;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore

  const composer = window.__yanComposer
  const setValue = (el, text) => composer.set(text, el)
  const activeRunner = (s) =>
    (s.runners ?? []).find((r) => r.isActive) ??
    (s.runners ?? []).find((r) => (r.runId ?? r.id) === s.activeRunnerId)
  const sessionRunning = (s) => s.session?.isAgentRunning === true
  const runnerRunning = (s) => !!activeRunner(s)?.running
  const runningNow = (s) => sessionRunning(s) || runnerRunning(s)

  const timeline = []
  let recording = false

  try {
    out.push('=== v3 真消息流式 / 停止（真实模型）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 10000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }
    check(await until(() => !!q('composer-input'), 8000), '正式输入框已挂载')
    check(await until(() => store.getState().conn === 'ready', 120000), `pi 已就绪（conn=${store.getState().conn}）`)

    store.subscribe((s) => {
      if (!recording) return
      timeline.push({ t: Date.now(), session: sessionRunning(s), runner: runnerRunning(s) })
    })

    const sendText = async (text) => {
      const ta = q('composer-input')
      if (!ta) return false
      setValue(ta, text)
      const ready = await until(() => {
        const b = q('composer-send')
        return !!b && b.disabled !== true && b.getAttribute('aria-disabled') !== 'true'
      }, 6000)
      if (!ready) return false
      q('composer-send')?.click()
      return true
    }

    out.push('')
    out.push('--- 1. 流式期间工作行 / 计时 ---')
    const statsBefore = store.getState().stats?.tokens?.total ?? 0
    timeline.length = 0
    recording = true
    check(
      await sendText('请用 6 条要点介绍 Inkstone（砚）的界面设计思路，每条一句话。不要调用任何工具。'),
      '第一条消息已提交'
    )
    check(await until(() => runningNow(store.getState()), 45000), '第一条进入运行中')

    const workLine = () => document.querySelector('[data-testid="v3-turn-activity"][data-working]')
    const workTime = () => workLine()?.querySelector('.v3-act-time:not([data-testid="v3-working-tokens"])')
    const sawSlot = await until(() => !!workLine() && !!workTime() && workLine().getAttribute('data-quiet') !== 'true', 30000)
    const slotText = (workLine()?.textContent ?? '').trim()
    const timeText = (workTime()?.textContent ?? '').trim()
    const phaseText = (workLine()?.querySelector('.v3-act-text')?.textContent ?? '').trim()
    check(sawSlot, `对话里的工作行出现（${JSON.stringify(slotText)}）`)
    check(/^\d+s$|^\d+m \d+s$/.test(timeText), `工作行显示计时（${JSON.stringify(timeText)}）`)
    check(phaseText.length > 0, `工作行显示阶段文字（${JSON.stringify(phaseText)} · ${workLine()?.getAttribute('data-working')}）`)

    const finished = await until(() => !runningNow(store.getState()), 240000)
    recording = false
    check(finished, '第一条自然结束')
    check(await until(() => !!q('composer-send') && !q('composer-stop'), 15000), '结束后回到发送键')
    const grew = await until(() => (store.getState().stats?.tokens?.total ?? 0) > statsBefore, 30000)
    const statsAfter = store.getState().stats?.tokens?.total ?? 0
    check(grew, `会话统计 token 增长（${statsBefore} → ${statsAfter}）`)

    out.push('')
    out.push('--- 2. 空输入同位置停止 / 点停止中止 ---')
    timeline.length = 0
    recording = true
    check(
      await sendText('请再写一段约 300 字、分多段的文字介绍砚的界面风格。不要调用任何工具。'),
      '第二条消息已提交'
    )
    check(await until(() => runningNow(store.getState()), 45000), '第二条进入运行中')
    const stopShown = await until(() => !!q('composer-stop') && !q('composer-send'), 45000)
    check(stopShown, '运行中 + 空输入 → 同位显示停止')
    const lineEnd = document.querySelector('.composer-line-end')
    check(!!lineEnd && lineEnd.lastElementChild === q('composer-stop'), '停止键位于输入行最右侧（与发送同位置）')
    check(sessionRunning(store.getState()) && runnerRunning(store.getState()), '点击停止前 runner 与 session 都为运行中')

    q('composer-stop')?.click()
    const aborted = await until(() => !sessionRunning(store.getState()) && !runnerRunning(store.getState()), 30000)
    check(aborted, '点停止后回合中止')
    check(await until(() => !!q('composer-send') && !q('composer-stop'), 15000), '中止后回到发送键')
    recording = false

    out.push('')
    out.push('--- 3. runner.running 与 session.isAgentRunning 一致性 ---')
    const groups = []
    for (const s of timeline) {
      const last = groups[groups.length - 1]
      if (last && last.session === s.session && last.runner === s.runner) {
        last.until = s.t
        continue
      }
      groups.push({ session: s.session, runner: s.runner, from: s.t, until: s.t })
    }
    const stable = groups.filter((g) => g.until - g.from >= 300)
    const bad = stable.filter((g) => g.session !== g.runner)
    check(
      bad.length === 0,
      `稳定采样里 runner.running === session.isAgentRunning（${stable.length} 组，${bad.length} 组不一致）`
    )
    if (bad.length) note(`不一致组：${JSON.stringify(bad.slice(0, 4))}`)
    check(timeline.some((x) => x.session && x.runner), '记录到「两者同时为真」的时间线')
    if (timeline.length) {
      note(`时间线采样 ${timeline.length} 个；首尾：${JSON.stringify(timeline[0])} → ${JSON.stringify(timeline[timeline.length - 1])}`)
    }

    const cost = store.getState().stats?.cost
    if (typeof cost === 'number') note(`会话累计费用（pi 口径）≈ $${cost.toFixed(6)}`)
    out.push('证据范围：真实模型回合（流式 / 停止 / 统计），模型固定 commandcode/deepseek/deepseek-v4.1-flash。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
