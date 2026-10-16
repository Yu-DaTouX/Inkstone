;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  const setValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const hintText = () => (q('[data-testid="composer-keyhint"]')?.textContent ?? '').trim()

  try {
    out.push('=== 1. 默认值保持原有习惯 ===')
    const cur = store.getState().settings?.sendKey ?? '(未定义)'
    out.push('  settings.sendKey = ' + JSON.stringify(cur))
    ok(cur === 'auto' || cur === undefined, '默认是 auto（短输入框 Enter 发送、长文模式换行）')

    out.push('')
    out.push('=== 2. 默认状态下**不**显示提示（用户要求） ===')
    let hint = hintText()
    out.push('  默认提示文案: ' + JSON.stringify(hint))
    ok(hint.length === 0, '默认输入框不显示发送规则（输入区不添噪声）')

    const resize = q('[data-testid="composer-resize"]')
    ok(!!resize, '找到拖拽柄（点击 = 切长文模式）')
    resize?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(350)
    const tallHint = hintText()
    out.push('  长文模式提示文案: ' + JSON.stringify(tallHint))
    ok(tallHint.length > 0, '长文模式下提示出现（Enter 语义变了，必须写出来）')
    ok(/Enter/.test(tallHint), '提示里写明了 Enter 的分工')

    const composer = q('.composer')
    const textarea = q('[data-testid="composer"]')
    resize?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(70)
    const animating = !!composer?.classList.contains('animating')
    const props = textarea ? getComputedStyle(textarea).transitionProperty : '(无输入框)'
    out.push(`  收起瞬间: animating=${animating} transition=${props}`)
    ok(animating, '收起瞬间标记了 animating（只在这一刻开过渡）')
    ok(/height/.test(props), '过渡属性里含 height（收起不再瞬跳）')
    await sleep(400)
    const stillAnimating = !!q('.composer')?.classList.contains('animating')
    ok(!stillAnimating, '动画结束后标记被移除（打字时不拖着高度）')
    out.push('  退出长文模式后: ' + JSON.stringify(hintText()))
    ok(hintText().length === 0, '退出长文模式后提示收回')

    out.push('')
    out.push('=== 3. 切成 Ctrl+Enter 发送后，提示随之变化 ===')
    await store.getState().patchSettings({ sendKey: 'ctrlEnter' })
    await sleep(400)
    hint = hintText()
    out.push('  提示文案: ' + JSON.stringify(hint))
    ok(/Ctrl/i.test(hint), '提示变成「Ctrl+Enter 发送」')

    out.push('')
    out.push('=== 4. Ctrl+Enter 模式下 Enter 不再发送 ===')
    const ta = q('[data-testid="composer"]')
    ok(!!ta, '找到输入框')
    if (ta) {
      setValue(ta, 'YAN-SENDKEY-PROBE')
      await sleep(120)
      const typed = ta.value
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
      await sleep(300)
      out.push(`  按 Enter 后输入框内容: ${JSON.stringify(ta.value.slice(0, 40))}`)
      ok(
        ta.value.includes('YAN-SENDKEY-PROBE'),
        'Enter 没有触发发送（内容还在，说明规则真的生效了）'
      )
      setValue(ta, '')
      await sleep(80)
    }

    out.push('')
    out.push('=== 5. 设置里能改（并且落盘） ===')
    store.getState().openSettings?.('input')
    await sleep(350)
    const seg = q('[data-testid="set-send-key"]')
    ok(!!seg, '设置面板里有「发送键」分段')
    const btns = seg ? [...seg.querySelectorAll('button')] : []
    out.push('  档位: ' + JSON.stringify(btns.map((b) => b.textContent.trim())))
    ok(btns.length === 3, '三个档位（自动 / Enter / Ctrl+Enter）')
    ok(
      btns.some((b) => b.classList.contains('sel') && b.dataset.sendKey === 'ctrlEnter'),
      '当前选中的档位被标出来'
    )
    store.getState().closeSettings?.()
    await sleep(200)

    out.push('')
    out.push('=== 6. 恢复默认 ===')
    await store.getState().patchSettings({ sendKey: 'auto' })
    await sleep(400)
    out.push('  现在: ' + JSON.stringify(store.getState().settings?.sendKey))
    ok(store.getState().settings?.sendKey === 'auto', '可以改回 auto')

    out.push('')
    out.push('=== 7. 中文输入法组合态：Enter 是「选词」，不能当成发送 ===')
    if (ta) {
      setValue(ta, 'YAN-IME-PROBE')
      await sleep(200)
      const press = (isComposing) => {
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'isComposing', { value: isComposing })
        ta.dispatchEvent(ev)
        return ev.defaultPrevented
      }
      const plain = press(false)
      await sleep(150)
      const ime = press(true)
      out.push(`  非组合态 preventDefault=${plain} / 组合态 preventDefault=${ime}`)
      ok(plain, '非组合态 Enter 被拦下来处理（走发送）')
      ok(!ime, '组合态 Enter 没有被拦（放行给输入法选词）')
      setValue(ta, '')
      await sleep(80)
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
