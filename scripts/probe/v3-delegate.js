;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
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
  const setNativeValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const openDialog = async () => {
    q('composer-plus')?.click()
    await until(() => !!q('composer-plus-menu'), 3000)
    q('composer-plus-delegate')?.click()
    return until(() => !!q('v3-delegate-dialog'), 3000)
  }
  const press = (el) => {
    if (!el) return false
    const base = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, detail: 1 }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', base))
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
    return true
  }
  const pressByKey = (el) => {
    if (!el) return false
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    return true
  }

  try {
    out.push('=== v3 手动派发子 Agent（隔离探针，不提交）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
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

    const realModels = store.getState().models
    const realSession = store.getState().session
    const models = [
      { id: 'probe-pi-model', name: 'Probe Pi Model', provider: 'probe-provider', reasoning: true, contextWindow: 200000 },
      { id: 'cc-model', name: 'CC Model', provider: 'claude-bridge', reasoning: false, contextWindow: 200000 }
    ]
    store.setState({ models, session: { ...(realSession ?? {}), model: models[0], cwd: realSession?.cwd ?? 'E:\\probe' } })

    out.push('')
    out.push('--- 1. 入口与默认值 ---')
    check(await openDialog(), '「＋」菜单里有派发子 Agent 入口并能打开表单')
    check(!!q('v3-delegate-task') && !!q('v3-delegate-model') && !!q('v3-delegate-scope'), '表单有任务 / 模型 / 执行位置三项')
    check(q('v3-delegate-target')?.textContent?.includes('Probe Pi Model') === true, `目标行显示当前模型（${JSON.stringify(q('v3-delegate-target')?.textContent)}）`)
    check(q('v3-delegate-start')?.disabled === true || q('v3-delegate-start')?.getAttribute('data-disabled') === 'true', '任务为空时「开始」禁用')

    out.push('')
    out.push('--- 2. 填写任务后可提交 ---')
    const textarea = q('v3-delegate-task')?.querySelector('textarea')
    setNativeValue(textarea, '核对这个仓库的 README 是否过期')
    await wait(150)
    check(!(q('v3-delegate-start')?.disabled || q('v3-delegate-start')?.getAttribute('data-disabled') === 'true'), '有任务且模型可用时「开始」可点')

    out.push('')
    out.push('--- 3. 只读不支持时的提示 ---')
    store.setState({ session: { ...store.getState().session, model: models[1] } })
    await wait(250)
    check(!!q('v3-delegate-readonly-hint'), 'CC 订阅模型显示只读不可用提示')
    check(!!q('v3-delegate-dialog'), '表单仍在')

    out.push('')
    out.push('--- 4. 取消 ---')
    const cancelButton = [...document.querySelectorAll('[data-testid="v3-delegate-dialog"] button')].find((b) => b.textContent?.trim() === '取消' || b.textContent?.trim() === 'Cancel')
    press(cancelButton)
    const closedByPress = await until(() => !q('v3-delegate-dialog'), 3000)
    if (!closedByPress) pressByKey(cancelButton)
    check(closedByPress || (await until(() => !q('v3-delegate-dialog'), 3000)), '取消后表单关闭')

    out.push('')
    out.push('--- 5. peek 别的会话时入口禁用 ---')
    store.setState({ peekedSessionId: 'probe-other-session' })
    q('composer-plus')?.click()
    await until(() => !!q('composer-plus-menu'), 3000)
    const item = q('composer-plus-delegate')
    check(item?.getAttribute('aria-disabled') === 'true' || item?.hasAttribute('data-disabled'), '入口被禁用')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    store.setState({ peekedSessionId: null })

    store.setState({ models: realModels, session: realSession })
    out.push('证据范围：v3 派发表单的 DOM 行为；未提交、未启动子 Agent、未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
