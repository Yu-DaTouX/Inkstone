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
  const press = (el, key, extra = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  const options = () => [...document.querySelectorAll('[data-testid="slash-menu"] [role="option"]')]
  const selectedIndex = () => options().findIndex((el) => el.getAttribute('aria-selected') === 'true')

  try {
    out.push('=== v3 输入框候选菜单（隔离探针）===')
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
    const value = () => composer.text(ta)
    const sends = []
    const realSend = store.getState().send
    store.setState({ send: async (...args) => { sends.push(args); return true } })

    const realCommands = store.getState().commands
    store.setState({
      commands: [
        { name: 'probe-alpha', description: '第一条探针命令。其余说明', source: 'yan', executable: true },
        { name: 'probe-beta', description: '第二条探针命令', source: 'pi', executable: true },
        { name: 'probe-gamma', description: '兼容项', source: 'compatibility', executable: false, availability: '桌面端不执行' }
      ],
      commandsAt: Date.now()
    })

    out.push('')
    out.push('--- 1. 命令菜单出现与排序 ---')
    setValue(ta, '/probe')
    check(await until(() => options().length === 3, 3000), `输入 /probe 出现 3 个候选（实际 ${options().length}）`)
    const names = options().map((el) => el.querySelector('.cmp-name')?.textContent)
    check(names[0] === '/probe-alpha' && names[1] === '/probe-beta' && names[2] === '/probe-gamma', `按来源顺序 yan → pi → compatibility（实际 ${JSON.stringify(names)}）`)
    check(ta.getAttribute('aria-expanded') === 'true', '输入框 aria-expanded=true')
    check(ta.getAttribute('aria-activedescendant') === 'composer-slash-option-0', '默认选中第一项并由 aria-activedescendant 指向')
    check(options()[2].disabled === true, '不可执行项为 disabled')
    check(!!document.querySelector('[data-testid="slash-hint"]'), '底部有按键说明')

    out.push('')
    out.push('--- 2. 方向键与 Enter 补全 ---')
    check(press(ta, 'ArrowDown'), 'ArrowDown 被菜单消费')
    check(await until(() => selectedIndex() === 1, 1500), '选中项移到第二条')
    check(press(ta, 'ArrowDown') && await until(() => selectedIndex() === 2, 1500), '再下移到第三条（不可执行项也可停留）')
    press(ta, 'ArrowUp')
    check(await until(() => selectedIndex() === 1, 1500), 'ArrowUp 回到第二条')
    const enterPrevented = press(ta, 'Enter')
    check(enterPrevented, 'Enter 被菜单消费（不走发送）')
    check(await until(() => value() === '/probe-beta ', 2000), `补全为 "/probe-beta "（实际 ${JSON.stringify(value())}）`)
    check(!q('slash-menu'), '补全后菜单关闭')
    check(sends.length === 0, '没有触发发送')

    out.push('')
    out.push('--- 3. Esc 关闭且不被重开 ---')
    setValue(ta, '/probe')
    check(await until(() => options().length === 3, 3000), '重新出现候选')
    check(press(ta, 'Escape'), 'Esc 被菜单消费')
    await wait(400)
    check(!q('slash-menu'), 'Esc 后菜单保持关闭')
    setValue(ta, '/probe-a')
    check(await until(() => options().length === 1, 3000), '继续在命令名里输入会重新开始补全')

    out.push('')
    out.push('--- 4. 输入法组合态让路 ---')
    setValue(ta, '/probe')
    await until(() => options().length === 3, 3000)
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })
    ta.dispatchEvent(imeEvent)
    await wait(200)
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    await wait(100)
    check(!imeEvent.defaultPrevented, '组合态 Enter 未被拦截')
    check(value() === '/probe', '组合态 Enter 没有填入候选')
    await wait(200)
    check(options().length === 3, '组合结束后菜单仍是原来的三项')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    document.execCommand('insertText', false, '中')
    await wait(200)
    check(
      !!q('slash-menu') && options().length === 3,
      `组合期间插入中文不关闭菜单、候选不变（value=${JSON.stringify(value())}）`
    )
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
    check(await until(() => !q('slash-menu'), 2000), '组合结束后按新文本收起菜单')
    setValue(ta, '')
    await wait(200)
    check(!q('slash-menu'), '清空后菜单收起')
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    setValue(ta, '/probe')
    await wait(300)
    check(!q('slash-menu'), '组合期间输入命令不弹出菜单')
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    check(await until(() => options().length === 3, 2000), '组合结束后才按新文本弹出菜单')

    out.push('')
    out.push('--- 5. 不可执行项不能补全 ---')
    options()[2].click()
    await wait(250)
    check(value() === '/probe', '点击不可执行项不改变输入')

    out.push('')
    out.push('--- 6. 鼠标点选 ---')
    options()[0].click()
    check(await until(() => value() === '/probe-alpha ', 2000), `点击第一项补全为 "/probe-alpha "（实际 ${JSON.stringify(value())}）`)

    out.push('')
    out.push('--- 7. @ 路径候选 ---')
    const cwd = store.getState().session?.cwd ?? store.getState().settings?.cwd ?? ''
    const probeResult = await window.yan.completePath('', cwd, { cwd, generation: 0 }).catch((error) => ({ error: String(error), paths: [], status: 'error' }))
    note(`cwd=${JSON.stringify(cwd)} 主进程返回 ${probeResult.paths?.length ?? 0} 项，状态 ${probeResult.status}`)
    let seen = false
    const watcher = new MutationObserver(() => { if (q('at-menu')) seen = true })
    watcher.observe(document.body, { childList: true, subtree: true })
    setValue(ta, '看看 @')
    check(await until(() => seen || !!q('at-menu'), 3000), '输入 @ 后路径菜单出现过（加载中或结果）')
    await until(() => !q('at-loading'), 4000)
    const optionCount = q('at-menu')?.querySelectorAll('[role="option"]').length ?? 0
    note(`路径候选数量 ${optionCount}`)
    if ((probeResult.paths?.length ?? 0) > 0) {
      check(optionCount > 0, '目录非空时给出候选')
      const first = q('at-menu')?.querySelector('[role="option"] .cmp-name')?.textContent?.trim()
      check(press(ta, 'Enter'), 'Enter 被路径菜单消费')
      check(await until(() => value().startsWith('看看 @') && value().length > '看看 @'.length, 2000), `补全了路径 ${JSON.stringify(first)}`)
      check(sends.length === 0, '补全不触发发送')
      setValue(ta, '看看 @')
      await until(() => (q('at-menu')?.querySelectorAll('[role="option"]').length ?? 0) > 0, 4000)
      press(ta, 'Escape')
      await wait(400)
      check(!q('at-menu'), 'Esc 后路径菜单保持关闭')
    } else {
      check(!q('at-menu'), '目录无结果时菜单自行收起')
    }
    watcher.disconnect()

    out.push('')
    out.push('--- 8. 光标移出命令名后菜单收起 ---')
    setValue(ta, '/probe-alpha 参数')
    await wait(300)
    check(!q('slash-menu'), '光标在参数区时不再显示命令菜单')

    out.push('')
    out.push('--- 9. 行中触发与不进参数区 ---')
    setValue(ta, 'hello /probe')
    check(await until(() => options().length === 3, 3000), `行中空白后的 / 也出菜单（实际 ${options().length} 项）`)
    setValue(ta, '/probe ')
    await wait(300)
    check(!q('slash-menu'), '/ 后跟空格不触发')
    setValue(ta, `/${'p'.repeat(51)}`)
    await wait(300)
    check(!q('slash-menu'), '查询超过 50 字符不触发')
    setValue(ta, '普通文字/model')
    await wait(300)
    check(!q('slash-menu'), '紧贴正文的 / 不触发（普通文字/model）')

    out.push('')
    out.push('--- 10. 浮层几何 ---')
    setValue(ta, '')
    await wait(200)
    const cardOpen = document.querySelector('.composer')
    const closedHeight = cardOpen ? cardOpen.getBoundingClientRect().height : 0
    setValue(ta, '/probe')
    await until(() => options().length === 3, 3000)
    const menuEl = q('slash-menu')
    const inputEl = q('composer-input')
    const openHeight = cardOpen ? cardOpen.getBoundingClientRect().height : 0
    check(Math.abs(openHeight - closedHeight) < 1.5, `菜单不撑高输入卡片（${Math.round(closedHeight)} → ${Math.round(openHeight)}）`)
    check(!!menuEl && menuEl.parentElement === document.body, '菜单 portal 到 body')
    check(!!menuEl && getComputedStyle(menuEl).position === 'fixed', '菜单固定定位，脱离卡片排版')
    const menuRect = menuEl.getBoundingClientRect()
    const sel = window.getSelection()
    const caretRect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
    const inputRect = inputEl.getBoundingClientRect()
    check(!!caretRect && Math.abs(menuRect.bottom - (caretRect.top - 10)) <= 2, `菜单底边贴在光标上方 10px（菜单 ${Math.round(menuRect.bottom)} / 光标 ${caretRect ? Math.round(caretRect.top) : '?'}）`)
    check(menuRect.bottom <= inputRect.top + 8, '输入框在窗口底部时菜单向上展开、盖住对话')
    check(menuRect.width >= 240 && menuRect.width <= 512, `宽度在 240–512 之间（实际 ${Math.round(menuRect.width)}）`)
    check(menuRect.height <= 384, `最大高不超过 384（实际 ${Math.round(menuRect.height)}）`)
    check(!!menuEl.querySelector('.cmp-hit'), '命中段用 <b> 加粗')
    const tip = document.querySelector('.cmp-tip')
    check(!!tip && (tip.textContent ?? '').includes('其余说明'), '高亮行右侧有完整描述气泡')

    out.push('')
    out.push('--- 11. 键盘移动到列表底部滚动跟随 ---')
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `probe-${String(i).padStart(2, '0')}`,
      description: `第 ${i} 条`,
      source: 'yan',
      executable: true
    }))
    store.setState({ commands: many, commandsAt: Date.now() })
    setValue(ta, '/probe')
    await until(() => options().length === 40, 3000)
    press(ta, 'ArrowUp')
    await wait(300)
    const last = options().at(-1)
    const lastRect = last?.getBoundingClientRect()
    const scrollRect = q('slash-menu')?.getBoundingClientRect()
    check(selectedIndex() === 39, 'ArrowUp 从第一项循环到最后一项')
    check(
      !!lastRect && !!scrollRect && lastRect.top >= scrollRect.top - 1 && lastRect.bottom <= scrollRect.bottom + 1,
      '高亮到最后一项时列表滚到底，选中项完整可见'
    )
    check((q('slash-menu')?.scrollTop ?? 0) > 0, '列表确实发生了内部滚动')

    setValue(ta, '')
    store.setState({ send: realSend, commands: realCommands })
    out.push('证据范围：v3 候选菜单状态机与键盘 / 鼠标路径；命令为注入的假数据，路径走真实只读 IPC，未发消息、未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
