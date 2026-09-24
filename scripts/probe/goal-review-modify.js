/*
 * G-4 cost 0：对隔离数据中的真实 pendingReady 点击「修改计划」，
 * 验证 UI → store → preload → 主进程确实撤销待审计划且不开始执行。
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
  const waitFor = async (fn, ms = 12_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await sleep(200)
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

    const connected = await waitFor(() => state().conn === 'ready')
    ok(!!connected, '隔离 Electron 已连接')
    if (!connected) return out.join('\n')
    /* 目标 fixture 是按稳定会话文件键写入的；明确切到其中一份再读。 */
    const candidates = (state().sessions ?? []).filter((session) => session.path)
    let seededGoal = null
    for (const candidate of candidates) {
      if (state().session?.path !== candidate.path) {
        await state().switchSession(candidate.path)
        await waitFor(() => state().session?.path === candidate.path, 10_000)
      }
      const current = await window.yan.getGoal()
      if (current.goal.pendingReady?.transitionId === 'tr-review-modify-fixture') {
        seededGoal = current
        break
      }
    }
    ok(
      !!seededGoal?.goal.pendingReady,
      `主进程读到隔离待审计划（${seededGoal?.goal.phase ?? '无'} / 候选会话 ${candidates.length}）`
    )
    if (!seededGoal?.goal.pendingReady) return out.join('\n')
    const modeChanged = await state().setWorkMode('clarify')
    const before = await window.yan.getGoal()
    ok(
      modeChanged !== false && before.goal.phase === 'planning' &&
        before.goal.pendingReady?.transitionId === 'tr-review-modify-fixture' &&
        before.goal.readyApproval === 'review' &&
        before.mode.mode === 'clarify',
      `真实 IPC 切到计划模式并保留待审状态（${before.goal.phase} / ${before.mode.mode} / rev${before.goal.revision}）`
    )
    if (!before.goal.pendingReady || before.mode.mode !== 'clarify') return out.join('\n')

    click(q('[data-testid="goal-entry"]'))
    const card = await waitFor(() => q('[data-testid="goal-pending-review"]'))
    ok(!!card, '目标浮层显示已落盘的待审计划')
    ok(
      (card?.textContent ?? '').includes('隔离测试待审计划') && !!q('[data-testid="goal-modify-plan"]'),
      '待审计划显示可读内容和「修改计划」动作'
    )
    click(q('[data-testid="goal-modify-plan"]'))

    const modified = await waitFor(async () => {
      const current = await window.yan.getGoal()
      return current.goal.pendingReady == null &&
        current.goal.revision === before.goal.revision + 1 &&
        current.goal.phase === 'planning' &&
        current.mode.mode === 'clarify'
        ? current
        : null
    })
    ok(
      !!modified,
      `真实 IPC 清除待审快照并保留计划模式（phase=${modified?.goal.phase ?? '未变化'} rev=${modified?.goal.revision ?? '?'}）`
    )
    const cardRemoved = await waitFor(() => !q('[data-testid="goal-pending-review"]'))
    ok(!!cardRemoved, '修改后待审卡从目标面板消失')
    const startText = '请按刚才批准的计划开始执行。'
    ok(!JSON.stringify(state().messages).includes(startText), '修改动作没有生成批准启动消息')
    ok(state().notices.every((notice) => !notice.text.includes('批准计划')), '界面没有出现批准或启动提示')
    out.push('G-4 修改经真实 IPC 撤销待审快照')
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error instanceof Error ? error.message : String(error)))
  }
  return out.join('\n')
})()
