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
  const opCalls = []
  const lastMenu = () => [...document.querySelectorAll('[role="menu"]')].pop()
  const menuItems = () => [...(lastMenu()?.querySelectorAll('[role="menuitem"]') ?? [])]
  const closeMenu = async () => {
    const menu = lastMenu()
    if (!menu) return
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    if (!await until(() => !lastMenu(), 2000)) {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await until(() => !lastMenu(), 2000)
    }
  }
  const openRowMenu = async (index) => {
    await closeMenu()
    qa('queue-actions')[index]?.click()
    await until(() => menuItems().length > 0, 3000)
    await wait(120)
    return menuItems()
  }
  const setNativeValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

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
      },
      applyQueueOp: async (op) => {
        opCalls.push(op)
      }
    })

    out.push('')
    out.push('--- 1. 位置与折叠 ---')
    check(await until(() => !!q('queue-stack')), '出现排队消息区（queue-stack）')
    const stack = q('queue-stack')
    const composer = q('composer-v3')
    check(!!composer, '输入框 composer-v3 存在')
    if (stack && composer) {
      check(stack.parentElement === composer, '排队区挂在输入框外壳里')
      const form = composer.querySelector('[data-chat-composer-form="true"]')
      check(!!form, '输入框表单存在')
      if (form) {
        check(!!(stack.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING), '排队区在输入表单之前')
        check(stack.getBoundingClientRect().bottom <= form.getBoundingClientRect().top + 2, '排队区显示在输入表单上方')
        check(!form.contains(stack), '排队区不在提交表单内部')
      }
      const plan = composer.querySelector('[data-testid="plan-card"]')
      if (plan) check(!!(stack.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING), '排队区在计划卡之前')
    }
    check(stack?.dataset.count === '3', '计数记录总条数', `data-count=${stack?.dataset.count}`)
    check(stack?.getAttribute('aria-label') === '3 条排队', `区域可访问名带条数（${stack?.getAttribute('aria-label')}）`)
    const toggle = () => q('queue-toggle')
    check(toggle()?.getAttribute('aria-expanded') === 'false', '多条时默认折叠')
    check((toggle()?.textContent ?? '').includes('显示全部 3 条排队'), `折叠时按钮提示展开（${(toggle()?.textContent ?? '').trim()}）`)
    check(qa('queue-row').length === 2, `折叠时只渲染两行（实际 ${qa('queue-row').length}）`)

    out.push('')
    out.push('--- 2. 展开后的内容 ---')
    toggle()?.click()
    check(await until(() => qa('queue-row').length === 3), '展开后三条都渲染', `实际 ${qa('queue-row').length}`)
    check(toggle()?.getAttribute('aria-expanded') === 'true', '展开状态写回 aria-expanded')
    check((toggle()?.textContent ?? '').includes('收起排队'), '展开后按钮提示收起')
    const text = stack?.textContent ?? ''
    check(text.includes(S) && text.includes(F1) && text.includes(F2), '三条文本都显示出来')
    const rows = qa('queue-row')
    check(rows[0]?.dataset.kind === 'steering' && rows[1]?.dataset.kind === 'followUp', '行按插话 → 排队的顺序排列')
    check(rows[0]?.querySelector('.t3-queue__tag')?.textContent === '插话中', '插话行显示「插话中」')
    check(!!q('queue-clear-all'), '展开后有「全部清除」')

    out.push('')
    out.push('--- 3. 行操作 ---')
    const steerButtons = qa('queue-steer')
    check(steerButtons.length === 2, `只有排队行有插话按钮（实际 ${steerButtons.length}）`)
    check(!rows[0]?.querySelector('[data-testid="queue-steer"]'), '插话行没有插话按钮')
    check(!!rows[1]?.querySelector('[data-testid="queue-steer"]'), '排队行有插话按钮')
    check(qa('queue-actions').length === 3, '每行都有行菜单入口')

    const steeringMenu = await openRowMenu(0)
    const steeringLabels = steeringMenu.map((el) => el.textContent ?? '')
    check(steeringLabels.includes('上移') && steeringLabels.includes('下移'), `行菜单有上下移（${JSON.stringify(steeringLabels)}）`)
    check(!!steeringMenu.find((el) => el.dataset.testid === 'queue-retract'), '行菜单有撤回')
    check(!!steeringMenu.find((el) => el.dataset.testid === 'queue-delete'), '行菜单有删除')
    check(steeringMenu[0]?.getAttribute('aria-disabled') === 'true', '第一条的「上移」不可用')
    await closeMenu()

    out.push('')
    out.push('--- 4. 插队接线 ---')
    rows[1]?.querySelector('[data-testid="queue-steer"]')?.click()
    check(await until(() => calls.length === 1), '点击插话调用了 steerQueued')
    check(calls[0] === 'f1', `携带稳定 queueId=f1（实际 ${JSON.stringify(calls)}）`)

    out.push('')
    out.push('--- 5. 撤回接线 ---')
    const retractMenu = await openRowMenu(0)
    retractMenu.find((el) => el.dataset.testid === 'queue-retract')?.click()
    check(await until(() => retractCalls.length === 1), '点击撤回调用了 removeQueued')
    check(retractCalls[0] === 's1', `携带稳定 queueId=s1（实际 ${JSON.stringify(retractCalls)}）`)
    await closeMenu()

    out.push('')
    out.push('--- 6. 编辑与移动 ---')
    qa('queue-edit-start')[1]?.click()
    check(await until(() => !!q('queue-edit-input')), '点编辑出现行内输入框')
    const editor = q('queue-edit-input')
    check(editor?.value === F1, `输入框预填当前文本（${JSON.stringify(editor?.value)}）`)
    if (editor) setNativeValue(editor, '排队一：改过的文本')
    q('queue-edit-save')?.click()
    check(await until(() => opCalls.some((op) => op.op === 'edit' && op.id === 'f1' && op.text === '排队一：改过的文本')), '保存走 applyQueueOp edit')
    check(await until(() => !q('queue-edit-input')), '保存后输入框关闭')
    qa('queue-edit-start')[1]?.click()
    await until(() => !!q('queue-edit-input'))
    q('queue-edit-cancel')?.click()
    check(await until(() => !q('queue-edit-input')), '取消不写队列')
    check(!opCalls.some((op) => op.op === 'edit' && op.text === '排队一：改过的文本' && op.id !== 'f1'), '取消没有产生额外编辑')
    check(opCalls.filter((op) => op.op === 'edit').length === 1, '只提交了一次编辑')

    const moveMenu = await openRowMenu(2)
    moveMenu.find((el) => (el.textContent ?? '') === '上移')?.click()
    check(await until(() => opCalls.some((op) => op.op === 'move' && op.id === 'f2' && op.direction === 'up')), '上移走 applyQueueOp move')
    await closeMenu()

    out.push('')
    out.push('--- 7. 全部清除 ---')
    q('queue-clear-all')?.click()
    check(await until(() => opCalls.some((op) => op.op === 'clear')), '全部清除走 applyQueueOp clear')
    check(await until(() => [...document.querySelectorAll('.ui-toast')].some((el) => /已清除 3 条排队消息/.test(el.textContent ?? ''))), '清除后有可撤销提示')

    store.setState({ queue: { steering: [], followUp: [] } })
    check(await until(() => !q('queue-stack'), 3000), '清空队列后排队条消失')
    note('证据范围：隔离注入的队列 DOM、折叠/编辑交互与 spy 接线；不代表真实队列投递 / 模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  try {
    await closeMenu()
    store.setState({ queue: { steering: [], followUp: [] } })
  } catch {}
  return out.join('\n')
})()
