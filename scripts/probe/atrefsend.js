;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const ta = q('[data-testid="composer"]')
    ok(!!ta, '输入框可用')
    if (!ta) return out.join('\n')

    out.push('')
    out.push('=== 1. 选中一个真实文件引用 ===')
    setVal(ta, '@README')
    const menuUp = await until(() => !!q('[data-testid="at-menu"]'), 8000)
    ok(menuUp, '`@README` 打开了文件补全菜单')
    const hasItem = await until(() => !!q('[data-testid="at-menu"] .slash-item'), 8000)
    ok(hasItem, '菜单里出现了候选文件')
    const first = q('[data-testid="at-menu"] .slash-item')
    out.push('  第一项 = ' + JSON.stringify((first?.textContent ?? '').slice(0, 40)))
    first?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(500)
    const afterPick = ta.value
    out.push('  选中后输入框 = ' + JSON.stringify(afterPick))
    ok(/@README\.md\b/.test(afterPick), '候选补成了完整路径（@README.md）')

    out.push('')
    out.push('=== 2. 真实发送 ===')
    setVal(ta, `${afterPick.trim()} 请用 read 工具打开它，把第一行原样回复给我`)
    await sleep(300)
    const send = q('[data-testid="send"]')
    ok(!!send && !send.disabled, '发送键可用')
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const started = await until(() => !!store.getState().session?.isAgentRunning, 25000)
    ok(started, '模型开始处理（引用随消息一起发出了）')

    await until(() => !store.getState().session?.isAgentRunning, 60000)
    await sleep(1500)

    const mine = [...store.getState().messages].reverse().find((m) => m.role === 'user')
    out.push('  发出去的用户消息 = ' + JSON.stringify(String(mine?.text ?? '').slice(0, 80)))
    ok(String(mine?.text ?? '').includes('@README.md'), '用户消息里保留了 @引用（补全没有把它抹掉）')
    ok(String(mine?.text ?? '').includes('read 工具'), '任务文本也在（补全没有吃掉后文）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
