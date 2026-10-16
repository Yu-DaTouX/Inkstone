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

  const setValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
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
    check(await until(() => ta.value === '/probe-beta ', 2000), `补全为 "/probe-beta "（实际 ${JSON.stringify(ta.value)}）`)
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
    const imeEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(imeEvent, 'isComposing', { value: true })
    ta.dispatchEvent(imeEvent)
    await wait(200)
    check(!imeEvent.defaultPrevented, '组合态 Enter 未被拦截')
    check(ta.value === '/probe', '组合态 Enter 没有填入候选')

    out.push('')
    out.push('--- 5. 不可执行项不能补全 ---')
    options()[2].click()
    await wait(250)
    check(ta.value === '/probe', '点击不可执行项不改变输入')

    out.push('')
    out.push('--- 6. 鼠标点选 ---')
    options()[0].click()
    check(await until(() => ta.value === '/probe-alpha ', 2000), `点击第一项补全为 "/probe-alpha "（实际 ${JSON.stringify(ta.value)}）`)

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
      check(await until(() => ta.value.startsWith('看看 @') && ta.value.length > '看看 @'.length, 2000), `补全了路径 ${JSON.stringify(first)}`)
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

    setValue(ta, '')
    store.setState({ send: realSend, commands: realCommands })
    out.push('证据范围：v3 候选菜单状态机与键盘 / 鼠标路径；命令为注入的假数据，路径走真实只读 IPC，未发消息、未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
