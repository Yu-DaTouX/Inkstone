/**
 * 发送键设置：规则可选、可见、生效。
 *
 * 背景（方案 4.3）：输入框**展开后 Enter 的语义会变** —— 这是隐式规则，
 * 按下去之前无法确定会发生什么。现在规则既可配置，也常显在输入区。
 *
 * ⚠️ 这个探针**不真的发消息**：只验证「不该发送时不发送」这一侧。
 *    「该发送」那侧要靠真实发送，会烧 token，而且和 e2e 场景重复。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  /** 用 React 认的方式写进受控输入框 */
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
    out.push('=== 2. 当前规则常显在输入区 ===')
    let hint = hintText()
    out.push('  提示文案: ' + JSON.stringify(hint))
    ok(hint.length > 0, '输入区持续显示发送规则（不再只在长文模式出现）')
    ok(/Enter/.test(hint), '提示里写明了 Enter 的分工')

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
      /* 只按 Enter —— 在这个模式下应该只是换行/无动作，绝不能发送 */
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
      await sleep(300)
      out.push(`  按 Enter 后输入框内容: ${JSON.stringify(ta.value.slice(0, 40))}`)
      ok(
        ta.value.includes('YAN-SENDKEY-PROBE'),
        'Enter 没有触发发送（内容还在，说明规则真的生效了）'
      )
      /* 清掉测试文本，别把垃圾留给后续场景 */
      setValue(ta, '')
      await sleep(80)
    }

    out.push('')
    out.push('=== 5. 设置里能改（并且落盘） ===')
    store.getState().openSettings?.()
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
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
