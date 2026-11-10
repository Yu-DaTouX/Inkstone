;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const text = (el) => (el ? el.textContent ?? '' : '')
  const insert = async (el, value, toEnd) => {
    if (!el) return false
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    if (toEnd) range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('insertText', false, value)
    await sleep(150)
    if (!text(el).includes(value)) {
      document.execCommand('insertHTML', false, value.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]))
      await sleep(150)
    }
    return text(el).includes(value)
  }
  const type = (el, value) => insert(el, value, false)
  const append = (el, value) => insert(el, value, true)

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const input = q('[data-testid="composer-input"]')
    ok(!!input, '输入框可用')
    if (!input) return out.join('\n')
    ok(input.getAttribute('role') === 'textbox' && input.getAttribute('contenteditable') === 'true', '输入框是 contentEditable 的多行文本框')

    out.push('')
    out.push('=== 1. 选中一个真实文件引用 ===')
    ok(await type(input, '@README'), '`@README` 写入输入框')
    ok(input.dataset.empty === 'false', '输入框从空态切到有内容')
    const menuUp = await until(() => !!q('[data-composer-command-root]'), 8000)
    ok(menuUp, '`@README` 打开了补全菜单')
    const hasItem = await until(() => !!q('[data-composer-command-root] .t3-cmd__item[data-composer-item-id]'), 8000)
    ok(hasItem, '菜单里出现了候选文件')
    if (!hasItem) return out.join('\n')
    const first = q('[data-composer-command-root] .t3-cmd__item[data-composer-item-id]')
    const label = first?.querySelector('.t3-cmd__label')?.textContent ?? ''
    out.push('  第一项 = ' + JSON.stringify(label.slice(0, 40)))
    ok(/README/i.test(label), '第一项是 README 文件')
    first.click()
    await sleep(600)
    const afterPick = text(input)
    out.push('  选中后输入框 = ' + JSON.stringify(afterPick))
    ok(!q('[data-composer-command-root]'), '选中后补全菜单关闭')
    ok(/@README\.md\b/.test(afterPick), '候选补成了完整路径（@README.md）')
    const chip = q('[data-testid="composer-input"] .composer-chip[data-mention]')
    ok(!!chip, '补全结果是独立的引用节点而不是纯文本')

    out.push('')
    out.push('=== 2. 真实发送 ===')
    ok(await append(input, ' 请用 read 工具打开它，把第一行原样回复给我'), '任务文本追加到引用后面')
    const value = text(input)
    out.push('  待发送文本 = ' + JSON.stringify(value.slice(0, 100)))
    ok(value.includes('@README.md'), '引用仍然在输入框里')
    await sleep(300)
    const send = q('[data-testid="composer-v3"] .t3-send')
    ok(!!send && !send.disabled, '发送键可用')
    if (!send) return out.join('\n')
    send.click()

    const started = await until(() => !!store.getState().session?.isAgentRunning, 25000)
    ok(started, '模型开始处理（引用随消息一起发出了）')

    await until(() => !store.getState().session?.isAgentRunning, 60000)
    await sleep(1500)

    const mine = [...store.getState().messages].reverse().find((m) => m.role === 'user')
    out.push('  发出去的用户消息 = ' + JSON.stringify(String(mine?.text ?? '').slice(0, 100)))
    ok(String(mine?.text ?? '').includes('@README.md'), '用户消息里保留了 @引用（补全没有把它抹掉）')
    ok(String(mine?.text ?? '').includes('read 工具'), '任务文本也在（补全没有吃掉后文）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
