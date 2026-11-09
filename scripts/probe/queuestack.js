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

    const rows = () => qa('[data-testid="queue-row"]')
    const toggle = () => q('[data-testid="queue-toggle"]')
    const openMenus = () => qa('[role="menu"]')

    out.push('=== 1. 位置：输入框上方，多于两条时只露前两条 ===')
    ok(await until(() => !!q('[data-testid="queue-stack"]')), '出现排队消息区')
    const stack = q('[data-testid="queue-stack"]')
    if (!stack) return out.join('\n')
    ok(stack.dataset.count === '3', '记录总条数', `data-count=${stack.dataset.count}`)
    const composer = q('[data-testid="composer-v3"]')
    const input = q('[data-testid="composer-input"]')
    ok(!!composer && stack.parentElement === composer, '排队区在输入框组件里')
    ok(!!input && stack.getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 2, '在输入行上方', `stack.bottom=${Math.round(stack.getBoundingClientRect().bottom)} input.top=${Math.round(input?.getBoundingClientRect().top ?? 0)}`)
    ok(!!toggle(), '多于两条时显示展开按钮')
    ok(toggle()?.getAttribute('aria-expanded') === 'false', '默认是收起状态')
    ok(/(显示全部 3 条排队|Show all 3 queued)/.test(toggle()?.textContent ?? ''), '展开按钮写明总条数', JSON.stringify(toggle()?.textContent))
    ok(rows().length === 2, '收起时只渲染前两条', `实际 ${rows().length}`)

    out.push('')
    out.push('=== 2. 展开后：内容与状态 ===')
    toggle()?.click()
    ok(await until(() => toggle()?.getAttribute('aria-expanded') === 'true'), '点按钮展开')
    ok(await until(() => rows().length === 3), '展开后三条都渲染', `实际 ${rows().length}`)
    const text = stack.textContent ?? ''
    ok(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来了')
    ok(/插话中|inserting/.test(rows()[0]?.textContent ?? ''), 'steering 行标出「插话中」')
    ok(!!q('[data-testid="queue-clear-all"]'), '有「全部清除」')

    out.push('')
    out.push('=== 3. 行内操作与行菜单 ===')
    const has = (row, testId) => !!row?.querySelector(`[data-testid="${testId}"]`)
    ok(rows().every((row) => has(row, 'queue-actions') && has(row, 'queue-edit-start')), '每行都有编辑与操作菜单入口')
    ok(!has(rows()[0], 'queue-steer'), '插话行没有「插队」（已在插话中）')
    ok(has(rows()[1], 'queue-steer') && has(rows()[2], 'queue-steer'), '排队行有「插队」')

    const openMenu = async (index) => {
      rows()[index]?.querySelector('[data-testid="queue-actions"]')?.click()
      await until(() => openMenus().length === 1, 3000)
      await sleep(150)
      const menu = openMenus()[0]
      return {
        items: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.testid ?? el.textContent ?? '') : [],
        item: (testId) => menu?.querySelector(`[data-testid="${testId}"]`) ?? null
      }
    }
    const closeMenu = async () => {
      const menu = openMenus()[0]
      menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await until(() => openMenus().length === 0, 3000)
    }

    const steerMenu = await openMenu(0)
    note(`插话行菜单 = ${JSON.stringify(steerMenu.items)}`)
    ok(openMenus().length === 1, '点入口打开行菜单')
    ok(steerMenu.items.includes('queue-retract') && steerMenu.items.includes('queue-delete'), '行菜单有撤回与删除')
    await closeMenu()
    ok(openMenus().length === 0, 'Esc 关掉行菜单')

    out.push('')
    out.push('=== 4. 插队按钮接线 ===')
    rows()[1]?.querySelector('[data-testid="queue-steer"]')?.click()
    ok(await until(() => calls.length === 1), '点击插队调用 steerQueued', `实际 ${JSON.stringify(calls)}`)
    ok(calls[0] === 'f1', '携带稳定 queueId=f1')

    out.push('')
    out.push('=== 5. 撤回接线 ===')
    const retractMenu = await openMenu(0)
    retractMenu.item('queue-retract')?.click()
    ok(await until(() => retractCalls.length === 1), '点击撤回调用了 removeQueued', `实际 ${JSON.stringify(retractCalls)}`)
    ok(retractCalls[0] === 's1', '携带稳定 queueId=s1')
    await closeMenu()

    out.push('')
    out.push('=== 6. 收起 ===')
    toggle()?.click()
    ok(await until(() => toggle()?.getAttribute('aria-expanded') === 'false'), '再点一次收起')
    ok(await until(() => rows().length === 2), '收起后回到前两条')
    ok(stack.dataset.count === '3', '收起不清空队列', `data-count=${stack.dataset.count}`)

    store.setState({ queue: { steering: [], followUp: [] } })
    ok(await until(() => !q('[data-testid="queue-stack"]')), '清空队列后排队区消失')
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error?.stack ?? String(error)))
  }

  store?.setState({ queue: { steering: [], followUp: [] } })
  return out.join('\n')
})()
