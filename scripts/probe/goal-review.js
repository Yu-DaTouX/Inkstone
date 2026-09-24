/*
 * G-4 计划审阅 ready → pending → approve 的真实端到端。
 *
 * 真实模型只负责按提示调用 `yan goal ready`；偏好设置、待审 UI、批准 IPC、
 * 模式 / 目标 CAS 与启动 follow-up 都经过隔离 Electron 的真实链路。
 * cwd 指向测试夹具仓库，模型不接触用户工作树。
 */
;(async () => {
  const out = []
  const ok = (condition, message) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + message)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const click = (element) => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const state = () => store.getState()
  const deadline = (ms) => Date.now() + ms
  const waitFor = async (fn, ms = 120_000, step = 350) => {
    const end = deadline(ms)
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await sleep(step)
    }
    return null
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const button = [...card.querySelectorAll('button')].find((item) => /开始使用|完成/.test(item.textContent))
      if (button) {
        click(button)
        await sleep(250)
      } else await sleep(120)
    }

    const connected = await waitFor(() => state().conn === 'ready', 60_000, 250)
    ok(!!connected, 'pi 已连接')
    if (!connected) return out.join('\n')

    const before = await window.yan.getGoal()
    ok(
      before.goal.phase === 'planning' && before.goal.revision === 0 && !before.goal.pendingReady,
      `测试会话没有既有目标（phase=${before.goal.phase} revision=${before.goal.revision}）`
    )

    const modeChanged = await state().setWorkMode('clarify')
    const mode = await window.yan.getWorkMode()
    ok(modeChanged !== false && mode.mode === 'clarify', `切到计划模式（${JSON.stringify(mode)}）`)
    const preferenceSaved = await state().setGoalReadyApproval('review')
    const readyState = await window.yan.getGoal()
    ok(
      preferenceSaved && readyState.goal.readyApproval === 'review',
      `真实 IPC 保存了审阅偏好（goal rev${readyState.goal.revision}）`
    )

    const command =
      'yan goal ready --transition-id tr-review-probe-1 --confidence 0.98 ' +
      '--goal "给设置页加一个导出按钮" --deliverable "导出按钮 + CSV 下载" ' +
      '--scope "仅设置页" --constraints "不引入新依赖" --acceptance "点一下能下载 CSV" ' +
      `--mode-revision ${mode.revision} --goal-revision ${readyState.goal.revision}`
    const assistantsBeforeReady = state().messages.filter((message) => message.role === 'assistant').length
    const prompt =
      '这是一次隔离功能自测。请只做一件事：用 bash 工具原样运行下面这一条命令，' +
      '然后把 stdout 原样贴出来。不要改参数、不要拆成多条命令、不要执行其它命令：\n\n' +
      command
    const sent = await state().send(prompt)
    ok(!sent || sent.ok !== false, '已发送唯一一条 ready 请求')

    const pending = await waitFor(async () => {
      const current = await window.yan.getGoal()
      return current.goal.pendingReady ? current : null
    })
    ok(!!pending, '真实 `yan goal ready` 提交并持久化待审计划')
    if (!pending) return out.join('\n')
    ok(
      pending.goal.phase === 'planning' && pending.mode.mode === 'clarify',
      `等待审阅时仍处于只读计划阶段（${pending.goal.phase} / ${pending.mode.mode}）`
    )
    ok(
      pending.goal.pendingReady.transitionId === 'tr-review-probe-1' &&
        pending.goal.pendingReady.understanding.acceptance.includes('CSV'),
      '五栏计划与本次 transitionId 由宿主持有'
    )

    const pendingIdle = await waitFor(() => {
      const current = state()
      const messages = current.messages
      const readyCall = messages.findIndex((message) =>
        (message.toolCalls ?? []).some(
          (call) => call.name === 'bash' && JSON.stringify(call.args ?? '').includes('yan goal ready')
        )
      )
      const answered =
        readyCall >= 0 &&
        messages.slice(readyCall + 1).some((message) => message.role === 'assistant' && !(message.toolCalls ?? []).length)
      const assistantsNow = messages.filter((message) => message.role === 'assistant').length
      const busy = current.session?.isStreaming === true || current.session?.isAgentRunning === true
      return answered && assistantsNow > assistantsBeforeReady && !busy && !q('.trow[data-state="running"]')
        ? true
        : null
    }, 60_000)
    ok(!!pendingIdle, 'ready 工具调用后的模型回复已结束，等待批准期间没有后台续跑')
    if (!pendingIdle) return out.join('\n')

    const entry = q('[data-testid="goal-entry"]')
    click(entry)
    const card = await waitFor(() => q('[data-testid="goal-pending-review"]'), 12_000, 200)
    ok(!!card, '目标浮层显示待审计划')
    ok(
      (card?.textContent ?? '').includes('给设置页加一个导出按钮') &&
        (card?.textContent ?? '').includes('点一下能下载 CSV'),
      '待审卡显示目标和验收字段'
    )
    const approve = q('[data-testid="goal-approve-and-start"]')
    ok(!!approve, '待审卡提供明确的批准并开始动作')
    const assistantsBefore = state().messages.filter((message) => message.role === 'assistant').length
    click(approve)

    const approved = await waitFor(async () => {
      const current = await window.yan.getGoal()
      if (
        current.goal.phase === 'executing' &&
        !current.goal.pendingReady &&
        current.mode.mode === 'standard'
      ) return current
      return null
    }, 30_000, 250)
    ok(
      !!approved,
      `批准后真实主进程提交 executing 并切到标准模式（${approved?.goal.phase ?? '未变化'} / ${approved?.mode.mode ?? '未知'}）`
    )

    const followUp = '请按刚才批准的计划开始执行。'
    const started = await waitFor(() => {
      const messages = state().messages
      return JSON.stringify(messages).includes(followUp) ? messages : null
    }, 15_000, 200)
    ok(!!started, '批准 IPC 向当前 runner 发送了计划启动消息')
    await sleep(500)
    const startFailure = state().notices.find((notice) => notice.text.includes('启动消息未送达'))
    ok(!startFailure, startFailure?.text ?? '主进程未报告启动消息投递失败')
    const followUpAccepted = await waitFor(() => {
      const current = state()
      const assistantsNow = current.messages.filter((message) => message.role === 'assistant').length
      const running = current.session?.isAgentRunning === true
      const queued = (current.queue?.followUp ?? []).some((item) => item.text === followUp)
      return running || assistantsNow > assistantsBefore || queued ? current : null
    }, 15_000, 200)
    ok(!!followUpAccepted, '启动消息已经进入 runner 回合或其队列')

    const bashCalls = state()
      .messages.flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.name === 'bash')
      .map((call) => JSON.stringify(call.args ?? ''))
    ok(bashCalls.some((text) => text.includes('yan goal ready')), '模型通过 bash 调用了宿主 `yan goal ready`')
    const finalGoal = await window.yan.getGoal()
    ok(
      finalGoal.goal.phase === 'executing' && !finalGoal.goal.pendingReady && finalGoal.mode.mode === 'standard',
      '完成 follow-up 后目标仍是已批准的 executing 状态'
    )
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error instanceof Error ? error.message : String(error)))
  }
  return out.join('\n')
})()
