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

  await store.getState().switchSession(target.path)
  // 切会话要等 pi 加载 + hydrate，实测约 3-5 秒
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    if (store.getState().todos.length > 0) break
  }

  const todos = store.getState().todos
  log('  store.todos = ' + JSON.stringify(todos))
  ok(todos.length > 0, `读到 ${todos.length} 条任务`)

  /* ================= 3. 任务渲染正确（含完成态） ================= */
  log('\n--- 3. 任务区块 DOM ---')
  const grp = q('[data-sec="rp-todo"]')
  ok(!!grp, '右栏出现任务区块')
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

  /* ---- 勾完一个：宽度变化 + 闪动 ---- */
  tstore.setState({ todos: tmk(5, 3) })
  await sleep(200)
  ok(!!tmeter(), '进度条节点稳定（不是被重建）')
  ok(tmeter().dataset.pct === '60', '勾完变 60%（实际 ' + tmeter().dataset.pct + '）')
  ok(qa('.rp-todo.flash').length === 1, '刚勾完那条带 flash（确认反馈）')

  /* ---- 全完成 ---- */
  await sleep(1000)
  tstore.setState({ todos: tmk(5, 5) })
  await sleep(300)
  ok(!tmeter().classList.contains('busy'), '全完成后去掉推进动画')
  ok(!!q('[data-testid="todo-all-done"]'), '全完成后有「全部完成」提示')
  ok(!q('[data-testid="todo-active-label"]'), '全完成后不再有「正在进行」标记')

  /* ---- 恢复真实数据（别把用户的会话状态改坏）---- */
  tstore.setState({ todos: [] })
  await sleep(200)
  ok(!tmeter(), '没有任务时不渲染进度条（不占位）')


  return out.join('\n')

  /* ---------------------------------------------------------------- */

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
