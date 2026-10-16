/*
 * v3 发送键规则隔离探针（A2 验收，v2 `probe/sendkey.js` 的 v3 DOM 版）。
 *
 * 规则同 v2：默认 `sendKey:auto` 时 Enter 发送、不显示提示；改成 ctrlEnter 后
 * 提示常显且 Enter 不再发送、Ctrl+Enter 才发送；中文输入法组合态 Enter 让路。
 *
 * 不花 token 的办法：把 `store.send` 换成记录调用但不外发的 spy —— 真实发送链
 * （submitMessage → send）照跑，只是不出网、不调模型。Enter 的「拦不拦」直接看
 * `event.defaultPrevented`（决策本身），不拿「输入框是否清空」当判据。
 *
 * ⚠️ v3 现状（与 v2 的差异，如实记录、不作为失败）：v3 输入框没有长文模式开关
 *    （`composerSendKeyHint(sendKey, false)` 写死 false，也没有 composer-resize），
 *    精简设置里也没有 `set-send-key` 分段；本探针只验「提示 + 生效」两条。
 */
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
        /* 还没就绪 */
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const store = window.__yanStore

  const setValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
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
      /* 忽略 */
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    const ta = q('composer-input')

    /* spy：真实发送链照跑，只是不外发消息 */
    const sends = []
    const realSend = store.getState().send
    store.setState({ send: async (...args) => { sends.push(args); return true } })

    /* ---- 1. 默认 auto：不显示提示 ---- */
    out.push('')
    out.push('--- 1. 默认值 ---')
    const cur = store.getState().settings?.sendKey ?? '(未定义)'
    note(`settings.sendKey = ${JSON.stringify(cur)}`)
    check(cur === 'auto' || cur === undefined, '默认是 auto（短输入框 Enter 发送）')
    check(hintText().length === 0, `默认不显示发送键提示（实际 ${JSON.stringify(hintText())}）`)
    const resize = q('composer-resize')
    note(resize ? '存在长文模式开关 composer-resize' : 'v3 没有长文模式开关 composer-resize（与 v2 差异，跳过该分支）')

    /* ---- 2. 切成 Ctrl+Enter：提示出现 ---- */
    out.push('')
    out.push('--- 2. Ctrl+Enter 模式提示 ---')
    await store.getState().patchSettings({ sendKey: 'ctrlEnter' })
    check(await until(() => /Ctrl/i.test(hintText()), 3000), `提示变为「Ctrl+Enter 发送」（实际 ${JSON.stringify(hintText())}）`)

    /* ---- 3. Ctrl+Enter 模式下 Enter 不发送 ---- */
    out.push('')
    out.push('--- 3. 规则生效 ---')
    setValue(ta, 'YAN-V3-SENDKEY-PROBE')
    await wait(120)
    const before = sends.length
    const prevented = pressEnter(ta, false)
    await wait(250)
    check(ta.value.includes('YAN-V3-SENDKEY-PROBE'), 'Enter 没有触发发送（内容还在）')
    check(sends.length === before, '没有调用 send（未出网）')
    check(!prevented, 'Enter 未被拦截（交给换行 / 无动作）')
    const ctrlPrevented = pressEnter(ta, true)
    check(await until(() => sends.length > before, 2000), 'Ctrl+Enter 走真实发送链（经 spy，未出网）')
    check(ctrlPrevented, 'Ctrl+Enter 被拦截去发送')
    setValue(ta, '')

    /* ---- 4. 中文输入法组合态：Enter 让路 ---- */
    out.push('')
    out.push('--- 4. 输入法组合态 ---')
    await store.getState().patchSettings({ sendKey: 'auto' })
    await wait(200)
    setValue(ta, 'YAN-V3-IME-PROBE')
    await wait(120)
    const plainPrevented = pressEnter(ta, false)
    const imePrevented = pressImeEnter(ta)
    note(`非组合态 preventDefault=${plainPrevented} / 组合态 preventDefault=${imePrevented}`)
    check(plainPrevented, '非组合态 Enter 被拦下处理（发送）')
    check(!imePrevented, '组合态 Enter 未被拦（放行给输入法选词）')
    setValue(ta, '')

    /* ---- 5. 设置内改键：v3 精简设置没有该分段 ---- */
    out.push('')
    out.push('--- 5. 设置内改键 ---')
    const seg = q('set-send-key')
    if (seg) {
      check(true, '设置面板存在 set-send-key 分段')
    } else {
      note('v3 精简设置中没有 set-send-key 分段（改键只在 v2 Settings.tsx），本探针不改设置界面')
    }

    /* ---- 收尾 ---- */
    await store.getState().patchSettings({ sendKey: 'auto' })
    setValue(ta, '')
    store.setState({ send: realSend })
    out.push('证据范围：v3 发送键决策与提示；send 走 spy 未出网，不代表真实模型发送。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
