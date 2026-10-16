;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }

  const visibleTasksTile = () => {
    const pane = q('.tile-pane[data-workspace-pane="tasks"]')
    return pane && !pane.hidden ? pane : null
  }
  const tq = (selector) => visibleTasksTile()?.querySelector(selector) ?? null
  const tqa = (selector) => [...(visibleTasksTile()?.querySelectorAll(selector) ?? [])]
  const openTasksTile = async () => {
    const launcher = q('[data-testid="right-tool-menu"]')
    if (!launcher) return false
    if (!q('[data-testid="right-tool-menu-popover"]')) {
      launcher.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }
    const menuReady = await until(() => !!q('[data-testid="right-tool-menu-popover"]'))
    if (!menuReady) return false
    const taskItem = [...q('[data-testid="right-tool-menu-popover"]').querySelectorAll('.rp-tool-menu-item')]
      .find((item) => item.textContent.trim() === '任务')
    if (!taskItem) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      return false
    }
    taskItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const menuClosed = await until(() => !q('[data-testid="right-tool-menu-popover"]'))
    const tileReady = await until(() => !!visibleTasksTile())
    return menuClosed && tileReady
  }

  log('=== 扩展集成：任务清单 + 启动通知 ===')

  log('\n--- 1. 启动期通知降级 ---')
  const notices = qa('.notice')
  const extLogs = store.getState().logs.filter((l) => l.includes('[扩展]'))
  log('  弹窗数: ' + notices.length)
  log('  扩展日志: ' + extLogs.length + (extLogs[0] ? ' → ' + JSON.stringify(extLogs[0].slice(0, 60)) : ''))
  ok(notices.length === 0, '启动期的 info 通知没有弹窗')
  ok(store.getState().startupPhase, '还处于启动期（没有真正开始对话）')

  log('\n--- 2. 任务清单（panel_todos 的产物）---')

  let target = store
    .getState()
    .sessions.find((s) => s.path.includes('yan-todo-fixture') || s.title.includes('YAN-TODO'))
  if (!target) {
    log('  fixture 里没有带任务的会话，现场造一个')
    target = await makeTodoSession()
    if (!target) return fail('造不出带任务的会话')
  }

  const piReady = store.getState().conn === 'ready'

  await store.getState().switchSession(target.path)
  const targetReady = await until(() => store.getState().session?.sessionFile === target.path, 15000)
  await until(() => targetReady && store.getState().todos.length > 0, 15000)
  const taskTileReady = await openTasksTile()
  ok(taskTileReady, '通过工作区工具入口打开当前会话的任务磁贴')

  const todos = store.getState().todos
  log('  store.todos = ' + JSON.stringify(todos))
  if (piReady) {
    ok(todos.length > 0, `读到 ${todos.length} 条任务`)
  } else {
    log(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），会话里的任务清单读不到`)
  }

  log('\n--- 3. 任务区块 DOM ---')
  const grp = tq('[data-sec="rp-todo"]')
  if (piReady) ok(!!grp, '任务磁贴出现任务区块')
  else log('  ⤺ 跳过：同上（没有清单，自然也没有区块）')
  if (grp) {
    const items = tqa('.rp-todo')
    ok(items.length === todos.length, `渲染了 ${items.length} 行（应 ${todos.length}）`)

    const head = grp.querySelector('.rp-sec-head')?.textContent ?? ''
    const doneCount = todos.filter((t) => t.done).length
    log('  头部: ' + JSON.stringify(head))
    ok(head.includes(`${doneCount}/${todos.length}`), `头部显示进度 ${doneCount}/${todos.length}`)

    const doneEls = items.filter((t) => t.classList.contains('done'))
    const openEls = items.filter((t) => !t.classList.contains('done'))
    ok(doneEls.length === doneCount, `done 类数量正确（${doneEls.length}）`)
    if (doneEls.length) {
      ok(
        getComputedStyle(doneEls[0].querySelector('.rp-text')).textDecorationLine === 'line-through',
        '已完成的有删除线'
      )
    }
    if (openEls.length) {
      ok(
        getComputedStyle(openEls[0].querySelector('.rp-text')).textDecorationLine === 'none',
        '未完成的没有删除线'
      )
    }

    const pane = visibleTasksTile()
    const canvas = q('.tile-workspace-canvas')
    const r = grp.getBoundingClientRect()
    const p = pane?.getBoundingClientRect()
    const c = canvas?.getBoundingClientRect()
    ok(!!pane && !!p && r.width > 0 && r.left >= p.left - 1 && r.right <= p.right + 1,
      '任务区块宽度位于当前任务磁贴内（纵向内容由磁贴滚动）')
    ok(!!c && !!p && p.width > 0 && p.height > 0 && p.left >= c.left - 1 && p.right <= c.right + 1 && p.top >= c.top - 1 && p.bottom <= c.bottom + 1,
      '任务磁贴几何位于工作区画布范围内')
    ok(q('.rail .todo') === null && q('.rail .rp-todo') === null, '任务清单不重复出现在左栏')
  }

  log('\n--- 4. 空任务不占位 ---')
  let noTask = null
  for (const cand of store.getState().sessions.filter((x) => x.path !== target.path)) {
    await store.getState().switchSession(cand.path)
    const candReady = await until(() => store.getState().session?.sessionFile === cand.path, 15000)
    const candidateTileReady = await openTasksTile()
    if (!candidateTileReady) ok(false, `切到 ${cand.title} 后可重新打开任务磁贴`)
    await until(() => candReady && store.getState().todos.length === 0, 15000)
    if (candReady && store.getState().todos.length === 0) { noTask = cand; break }
  }
  if (noTask) {
    ok(store.getState().todos.length === 0, '切到无任务的会话后 todos 清空（' + noTask.title + '）')
    ok(tqa('[data-testid="tasks-pane"] .rp-todo').length === 0, '无任务会话的任务磁贴没有残留任务行')
  } else {
    log('  （只有一个会话，跳过）')
  }

  log('\n--- 5. 溢出回归 ---')
  for (const sel of ['.rail', '.rail-body', '.status', '.tile-pane[data-workspace-pane="tasks"]', '[data-testid="tasks-pane"]', '.rp-todo-scroll']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }


  log('\n--- 6. 进度条 / 当前任务 / 动画 ---')

  const injectedTileReady = await openTasksTile()
  ok(injectedTileReady, '合成任务渲染前重新打开任务磁贴')

  const tstore = window.__yanStore
  const PROBE_SESSION_ID = '__yan-todos-probe__'
  const setRunning = (v) => {
    const s = tstore.getState().session
    tstore.setState({
      session: { ...(s ?? {}), sessionId: PROBE_SESSION_ID, isAgentRunning: v, isStreaming: v }
    })
  }
  {
    let changes = 0
    const unsub = tstore.subscribe((s, prev) => {
      if (s.session !== prev.session) changes++
    })
    let stable = 0
    while (stable < 5) {
      const before = changes
      await sleep(300)
      if (changes === before) stable++
      else stable = 0
    }
    unsub()
  }
  setRunning(true)

  const tmk = (n, d) =>
    Array.from({ length: n }, (_, i) => ({ text: '任务 ' + (i + 1), done: i < d }))

  tstore.setState({ todos: tmk(5, 2) })
  await sleep(500)

  const tmeter = () => tq('[data-testid="todo-meter"]')
  ok(!!tmeter(), '进度条存在（不管任务数多少）')

  if (tmeter()) {
    log('  填充 = ' + tmeter().querySelector('i').style.width + '  data-pct=' + tmeter().dataset.pct)
    ok(tmeter().dataset.pct === '40', '2/5 显示 40%（实际 ' + tmeter().dataset.pct + '）')
    ok(tmeter().classList.contains('busy'), '未完成时进度条带推进动画')
  }

  const tcount = tq('[data-testid="todo-count"]')
  ok(tcount?.textContent === '2/5', '计数显示 2/5（实际 ' + tcount?.textContent + '）')

  ok(!tq('[data-testid="todo-now"]'), '不再有单独的「正在做」行（已并入任务本体）')
  const tActive = tq('.rp-todo[data-active="1"]')
  log('  当前 = ' + JSON.stringify(tActive ? tActive.textContent : ''))
  ok(!!tActive && tActive.textContent.includes('任务 3'), '当前指向第 3 个（第一个未完成）')
  ok(tqa('.rp-todo.active').length === 1, '列表里恰好一条标为 active')
  const tLabel = tq('[data-testid="todo-active-label"]')
  ok(!!tLabel && !!tLabel.querySelector('*'), '当前那条的状态槽里有进行中标记')

  setRunning(false)
  await sleep(400)
  ok(!tq('.rp-todo[data-active="1"]'), '回合停下后没有条目被标为 active')
  ok(!tq('[data-testid="todo-active-label"]'), '停下后不再有转圈的「正在进行」')
  ok(tqa('.rp-todo.todo-open').length === 3, '未完成的条目仍在（只是不再冒充「正在做」）')
  setRunning(true)
  await sleep(300)
  ok(!!tq('.rp-todo[data-active="1"]'), '回合又跑起来后「正在进行」回来')

  tstore.setState({ todos: tmk(5, 3) })
  await sleep(200)
  ok(!!tmeter(), '进度条节点稳定（不是被重建）')
  const meterAfterDone = tmeter()
  ok(meterAfterDone?.dataset.pct === '60', '勾完变 60%（实际 ' + (meterAfterDone?.dataset.pct ?? 'undefined') + '）')
  ok(tqa('.rp-todo.flash').length === 1, '刚勾完那条带 flash（确认反馈）')

  tstore.setState({
    todos: [
      { text: '任务 1', done: true, status: 'done' },
      { text: '任务 2', done: false, status: 'pending' },
      { text: '任务 3', done: false, status: 'running' }
    ]
  })
  await sleep(400)
  {
    const row = tq('.rp-todo[data-active="1"]')
    ok(!!row && row.textContent.includes('任务 3'), '显式 running 的那条是 active')
    ok(
      !!row && row.textContent.includes('任务 3') && !row.textContent.includes('任务 2'),
      '显式 pending 的那条不算「正在做」（即使它在 running 前面）'
    )
  }

  tstore.setState({
    todos: [
      { text: '任务 1', done: true, status: 'done' },
      { text: '任务 2', done: false, status: 'blocked' },
      { text: '任务 3', done: false, status: 'pending' }
    ]
  })
  await sleep(400)
  {
    const blockedRow = tq('.rp-todo[data-blocked="1"]')
    ok(!!blockedRow, 'blocked 的那条带 data-blocked 标记')
    ok(!!blockedRow && blockedRow.textContent.includes('受阻'), '行内显示「受阻」而不是「未完成」')
    ok(!blockedRow?.classList.contains('active'), '受阻不等于「正在做」')
    const label = tq('[data-testid="todo-blocked-label"]')
    ok(!!label, '受阻有独立的语义标签')
    if (label) {
      const probe = document.createElement('span')
      probe.style.color = 'var(--warn)'
      document.body.appendChild(probe)
      const warnRgb = getComputedStyle(probe).color
      probe.remove()
      ok(getComputedStyle(label).color === warnRgb, '受阻标签用警示色（--warn）')
    }
  }

  {
    const row = tqa('.rp-todo')[0]
    if (row) {
      const cs = getComputedStyle(row)
      ok(cs.display === 'grid', '任务行是 grid（状态槽 / 文本 / 状态说明）')
      const cols = cs.gridTemplateColumns.split(/\s+/).map((v) => parseFloat(v))
      ok(cols.length === 3, `三列布局（状态槽 / 文本 / 状态说明）（实际 ${cs.gridTemplateColumns}）`)
      ok(Math.abs(cols[0] - 12) <= 1, `状态槽 12px（实际 ${cols[0]}px）`)
      ok(parseFloat(cs.columnGap) >= 8, `状态槽与文本间距 ≥ 8px（实际 ${cs.columnGap}）`)
      const box = row.querySelector('.rp-box')
      if (box) {
        const bw = box.getBoundingClientRect().width
        ok(bw <= 16, `复选框不超出状态槽（${Math.round(bw)}px）`)
      }
    }
  }

  await sleep(1000)
  tstore.setState({ todos: tmk(5, 5) })
  await sleep(300)
  {
    const head = tq('[data-sec="rp-todo"] .rp-sec-head')
    if (head && head.getAttribute('aria-expanded') === 'false') {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    }
  }
  ok(!!tmeter() && !tmeter().classList.contains('busy'), '全完成后去掉推进动画')
  ok(!!tq('[data-testid="todo-all-done"]'), '全完成后有「全部完成」提示')
  ok(!tq('[data-testid="todo-active-label"]'), '全完成后不再有「正在进行」标记')

  tstore.setState({ todos: [] })
  await sleep(200)
  ok(!tmeter(), '没有任务时不渲染进度条（不占位）')


  return out.join('\n')



  async function makeTodoSession() {
    log('  ⚠️  需要 scripts/test-live.mjs 的 fixture 提供一个带 YAN-TODO 的会话')
    return null
  }
})()
