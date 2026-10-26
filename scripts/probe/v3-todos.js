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
  const qa = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)]
  const planCard = () => q('plan-card')
  const planTitle = () => planCard()?.querySelector('.plan-card-title')
  const planToggle = () => q('plan-card-toggle')
  const store = window.__yanStore
  const PREF_KEY = 'inkstone.v3.planCard.expanded'
  const readPref = () => {
    try {
      return localStorage.getItem(PREF_KEY)
    } catch {
      return null
    }
  }
  const savedPref = readPref()
  const tokenColor = (name) => {
    const el = document.createElement('span')
    el.style.color = `var(${name})`
    document.body.appendChild(el)
    const color = getComputedStyle(el).color
    el.remove()
    return color
  }
  const ensureExpanded = async (want) => {
    if ((planToggle()?.getAttribute('aria-expanded') === 'true') !== want) planToggle()?.click()
    return until(() => planToggle()?.getAttribute('aria-expanded') === String(want))
  }

  const FIXTURE_TODOS = [
    { text: '读 spec 并确认范围', done: true },
    { text: '写 protocol.ts 的 JSONL 分帧', done: true },
    { text: '把渲染端的假数据换成 MainPush 补丁', done: false },
    { text: '补测试并用真实应用跑一遍回归', done: false }
  ]
  const PROBE_SID = '__v3-todos-probe__'

  try {
    out.push('=== v3 计划行（输入框卡片内第一行，隔离探针）===')
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
    check(await until(() => !!q('composer-input'), 8000), '正式输入框已挂载')

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

    const setPlan = (todos, { running = true, todoHistory, messages } = {}) => {
      const s = store.getState().session ?? {}
      store.setState({
        todos,
        todoHistory: todoHistory ?? [{ id: 'probe-round', todos, round: 1 }],
        messages: messages ?? [{ id: 'probe-u1', role: 'user', text: '探针消息', timestamp: Date.now() }],
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
    out.push('--- 1. 计划行与输入框连成一体 / 默认一行 / 四态图标 ---')
    setPlan(FIXTURE_TODOS, { running: true })
    check(await until(() => !!planCard()), '有待办时输入框顶部出现计划行（plan-card）')
    const card = planCard()?.closest('.composer')
    check(!!card && planCard()?.parentElement === card, '计划行在输入框卡片内（不是框外独立卡片）')
    check(planCard()?.previousElementSibling?.classList.contains('cborder') === true, '计划行是卡片内第一行（只在顶边之后）')
    if (card) {
      const cardBox = card.getBoundingClientRect()
      const planBox = planCard().getBoundingClientRect()
      const edge = parseFloat(getComputedStyle(card).borderTopWidth) || 0
      check(Math.abs(planBox.top - (cardBox.top + edge)) <= 1, `计划行贴住卡片上沿、没有缝（差 ${(planBox.top - cardBox.top - edge).toFixed(1)}px）`)
      check(Math.abs(planBox.left - (cardBox.left + edge)) <= 1 && Math.abs(cardBox.right - edge - planBox.right) <= 1, '计划行铺满卡片宽度，分隔线左右到边')
      check(getComputedStyle(planCard()).backgroundColor === 'rgba(0, 0, 0, 0)', '计划行没有自己的底色（沿用输入框底色）')
      const planBorder = parseFloat(getComputedStyle(planCard()).borderBottomWidth)
      check(Math.abs(planBorder - 1) < 0.01 || Math.abs(planBorder - 1 / devicePixelRatio) < 0.01, `计划行与输入区之间只有一条 1px 分隔线（按设备像素取整，实际 ${planBorder.toFixed(3)}px）`)
    }
    if (savedPref === null) {
      check(planToggle()?.getAttribute('aria-expanded') === 'false', '没有记住的偏好时默认收成一行（aria-expanded=false）')
    } else {
      note(`已有记住的展开偏好 ${savedPref}，跳过默认收起断言`)
    }
    check(await ensureExpanded(false), '收起态可达')
    check(!q('plan-card-scroll'), '收起时没有清单滚动容器（只剩一行）')
    check(
      await until(() => (planTitle()?.textContent ?? '').includes('计划 2/4') && (planTitle()?.textContent ?? '').includes('正在：把渲染端')),
      `收起态一行为「计划 2/4 · 正在：<当前项>」（实际 ${JSON.stringify(planTitle()?.textContent)}）`
    )
    const head = planToggle()
    check(head?.tagName === 'BUTTON' && head.getAttribute('type') === 'button', '标题行是原生按钮，可 Tab 聚焦，Enter/Space 切换')
    check(await ensureExpanded(true), '点标题展开')
    check(readPref() === '1', '展开状态写入 localStorage')
    check((planTitle()?.textContent ?? '').replace(/\s+/g, '') === '计划2/4', `展开后标题只剩「计划 2/4」（实际 ${JSON.stringify(planTitle()?.textContent)}）`)
    check(!!q('plan-card-scroll'), '展开时有清单滚动容器（plan-card-scroll）')
    const rows = qa('v3-todo-row')
    check(rows.length === 4, `渲染 4 行（实际 ${rows.length}）`)
    check(rows.filter((r) => r.getAttribute('data-kind') === 'done').length === 2, '2 行标为 done')
    check(rows.filter((r) => r.getAttribute('data-kind') === 'running').length === 1, '1 行标为 running')
    check((rows[2]?.textContent ?? '').includes('把渲染端'), 'running 指向第一个未完成项')
    check(rows.filter((r) => r.getAttribute('data-kind') === 'pending').length === 1, '未开始项标为 pending')
    check(!!rows[0]?.querySelector('.v3-todo-mark svg.lucide-circle-check'), '完成项图标为实心勾圆（CircleCheck）')
    check(!!rows[2]?.querySelector('.v3-todo-mark svg.lucide-circle-ellipsis'), '进行中项图标为省略号圆（CircleEllipsis）')
    check(!!rows[3]?.querySelector('.v3-todo-mark svg.lucide-circle-dashed'), '待做项图标为虚线圆（CircleDashed）')
    const doneText = rows[0]?.querySelector('.v3-todo-text')
    const pendingText = rows[3]?.querySelector('.v3-todo-text')
    check(!!doneText && getComputedStyle(doneText).textDecorationLine !== 'line-through', '完成项不加删除线')
    check(
      !!doneText && !!pendingText && getComputedStyle(doneText).color === getComputedStyle(pendingText).color,
      '各状态行文字颜色统一（只靠图标区分状态）'
    )
    const doneMark = rows[0]?.querySelector('.v3-todo-mark')
    const runningMark = rows[2]?.querySelector('.v3-todo-mark')
    check(!!doneMark && getComputedStyle(doneMark).color === tokenColor('--fg2'), '完成勾是次级灰（不再是成功绿）')
    check(!!doneMark && getComputedStyle(doneMark.querySelector('circle')).fill !== 'none', '完成勾是实心勾')
    check(!!runningMark && getComputedStyle(runningMark).color === tokenColor('--run'), '进行中保留运行蓝')
    check(!!runningMark && getComputedStyle(runningMark).animationName === 'none', '进行中图标不呼吸')

    out.push('')
    out.push('--- 2. 受阻行 ---')
    setPlan([
      { text: '任务 1', done: true, status: 'done' },
      { text: '任务 2', done: false, status: 'blocked' },
      { text: '任务 3', done: false, status: 'pending' }
    ])
    check(await until(() => qa('v3-todo-row').some((r) => r.getAttribute('data-kind') === 'blocked')), '受阻项出现')
    const blockedRow = qa('v3-todo-row').find((r) => r.getAttribute('data-kind') === 'blocked')
    const pendingRow = qa('v3-todo-row').find((r) => r.getAttribute('data-kind') === 'pending')
    check(!!blockedRow?.querySelector('.v3-todo-mark svg.lucide-circle-alert'), '受阻行图标为警示圆（CircleAlert）')
    check(blockedRow?.getAttribute('data-kind') !== 'running', '受阻不算「进行中」')
    const blockedMark = blockedRow?.querySelector('.v3-todo-mark')
    const pendingMark = pendingRow?.querySelector('.v3-todo-mark')
    check(
      !!blockedMark && !!pendingMark && getComputedStyle(blockedMark).color !== getComputedStyle(pendingMark).color,
      '受阻图标用警示色（与普通待做图标颜色不同）'
    )

    out.push('')
    out.push('--- 3. 计划早于用户最新消息 ---')
    setPlan(FIXTURE_TODOS, {
      running: false,
      todoHistory: [{ id: 'probe-stale', todos: FIXTURE_TODOS, round: 1 }],
      messages: [
        { id: 'probe-u1', role: 'user', text: '第 1 条消息', timestamp: Date.now() },
        { id: 'probe-u2', role: 'user', text: '第 2 条消息', timestamp: Date.now() }
      ]
    })
    check(
      await until(() => (planTitle()?.textContent ?? '').includes('在你上一条消息之前制定')),
      `计划早于用户最新消息时标题改为「计划 · 在你上一条消息之前制定」（实际 ${JSON.stringify(planTitle()?.textContent)}）`
    )
    setPlan(FIXTURE_TODOS, { running: true })
    check(
      await until(() => !(planTitle()?.textContent ?? '').includes('在你上一条消息之前制定')),
      '计划更新到最新一轮后标题恢复计数形式'
    )

    out.push('')
    out.push('--- 4. 收起 / 展开 ---')
    planToggle()?.click()
    check(await until(() => planToggle()?.getAttribute('aria-expanded') === 'false'), '点标题收起（aria-expanded=false）')
    check(!q('plan-card-scroll'), '收起后清单滚动容器不存在（只剩标题行）')
    check(readPref() === '0', '收起状态写入 localStorage')
    check(
      await until(() => (planTitle()?.textContent ?? '').includes('计划 2/4') && (planTitle()?.textContent ?? '').includes('正在：')),
      `收起态标题为「计划 2/4 · 正在：<当前项>」（实际 ${JSON.stringify(planTitle()?.textContent)}）`
    )
    const collapsedHeight = planCard()?.getBoundingClientRect().height ?? 0
    check(collapsedHeight > 0 && collapsedHeight <= 36, `收起态只占一行（${collapsedHeight.toFixed(1)}px）`)
    planToggle()?.click()
    check(await until(() => planToggle()?.getAttribute('aria-expanded') === 'true'), '再点可展开')
    check(!!q('plan-card-scroll'), '展开后清单滚动容器恢复')

    out.push('')
    out.push('--- 5. 超长清单：卡内滚动，不无限长高 ---')
    const many = Array.from({ length: 200 }, (_, i) => ({
      text: `超长任务 ${i + 1} ` + '细节描述'.repeat(16),
      done: i < 50
    }))
    setPlan(many, { running: true })
    check(await until(() => !!q('plan-card-scroll')), '超长清单仍挂载滚动容器')
    const scroll = q('plan-card-scroll')
    check(!!scroll && scroll.scrollHeight > scroll.clientHeight + 4, `内部可滚动（${scroll?.scrollHeight} > ${scroll?.clientHeight}）`)
    const maxHeight = scroll ? parseFloat(getComputedStyle(scroll).maxHeight) : NaN
    check(Number.isFinite(maxHeight) && maxHeight <= 120, `高度上限约四行（${Number.isFinite(maxHeight) ? maxHeight + 'px' : 'n/a'}，不无限长高）`)
    check(scroll?.getAttribute('data-overflow') === 'true', '超长清单标记 data-overflow=true（驱动底部渐隐）')
    const activeRow = qa('v3-todo-row').find((r) => r.getAttribute('data-kind') === 'running')
    if (scroll && activeRow) {
      const top = activeRow.offsetTop - scroll.scrollTop
      check(top >= 0 && top + activeRow.offsetHeight <= scroll.clientHeight, `展开时卡内对准当前项（相对顶部 ${top}px）`)
    } else {
      check(false, '超长清单里找到进行中项')
    }
    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight
      check(await until(() => scroll.getAttribute('data-overflow') === 'false'), '滚到底后取消底部渐隐')
    }
    check(await until(() => !!q('composer-input')), '超长清单下输入框仍挂载、未被顶飞')
    check(document.documentElement.scrollWidth <= innerWidth + 1, '无页面横向溢出')

    out.push('')
    out.push('--- 6. 无待办 / 全部完成：整块隐藏 ---')
    setPlan([])
    check(await until(() => !planCard()), '无待办时计划卡 DOM 不存在')
    setPlan([
      { text: '甲', done: true },
      { text: '乙', done: true, status: 'done' }
    ])
    check(await until(() => !planCard()), '全部完成时计划卡也隐藏（不保留已完成清单）')

    out.push('')
    out.push('--- 7. Ctrl+B 收起无浮层 ---')
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
    check(await until(gone, 12000), '收起动画结束后侧栏不占布局（隐藏且宽度 < 1px）')
    if (!gone() && side) out.push(`    诊断：width=${side.getBoundingClientRect().width} visibility=${getComputedStyle(side).visibility}`)
    if (!collapsed) {
      out.push(`    诊断：data-side=${root()?.getAttribute('data-side')} narrow=${root()?.getAttribute('data-narrow')}`)
    }

    out.push('证据范围：隔离注入的计划卡 DOM + 真实 Ctrl+B 按键；不代表真实模型或完整 v3 验收。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  } finally {
    try {
      if (savedPref === null) localStorage.removeItem(PREF_KEY)
      else localStorage.setItem(PREF_KEY, savedPref)
    } catch {
    }
  }
  return out.join('\n')
})()
