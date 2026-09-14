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

  log('=== 扩展集成：任务清单 + 启动通知 ===')

  /* ================= 1. 启动期通知不弹窗 ================= */
  log('\n--- 1. 启动期通知降级 ---')
  // 用户的 left-info-panel 扩展每次启动都会 notify（「信息面板已启用（overlay 44 列）…」），
  // 它描述的是 TUI 的 overlay，在桌面端不适用。应该进日志而不是弹出来。
  const notices = qa('.notice')
  const extLogs = store.getState().logs.filter((l) => l.includes('[扩展]'))
  log('  弹窗数: ' + notices.length)
  log('  扩展日志: ' + extLogs.length + (extLogs[0] ? ' → ' + JSON.stringify(extLogs[0].slice(0, 60)) : ''))
  ok(notices.length === 0, '启动期的 info 通知没有弹窗')
  ok(store.getState().startupPhase, '还处于启动期（没有真正开始对话）')

  /* ================= 2. 任务清单从会话里读出来 ================= */
  log('\n--- 2. 任务清单（panel_todos 的产物）---')

  /*
   * fixture 里应该带一个有任务的会话；没有就现场造一个，免得测试依赖外部数据。
   *
   * ⚠️ 按 **path** 找，不能按 title 找。
   *   本会话踩到过：改成「每轮用模型重新生成标题」之后，
   *   前面的场景（live / sessions）一跑就会把这个 fixture 会话的标题
   *   改成模型生成的短标题，于是这里 `title.includes('YAN-TODO')` 找不到，
   *   于是走到“现场造”分支、而造出来的又没进 sessions 列表 → 整个场景失败。
   *   单独跑 todos 是过的 —— 典型的“只在全量跑时暴露”。
   *
   *   fixture 的文件名里带 `yan-todo-fixture`（见 test-live.mjs），
   *   那是它真正的身份，不会变。
   */
  let target = store
    .getState()
    .sessions.find((s) => s.path.includes('yan-todo-fixture') || s.title.includes('YAN-TODO'))
  if (!target) {
    log('  fixture 里没有带任务的会话，现场造一个')
    target = await makeTodoSession()
    if (!target) return fail('造不出带任务的会话')
  }

  /** 从会话读清单要走 pi（agent.ts 的 refreshTodos → `get_entries`）；采样一次 */
  const piReady = store.getState().conn === 'ready'

  await store.getState().switchSession(target.path)
  // 切会话要等 pi 加载 + hydrate，实测约 3-5 秒
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    if (store.getState().todos.length > 0) break
  }

  const todos = store.getState().todos
  log('  store.todos = ' + JSON.stringify(todos))
  /*
   * ⚠️ 这份清单是**从会话里读的**（agent.ts 的 refreshTodos 调 pi 的 `get_entries`），
   *    所以隔离测试环境（pi 起不来）里读到 0 条是**环境**，不是回归 ——
   *    显式跳过，别把它读成「任务功能坏了」。
   *    不依赖 pi 的那部分在下面第 6 节（直接往 store 注入）。
   */
  if (piReady) {
    ok(todos.length > 0, `读到 ${todos.length} 条任务`)
  } else {
    log(`  ⤺ 跳过：pi 未就绪（conn=${store.getState().conn}），会话里的任务清单读不到`)
  }

  /* ================= 3. 任务渲染正确（含完成态） ================= */
  log('\n--- 3. 任务区块 DOM ---')
  const grp = q('[data-sec="rp-todo"]')
  if (piReady) ok(!!grp, '右栏出现任务区块')
  else log('  ⤺ 跳过：同上（没有清单，自然也没有区块）')
  if (grp) {
    const items = qa('.rp-todo')
    ok(items.length === todos.length, `渲染了 ${items.length} 行（应 ${todos.length}）`)

    const head = grp.querySelector('.rp-sec-head')?.textContent ?? ''
    const doneCount = todos.filter((t) => t.done).length
    log('  头部: ' + JSON.stringify(head))
    ok(head.includes(`${doneCount}/${todos.length}`), `头部显示进度 ${doneCount}/${todos.length}`)

    // 完成/未完成的视觉区分
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

    // 位置：右栏在中栏右侧。
    //
    // ⚠️ 不再断言「任务在右栏**顶部**」—— 右栏已经从头改成 OpenCode 风格的
    //    状态栏（上下文 / 任务 / 队列 / 扩展 / 环境 / 操作），
    //    任务排在第一块「上下文」之后。这里只保证它确实在右栏里。
    const center = q('.center')?.getBoundingClientRect()
    const r = grp.getBoundingClientRect()
    const rp = q('[data-testid="rightpanel"]')?.getBoundingClientRect()
    ok(!!center && r.left >= center.right - 2, `右栏在中栏右侧（center.right=${Math.round(center?.right)} rp.left=${Math.round(r.left)}）`)
    ok(!!rp && r.left >= rp.left - 1 && r.right <= rp.right + 1, '任务区块在右栏内（不再跑到中栏）')
    ok(q('.rail .todo') === undefined || q('.rail .rp-todo') === null, '左栏里已没有任务')
  }

  /* ================= 4. 没有任务的会话不显示空区块 ================= */
  log('\n--- 4. 空任务不占位 ---')
  /*
   * ⚠️ 不要拿「第一个不是当前的会话」当「无任务的会话」——
   *    那个会话可能也有任务（fixture 一变就假失败，实测全量跑时挂过）。
   *    这里逐个试，直到找到一个确实没有任务的（并把它记下来用于后续断言）。
   */
  let noTask = null
  for (const cand of store.getState().sessions.filter((x) => x.path !== target.path)) {
    await store.getState().switchSession(cand.path)
    for (let i = 0; i < 25; i++) {
      await sleep(400)
      if (store.getState().todos.length === 0) break
    }
    if (store.getState().todos.length === 0) { noTask = cand; break }
  }
  if (noTask) {
    ok(store.getState().todos.length === 0, '切到无任务的会话后 todos 清空（' + noTask.title + '）')
    // 右栏现在**常驻**（包含上下文/环境等），所以判据不是「右栏消失」，
    // 而是「没有任务时不渲染任务区块」。
    ok(q('[data-sec="rp-todo"]') === null, '没有任务时不渲染任务区块')
  } else {
    log('  （只有一个会话，跳过）')
  }

  /* ================= 5. 溢出回归（任务文字可能很长） ================= */
  log('\n--- 5. 溢出回归 ---')
  for (const sel of ['.rail', '.rail-body', '.status']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  /* ============ 6. 进度条 / 当前任务 / 动画（用户要求） ============ */


  log('\n--- 6. 进度条 / 当前任务 / 动画 ---')

  const tstore = window.__yanStore
  /**
   * 回合是否运行中 —— 「正在进行」现在要求它（见 RightPanel 的 activeIdx）。
   *
   * 只有 `{text, done}` 的老数据里，「哪条正在做」是**推断**：第一个未完成的，
   * **且回合真的在跑**。所以注入任务前必须把会话标成运行中 ——
   * 否则这里断言的就是「停下也硬说有人在跑」那个旧行为。
   */
  const setRunning = (v) => {
    const s = tstore.getState().session
    tstore.setState({ session: { ...(s ?? {}), isAgentRunning: v, isStreaming: v } })
  }
  setRunning(true)

  /** 造 N 个任务、前 d 个已完成 */
  const tmk = (n, d) =>
    Array.from({ length: n }, (_, i) => ({ text: '任务 ' + (i + 1), done: i < d }))

  /* ---- 5 个任务，完成 2 个（用户描述的场景）---- */
  tstore.setState({ todos: tmk(5, 2) })
  await sleep(500)

  const tmeter = () => q('[data-testid="todo-meter"]')
  ok(!!tmeter(), '进度条存在（不管任务数多少）')

  if (tmeter()) {
    log('  填充 = ' + tmeter().querySelector('i').style.width + '  data-pct=' + tmeter().dataset.pct)
    ok(tmeter().dataset.pct === '40', '2/5 显示 40%（实际 ' + tmeter().dataset.pct + '）')
    ok(tmeter().classList.contains('busy'), '未完成时进度条带推进动画')
  }

  const tcount = q('[data-testid="todo-count"]')
  ok(tcount?.textContent === '2/5', '计数显示 2/5（实际 ' + tcount?.textContent + '）')

  /* ---- 当前任务 = 第一个未完成的 ---- */
  /*
   * 当前任务 = 第一个未完成的，而且**在任务本体那一行上**显示（用户要求）。
   *
   * 这里原来断言的是一个**单独的行**（todo-now，重复一遍当前任务名）。
   * 用户提了「正在进行的任务在任务本体上显示 而不是单独开一栏」，
   * 那一行已删，所以改断言三件事：
   *   · 不存在单独的行
   *   · 当前那条在列表里带 active（且只有一条）
   *   · 它行内有「正在进行」+ spinner
   */
  ok(!q('[data-testid="todo-now"]'), '不再有单独的「正在做」行（已并入任务本体）')
  const tActive = q('.rp-todo[data-active="1"]')
  log('  当前 = ' + JSON.stringify(tActive ? tActive.textContent : ''))
  ok(!!tActive && tActive.textContent.includes('任务 3'), '当前指向第 3 个（第一个未完成）')
  ok(qa('.rp-todo.active').length === 1, '列表里恰好一条标为 active')
  const tLabel = q('[data-testid="todo-active-label"]')
  ok(!!tLabel && /正在进行/.test(tLabel.textContent), '当前那条行内显示「正在进行」')

  /* ---- 回合停下来：未完成的那些不该再冒充「正在进行」---- */
  /*
   * 这是方案 4.5 的核心：只有 `done` 时「哪条在做」只能猜，于是只要还有
   * 没做完的任务，界面上就永远有一条在转 —— agent 停了也照转。
   */
  setRunning(false)
  await sleep(400)
  ok(!q('.rp-todo[data-active="1"]'), '回合停下后没有条目被标为 active')
  ok(!q('[data-testid="todo-active-label"]'), '停下后不再有转圈的「正在进行」')
  ok(qa('.rp-todo.todo-open').length === 3, '未完成的条目仍在（只是不再冒充「正在做」）')
  setRunning(true)
  await sleep(300)
  ok(!!q('.rp-todo[data-active="1"]'), '回合又跑起来后「正在进行」回来')

  /* ---- 勾完一个：宽度变化 + 闪动 ---- */
  tstore.setState({ todos: tmk(5, 3) })
  await sleep(200)
  ok(!!tmeter(), '进度条节点稳定（不是被重建）')
  ok(tmeter().dataset.pct === '60', '勾完变 60%（实际 ' + tmeter().dataset.pct + '）')
  ok(qa('.rp-todo.flash').length === 1, '刚勾完那条带 flash（确认反馈）')

  /*
   * 显式 status 优先（pi 侧带了状态就不再猜）。
   *
   * 放在这里而不是更早：它会改掉 todos，从而打乱上面 flash 断言依赖的
   * prevDone 基线（实测因此误报过一次 —— flash 变成 2 条）。
   */
  tstore.setState({
    todos: [
      { text: '任务 1', done: true, status: 'done' },
      { text: '任务 2', done: false, status: 'pending' },
      { text: '任务 3', done: false, status: 'running' }
    ]
  })
  await sleep(400)
  {
    const row = q('.rp-todo[data-active="1"]')
    ok(!!row && row.textContent.includes('任务 3'), '显式 running 的那条是 active')
    ok(
      !!row && row.textContent.includes('任务 3') && !row.textContent.includes('任务 2'),
      '显式 pending 的那条不算「正在做」（即使它在 running 前面）'
    )
  }

  /* ---- 受阻（方案 7.1）---- */
  tstore.setState({
    todos: [
      { text: '任务 1', done: true, status: 'done' },
      { text: '任务 2', done: false, status: 'blocked' },
      { text: '任务 3', done: false, status: 'pending' }
    ]
  })
  await sleep(400)
  {
    const blockedRow = q('.rp-todo[data-blocked="1"]')
    ok(!!blockedRow, 'blocked 的那条带 data-blocked 标记')
    ok(!!blockedRow && blockedRow.textContent.includes('受阻'), '行内显示「受阻」而不是「未完成」')
    ok(!blockedRow?.classList.contains('active'), '受阻不等于「正在做」')
    const label = q('[data-testid="todo-blocked-label"]')
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

  /* ---- 行布局：状态槽 / 文本 / 状态说明（方案 7.1）---- */
  {
    const row = qa('.rp-todo')[0]
    if (row) {
      const cs = getComputedStyle(row)
      ok(cs.display === 'grid', '任务行是 grid（状态槽 / 文本 / 状态说明）')
      const cols = cs.gridTemplateColumns.split(/\s+/).map((v) => parseFloat(v))
      ok(cols.length === 3, `三列布局（实际 ${cs.gridTemplateColumns}）`)
      ok(Math.abs(cols[0] - 16) <= 1, `状态槽 16px（实际 ${cols[0]}px）`)
      ok(parseFloat(cs.columnGap) >= 8, `状态槽与文本间距 ≥ 8px（实际 ${cs.columnGap}）`)
      const box = row.querySelector('.rp-box')
      if (box) {
        const bw = box.getBoundingClientRect().width
        ok(bw <= 16, `复选框不超出状态槽（${Math.round(bw)}px）`)
      }
    }
  }

  /* ---- 全完成 ---- */
  await sleep(1000)
  tstore.setState({ todos: tmk(5, 5) })
  await sleep(300)
  /*
   * 全部完成时任务栏会**自动收起**（用户要求，todonew 专测）。
   * 收起后 Section 不渲染 body → 进度条节点不在 DOM。
   * 这里要验证的是「去掉推进动画」，所以先把分区重新展开再查。
   */
  {
    const head = q('[data-sec="rp-todo"] .rp-sec-head')
    if (head && head.getAttribute('aria-expanded') === 'false') {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    }
  }
  ok(!!tmeter() && !tmeter().classList.contains('busy'), '全完成后去掉推进动画')
  ok(!!q('[data-testid="todo-all-done"]'), '全完成后有「全部完成」提示')
  ok(!q('[data-testid="todo-active-label"]'), '全完成后不再有「正在进行」标记')

  /* ---- 恢复真实数据（别把用户的会话状态改坏）---- */
  tstore.setState({ todos: [] })
  await sleep(200)
  ok(!tmeter(), '没有任务时不渲染进度条（不占位）')


  return out.join('\n')



  /**
   * 造一个带 left-panel-tasks custom entry 的会话。
   * 放在隔离目录里（测试跑在 YAN_SESSIONS_DIR 上），所以不会污染真实数据。
   */
  async function makeTodoSession() {
    // 渲染端不能写文件，所以通过主进程的调试口子？没有。
    // 换个做法：直接问 pi 跑一个 prompt，然后……太慢。
    // 最简做法：用 window.yan 没有的能力 → 只能靠 fixture。
    // 这里明确报告失败，让 fixture 负责提供数据。
    log('  ⚠️  需要 scripts/test-live.mjs 的 fixture 提供一个带 YAN-TODO 的会话')
    return null
  }
})()
