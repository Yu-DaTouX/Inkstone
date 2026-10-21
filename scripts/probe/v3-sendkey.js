;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
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

  const composer = window.__yanComposer
  const setValue = (el, text) => composer.set(text, el)
  const hintText = () => (q('composer-keyhint')?.textContent ?? '').trim()
  const pressEnter = (el, ctrl) => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: !!ctrl, bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const pressImeEnter = (el) => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'isComposing', { value: true })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  try {
    out.push('=== v3 发送键规则（隔离探针）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    check(await until(() => !!q('composer-input'), 6000), '正式输入框已挂载')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    const ta = q('composer-input')

    const sends = []
    const realSend = store.getState().send
    store.setState({ send: async (...args) => { sends.push(args); return true } })

    out.push('')
    out.push('--- 1. 默认值 ---')
    const cur = store.getState().settings?.sendKey ?? '(未定义)'
    note(`settings.sendKey = ${JSON.stringify(cur)}`)
    check(cur === 'auto' || cur === undefined, '默认是 auto（短输入框 Enter 发送）')
    check(hintText().length === 0, `默认不显示发送键提示（实际 ${JSON.stringify(hintText())}）`)
    const resize = q('composer-resize')
    note(resize ? '存在长文模式开关 composer-resize' : 'v3 没有长文模式开关 composer-resize（与 v2 差异，跳过该分支）')

    out.push('')
    out.push('--- 2. Ctrl+Enter 模式 ---')
    await store.getState().patchSettings({ sendKey: 'ctrlEnter' })
    await wait(200)
    check(hintText().length === 0, `切到 Ctrl+Enter 后底栏仍不显示按键提示（实际 ${JSON.stringify(hintText())}）`)

    out.push('')
    out.push('--- 3. 规则生效 ---')
    setValue(ta, 'YAN-V3-SENDKEY-PROBE')
    await wait(120)
    const before = sends.length
    const prevented = pressEnter(ta, false)
    await wait(250)
    check(composer.text(ta).includes('YAN-V3-SENDKEY-PROBE'), 'Enter 没有触发发送（内容还在）')
    check(sends.length === before, '没有调用 send（未出网）')
    check(prevented && composer.text(ta).endsWith('\n'), 'Enter 由编辑器接管插入换行（内容未发出）')
    const ctrlPrevented = pressEnter(ta, true)
    check(await until(() => sends.length > before, 2000), 'Ctrl+Enter 走真实发送链（经 spy，未出网）')
    check(ctrlPrevented, 'Ctrl+Enter 被拦截去发送')
    setValue(ta, '')

    out.push('')
    out.push('--- 4. 输入法组合态 ---')
    await store.getState().patchSettings({ sendKey: 'auto' })
    await wait(200)
    setValue(ta, 'YAN-V3-IME-PROBE')
    await wait(120)
    const sendsBeforeIme = sends.length
    const plainPrevented = pressEnter(ta, false)
    await until(() => sends.length > sendsBeforeIme, 2000)
    await wait(700)
    setValue(ta, 'YAN-V3-IME-PROBE')
    await wait(300)
    const imeTextBefore = composer.text(ta)
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const imePrevented = pressImeEnter(ta)
    await wait(150)
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    await wait(150)
    note(`非组合态 preventDefault=${plainPrevented} / 组合态 preventDefault=${imePrevented} / 组合态前文本=${JSON.stringify(imeTextBefore)} / 之后=${JSON.stringify(composer.text(ta))}`)
    check(plainPrevented && sends.length > sendsBeforeIme, '非组合态 Enter 被拦下处理（发送）')
    check(!imePrevented && composer.text(ta).includes('YAN-V3-IME-PROBE'), '组合态 Enter 未被拦（内容还在，没有发送）')
    setValue(ta, '')

    out.push('')
    out.push('--- 5. 设置内改键 ---')
    const seg = q('set-send-key')
    if (seg) {
      check(true, '设置面板存在 set-send-key 分段')
    } else {
      note('v3 精简设置中没有 set-send-key 分段（改键只在 v2 Settings.tsx），本探针不改设置界面')
    }

    await store.getState().patchSettings({ sendKey: 'auto' })
    setValue(ta, '')
    store.setState({ send: realSend })
    out.push('证据范围：v3 发送键决策与提示；send 走 spy 未出网，不代表真实模型发送。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
