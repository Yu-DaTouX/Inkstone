;(async () => {
  const out = []
  const check = (condition, label, extra = '') => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {}
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const qa = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)]
  const store = window.__yanStore

  const S = '插话：先解释一下'
  const F1 = '排队一：再补一个例子'
  const F2 = '排队二：最后总结'

  const calls = []
  const retractCalls = []

  try {
    out.push('=== v3 排队消息（隔离探针）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {}
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
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

    out.push('')
    out.push('--- 1. 位置与折叠 ---')
    check(await until(() => !!q('queue-stack')), '出现排队消息区（queue-stack）')
    const stack = q('queue-stack')
    const composer = document.querySelector('.composer')
    check(!!composer, '输入框 .composer 存在')
    if (stack && composer) {
      const line = composer.querySelector('.composer-line')
      check(stack.parentElement === composer, '排队是输入框里的一行')
      check(!!line && stack.getBoundingClientRect().bottom <= line.getBoundingClientRect().top + 2, '排队行在输入行上方')
      const plan = composer.querySelector('[data-testid="plan-card"]')
      if (plan) check(plan.compareDocumentPosition(stack) & Node.DOCUMENT_POSITION_FOLLOWING, '排队行在计划行下面')
      check(getComputedStyle(stack.querySelector('.cq-row')).backgroundColor === 'rgba(0, 0, 0, 0)', '排队行无底色，和计划行同款')
    }
    check(stack?.dataset.count === '3', '计数条记录总条数', `data-count=${stack?.dataset.count}`)
    check(q('queue-toggle')?.getAttribute('aria-expanded') === 'false', '多条时默认折叠成计数条')
    check(/^(排队|Queued) · 3$/.test(q('queue-toggle')?.querySelector('.cq-pill')?.textContent ?? ''), '计数条行首是「排队 · 3」胶囊')
    check(qa('queue-row').length === 0, '折叠时不渲染消息行')

    out.push('')
    out.push('--- 2. 展开后的内容 ---')
    q('queue-toggle')?.click()
    check(await until(() => qa('queue-row').length === 3), '展开后三条都渲染', `实际 ${qa('queue-row').length}`)
    const text = stack?.textContent ?? ''
    check(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来')
    check(text.includes('插话中'), 'steering 行显示「插话中」')
    check(!!q('queue-clear-all'), '展开后有「全部清除」')

    out.push('')
    out.push('--- 3. 行操作收在行菜单 ---')
    const openMenus = () => [...document.querySelectorAll('.cq-menu')]
    const openMenu = async (index) => {
      const opened = openMenus()
      opened[opened.length - 1]?.querySelector('[role="menuitem"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      await until(() => openMenus().length === 0, 3000)
      qa('queue-actions')[index]?.click()
      await until(() => openMenus().length === 1, 3000)
      await wait(150)
      const menu = openMenus()[0]
      return {
        items: menu ? [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.dataset.testid ?? el.textContent ?? '') : [],
        item: (testId) => menu?.querySelector(`[data-testid="${testId}"]`) ?? null
      }
    }
    const steerRow = await openMenu(0)
    check(!steerRow.items.includes('queue-steer'), '插话行没有插队项', JSON.stringify(steerRow.items))
    check(steerRow.items.includes('queue-retract'), '插话行菜单里有撤回')
    const followRow = await openMenu(1)
    check(followRow.items.includes('queue-steer'), '排队行有插队项', JSON.stringify(followRow.items))

    out.push('')
    out.push('--- 4. 插队接线 ---')
    followRow.item('queue-steer')?.click()
    check(await until(() => calls.length === 1), '点击插队调用了 steerQueued')
    check(calls[0] === 'f1', `携带稳定 queueId=f1（实际 ${JSON.stringify(calls)}）`)

    out.push('')
    out.push('--- 5. 撤回接线 ---')
    const retractRow = await openMenu(0)
    retractRow.item('queue-retract')?.click()
    check(await until(() => retractCalls.length === 1), '点击撤回调用了 removeQueued')
    check(retractCalls[0] === 's1', `携带稳定 queueId=s1（实际 ${JSON.stringify(retractCalls)}）`)

    const opened = openMenus()
    opened[opened.length - 1]?.querySelector('[role="menuitem"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await until(() => openMenus().length === 0, 3000)
    store.setState({ queue: { steering: [], followUp: [] } })
    check(await until(() => !q('queue-stack'), 3000), '清空队列后排队条消失')
    out.push('证据范围：隔离注入的队列 DOM、折叠交互与 spy 接线；不代表真实队列投递 / 模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  try {
    store.setState({ queue: { steering: [], followUp: [] } })
  } catch {}
  return out.join('\n')
})()
