;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const note = (s) => out.push('  · ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (fn()) return true
      } catch {}
      await sleep(50)
    }
    return false
  }
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  const S = '插话：先解释一下'
  const F1 = '排队一：再补一个例子'
  const F2 = '排队二：最后总结'

  const calls = []
  const retractCalls = []

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40; i++) {
      if (q('[data-testid="composer-input"]') && store?.getState().settings) break
      await sleep(250)
    }
    if (!store) {
      out.push('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')
      return out.join('\n')
    }

    store.setState({
      queue: {
        steering: [{ id: 's1', text: S }],
        followUp: [
          { id: 'f1', text: F1 },
          { id: 'f2', text: F2 }
        ]
      },
      steerQueued: async (queueId) => {
        calls.push(queueId)
      },
      removeQueued: async (queueId) => {
        retractCalls.push(queueId)
      }
    })

    out.push('=== 1. 位置：输入框上方，默认折叠成计数条 ===')
    ok(await until(() => !!q('[data-testid="queue-stack"]')), '出现排队消息区')
    const stack = q('[data-testid="queue-stack"]')
    if (!stack) return out.join('\n')
    ok(stack.dataset.count === '3', '计数条记录总条数', `data-count=${stack.dataset.count}`)
    const composer = q('.composer')
    if (composer) {
      const line = composer.querySelector('.composer-line')
      ok(stack.parentElement === composer, '排队是输入框里的一行')
      ok(!!line && stack.getBoundingClientRect().bottom <= line.getBoundingClientRect().top + 2, '在输入行上方', `stack.bottom=${Math.round(stack.getBoundingClientRect().bottom)} line.top=${Math.round(line?.getBoundingClientRect().top ?? 0)}`)
    }
    const toggle = () => q('[data-testid="queue-toggle"]')
    ok(!!toggle(), '多条时显示折叠计数条')
    ok(toggle()?.getAttribute('aria-expanded') === 'false', '默认是折叠状态')
    ok(/^(排队|Queued) · 3$/.test(toggle()?.querySelector('.cq-pill')?.textContent ?? ''), '计数条行首是「排队 · 3」胶囊', JSON.stringify(toggle()?.textContent))
    ok(qa('[data-testid="queue-row"]').length === 0, '折叠时不渲染消息行')
    note(`折叠条 = ${JSON.stringify(toggle()?.textContent ?? '')}`)

    out.push('')
    out.push('=== 2. 展开后：内容与状态 ===')
    toggle()?.click()
    ok(await until(() => toggle()?.getAttribute('aria-expanded') === 'true'), '点计数条展开')
    ok(await until(() => qa('[data-testid="queue-row"]').length === 3), '展开后三条都渲染', `实际 ${qa('[data-testid="queue-row"]').length}`)
    const text = stack.textContent ?? ''
    ok(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来了')
    ok(text.includes('插话中'), 'steering 行标出「插话中」')
    ok(!!q('[data-testid="queue-clear-all"]'), '展开后有「全部清除」')

    out.push('')
    out.push('=== 3. 行操作收在行菜单里 ===')
    const triggers = qa('[data-testid="queue-actions"]')
    ok(triggers.length === 3, '每行一个操作菜单入口', `实际 ${triggers.length}`)
    const openMenus = () => qa('.cq-menu')
    const openMenu = async (index) => {
      const opened = openMenus()
      opened[opened.length - 1]?.querySelector('[role="menuitem"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      await until(() => openMenus().length === 0, 3000)
      qa('[data-testid="queue-actions"]')[index]?.click()
      await until(() => openMenus().length === 1, 3000)
      await sleep(150)
      const menu = openMenus()[0]
      return {
        menu,
        items: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.testid ?? el.textContent ?? '') : [],
        item: (testId) => menu?.querySelector(`[data-testid="${testId}"]`) ?? null
      }
    }
    const closeMenu = async () => {
      const opened = openMenus()
      opened[opened.length - 1]?.querySelector('[role="menuitem"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      await until(() => openMenus().length === 0, 3000)
    }

    const steerRow = await openMenu(0)
    ok(openMenus().length === 1, '一次只展开一个行菜单')
    ok(!steerRow.items.includes('queue-steer'), '插话行没有「插队」项（已在插话中）', JSON.stringify(steerRow.items))
    ok(steerRow.items.includes('queue-edit-start') && steerRow.items.includes('queue-retract'), '插话行有编辑与撤回')

    const followRow = await openMenu(1)
    ok(openMenus().length === 1, '换一行时上一个菜单已关掉')
    ok(followRow.items.includes('queue-steer'), '排队行有「插队」项', JSON.stringify(followRow.items))

    out.push('')
    out.push('=== 4. 插队按钮接线 ===')
    followRow.item('queue-steer')?.click()
    ok(await until(() => calls.length === 1), '点击插队调用 steerQueued', `实际 ${JSON.stringify(calls)}`)
    ok(calls[0] === 'f1', '携带稳定 queueId=f1')
    await until(() => openMenus().length === 0, 3000)

    out.push('')
    out.push('=== 5. 撤回按钮接线 ===')
    const retractRow = await openMenu(0)
    ok(retractRow.items.includes('queue-retract'), '插话行菜单里有撤回')
    retractRow.item('queue-retract')?.click()
    ok(await until(() => retractCalls.length === 1), '点击撤回调用了 removeQueued', `实际 ${JSON.stringify(retractCalls)}`)
    ok(retractCalls[0] === 's1', '携带稳定 queueId=s1')
    await closeMenu()

    out.push('')
    out.push('=== 6. 折叠回计数条 ===')
    await closeMenu()
    toggle()?.click()
    ok(await until(() => toggle()?.getAttribute('aria-expanded') === 'false'), '再点一次折叠回去')
    ok(await until(() => qa('[data-testid="queue-row"]').length === 0), '折叠后消息行隐藏')
    ok(stack.dataset.count === '3', '折叠不清空队列', `data-count=${stack.dataset.count}`)

    store.setState({ queue: { steering: [], followUp: [] } })
    ok(await until(() => !q('[data-testid="queue-stack"]')), '清空队列后排队条消失')
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error?.stack ?? String(error)))
  }

  store?.setState({ queue: { steering: [], followUp: [] } })
  return out.join('\n')
})()
