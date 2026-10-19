;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
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
  const todoTile = () => q('wb-rail-progress')
  const todoCount = () => todoTile()?.querySelector('.wb-tile-summary')
  const todoToggle = () => todoTile()?.querySelector('.wb-tile-toggle')

  const openTool = async (tab) => {
    const direct = q(`wb-open-${tab}`)
    if (direct) {
      direct.click()
      await wait(200)
      return
    }
    q('wb-more-tools')?.click()
    const order = ['changes', 'preview', 'logs', 'branch', 'quota']
    const pick = () => document.querySelector(`.wb-more-menu [data-key="${tab}"]`) ?? document.querySelectorAll('.wb-more-menu [role="menuitem"]')[order.indexOf(tab)]
    for (let i = 0; i < 40 && !pick(); i++) await wait(50)
    pick()?.click()
    await wait(200)
  }
  const qa = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)]
  const store = window.__yanStore

  const FIXTURE_TODOS = [
    { text: '读 spec 并确认范围', done: true },
    { text: '写 protocol.ts 的 JSONL 分帧', done: true },
    { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
    { text: '补测试并用真实应用跑一遍回归', done: false }
  ]
  const PROBE_SID = '__v3-todos-probe__'

  try {
    out.push('=== v3 侧栏待办磁贴（隔离探针）===')
    check(
      await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000),
      'v3 外壳已挂载'
    )
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')

    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      check(await until(() => !document.querySelector('.v3-ob-overlay'), 3000), '关闭首次引导层（不阻塞快捷键）')
    }

    check(await until(() => store.getState().sessions.length > 0, 10000), '隔离会话表已就绪')

    if (!q('v3-header-sessionbar')) throw new Error('缺少会话栏开关（需要在聊天路由）')
    if (q('v3-header-sessionbar').getAttribute('aria-pressed') !== 'true') q('v3-header-sessionbar').click()
    check(await until(() => q('v3-header-sessionbar')?.getAttribute('aria-pressed') === 'true', 4000), '会话栏开关已打开')

    const fixture = store
      .getState()
      .sessions.find((s) => (s.path || '').includes('yan-todo-fixture'))
    if (fixture) {
      await store.getState().switchSession(fixture.path)
      await until(() => store.getState().session?.sessionFile === fixture.path, 10000)
      const realRead = await until(() => store.getState().todos.length > 0, 12000)
      note(`fixture 会话真实读取 todos=${realRead}（${store.getState().todos.length} 条）`)
      if (realRead) {
        check(store.getState().todos.length === FIXTURE_TODOS.length, 'fixture 真实读到 4 条待办')
      } else {
        note('真实读取未在窗口内出现（隔离 pi 未激活该会话的刷新）；以下 DOM 断言使用同形注入')
      }
    } else {
      note('隔离会话表中没有 yan-todo-fixture，跳过真实读取；只做注入断言')
    }

    const setTodos = (todos, running) => {
      const s = store.getState().session ?? {}
      store.setState({
        todos,
        peekedSessionId: PROBE_SID,
        session: {
          ...s,
          sessionId: PROBE_SID,
          isAgentRunning: running,
          isStreaming: false,
          isCompacting: false
        }
      })
    }

    out.push('')
    out.push('--- 1. 磁贴出现 / 计数 / 行状态 ---')
    setTodos(FIXTURE_TODOS, true)
    check(await until(() => !!todoTile()), '有待办时会话栏出现「进度」分区卡（wb-rail-progress）')
    check(todoTile()?.getAttribute('data-folded') === '0', '默认展开（data-folded=0）')
    check((todoCount()?.textContent ?? '').replace(/\s+/g, '') === '2/4', `标题计数 2 / 4（实际 ${JSON.stringify(todoCount()?.textContent)}）`)
    const rows = qa('v3-todo-row')
    check(rows.length === 4, `渲染 4 行（实际 ${rows.length}）`)
    check(rows.filter((r) => r.getAttribute('data-kind') === 'done').length === 2, '2 行标为 done')
    check(rows.filter((r) => r.getAttribute('data-kind') === 'running').length === 1, '1 行标为 running')
    check((rows[2]?.textContent ?? '').includes('把渲染端'), 'running 指向第一个未完成项')
    const doneText = rows[0]?.querySelector('.v3-todo-text')
    check(!!doneText && getComputedStyle(doneText).textDecorationLine === 'line-through', '完成项有删除线')
    check(!!rows[0]?.querySelector('.v3-todo-mark svg'), '完成项状态槽有勾图标')
    check(!!rows[2]?.querySelector('.v3-todo-mark')?.children.length, '进行中项状态槽有标记（spinner）')
    check(rows.filter((r) => r.getAttribute('data-kind') === 'pending').length === 1, '未开始项标为 pending')

    out.push('')
    out.push('--- 2. 受阻行 ---')
    setTodos(
      [
        { text: '任务 1', done: true, status: 'done' },
        { text: '任务 2', done: false, status: 'blocked' },
        { text: '任务 3', done: false, status: 'pending' }
      ],
      true
    )
    check(await until(() => qa('v3-todo-row').some((r) => r.getAttribute('data-kind') === 'blocked')), '受阻项出现')
    const blockedRow = qa('v3-todo-row').find((r) => r.getAttribute('data-kind') === 'blocked')
    check((blockedRow?.textContent ?? '').includes('受阻'), '受阻行显示「受阻」字样')
    check(blockedRow?.getAttribute('data-kind') !== 'running', '受阻不算「进行中」')
    const blockedLabel = blockedRow?.querySelector('.v3-todo-state')
    const normalLabel = qa('v3-todo-row')
      .find((r) => r.getAttribute('data-kind') === 'pending')
      ?.querySelector('.v3-todo-text')
    check(
      !!blockedLabel && !!normalLabel && getComputedStyle(blockedLabel).color !== getComputedStyle(normalLabel).color,
      '受阻状态用警示色（与普通文本不同）'
    )

    out.push('')
    out.push('--- 3. 折叠 / 切换会话保持 ---')
    setTodos(FIXTURE_TODOS, true)
    await until(() => !!todoToggle())
    todoToggle()?.click()
    check(await until(() => todoTile()?.getAttribute('data-folded') === '1'), '点标题行折叠（data-folded=1）')
    check(!q('v3-todo-scroll'), '折叠后清单内部滚动容器不存在（只剩标题）')
    check(!!todoCount() && !!todoToggle(), '折叠后标题行与计数仍在')
    store.setState({ peekedSessionId: `${PROBE_SID}-B` })
    check(
      await until(() => todoTile()?.getAttribute('data-folded') === '0'),
      '折叠按会话记忆（切到另一条会话为默认展开）'
    )
    store.setState({ peekedSessionId: PROBE_SID })
    check(
      await until(() => todoTile()?.getAttribute('data-folded') === '1'),
      '切回原会话仍折叠'
    )
    todoToggle()?.click()
    check(await until(() => todoTile()?.getAttribute('data-folded') === '0'), '可再展开')

    out.push('')
    out.push('--- 4. 超长清单 / 会话列表 ---')
    const many = Array.from({ length: 200 }, (_, i) => ({
      text: `超长任务 ${i + 1} ` + '细节描述'.repeat(16),
      done: i < 50
    }))
    setTodos(many, true)
    check(await until(() => !!q('v3-todo-scroll')), '超长清单挂载内部滚动容器')
    const scroll = q('v3-todo-scroll')
    check(!!scroll && scroll.scrollHeight > scroll.clientHeight + 4, `内部可滚动（${scroll?.scrollHeight} > ${scroll?.clientHeight}）`)
    const maxHeight = scroll ? parseFloat(getComputedStyle(scroll).maxHeight) : NaN
    check(Number.isFinite(maxHeight) && maxHeight <= 160, `高度上限 ${Number.isFinite(maxHeight) ? maxHeight + 'px' : 'n/a'}（不无限长高）`)
    const nav = document.querySelector('.v3-side-list')
    check(!!nav && nav.clientHeight > 0, `会话列表仍有可见高度（${nav ? Math.round(nav.clientHeight) : 'n/a'}px，未被挤没）`)
    const bar = q('v3-sessionbar')
    const railScroll = bar?.querySelector('.wb-overview')
    const barBox = bar?.getBoundingClientRect()
    check(
      !!bar && !!railScroll && !!todoTile() && railScroll.contains(todoTile()) && barBox.bottom <= innerHeight + 1 &&
        getComputedStyle(railScroll).overflowY === 'auto' && railScroll.getBoundingClientRect().bottom <= barBox.bottom + 1,
      '会话栏不超出窗口，超长进度卡留在会话栏的滚动区内'
    )
    check(document.documentElement.scrollWidth <= innerWidth + 1, '无页面横向溢出')

    out.push('')
    out.push('--- 5. 无待办会话 ---')
    const noTodo =
      store.getState().sessions.find((s) => (s.path || '').includes('yan-plain-fixture')) ??
      store.getState().sessions.find((s) => !(s.path || '').includes('yan-todo-fixture') && s.path)
    let realCleared = false
    if (noTodo) {
      await store.getState().switchSession(noTodo.path)
      await until(() => store.getState().session?.sessionFile === noTodo.path, 8000)
      realCleared = await until(() => store.getState().todos.length === 0, 5000)
      note(`切到 ${noTodo.title || noTodo.path} 后真实 todos 清空=${realCleared}`)
    } else {
      note('没有可切换的无待办会话，只做注入清空')
    }
    store.setState({ todos: [] })
    check(await until(() => !todoTile()), '无待办会话磁贴 DOM 不存在')
    check(!document.querySelector('.wb-tile[data-tile="progress"]'), '磁贴 class 也不残留（无空态占位）')

    out.push('')
    out.push('--- 6. Ctrl+B 收起无浮层 ---')
    const root = () => document.querySelector('.v3-root')
    if (root()?.getAttribute('data-side') === 'closed') {
      q('v3-rail-toggle')?.click()
      await until(() => root()?.getAttribute('data-side') === 'open', 3000)
    }
    check(root()?.getAttribute('data-side') === 'open', 'Ctrl+B 前侧栏为展开态')
    const collapsed = await until(() => root()?.getAttribute('data-side') === 'closed', 25000)
    check(collapsed, '收到真实 Ctrl+B 并收起侧栏（data-side=closed）')
    check(!document.querySelector('.v3-scrim'), '收起后没有浮层遮罩（宽窗不另开浮层）')
    const side = q('v3-sidebar')
    const gone = () => !side || getComputedStyle(side).display === 'none' || (getComputedStyle(side).visibility === 'hidden' && side.getBoundingClientRect().width < 1)
    check(await until(gone, 3000), '收起动画结束后侧栏不占布局（隐藏且宽度 < 1px）')
    if (!gone() && side) out.push(`    诊断：width=${side.getBoundingClientRect().width} visibility=${getComputedStyle(side).visibility}`)
    if (!collapsed) {
      out.push(`    诊断：data-side=${root()?.getAttribute('data-side')} narrow=${root()?.getAttribute('data-narrow')}`)
    }

    out.push('证据范围：隔离注入的清单 DOM + 真实 Ctrl+B 按键；不代表真实模型或完整 v3 验收。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
