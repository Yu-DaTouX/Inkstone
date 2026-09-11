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

  // fixture 里应该带一个有任务的会话；没有就现场造一个，免得测试依赖外部数据
  let target = store.getState().sessions.find((s) => s.title.includes('YAN-TODO'))
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
  const grp = q('.rightpanel')
  ok(!!grp, '右栏出现任务区块')
  if (grp) {
    const items = qa('.rp-todo')
    ok(items.length === todos.length, `渲染了 ${items.length} 行（应 ${todos.length}）`)

    const head = grp.querySelector('.rp-head')?.textContent ?? ''
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

    // 位置：右栏在中栏右侧，且任务列表在右栏顶部
    const center = q('.center')?.getBoundingClientRect()
    const r = grp.getBoundingClientRect()
    ok(!!center && r.left >= center.right - 2, `右栏在中栏右侧（center.right=${Math.round(center?.right)} rp.left=${Math.round(r.left)}）`)
    const headBox = grp.querySelector('.rp-head')?.getBoundingClientRect()
    ok(!!headBox && headBox.top <= r.top + 8, '任务列表在右栏顶部')
    ok(q('.rail-body') === null || !q('.rail .todo'), '左栏里已没有任务')
  }

  /* ================= 4. 没有任务的会话不显示空区块 ================= */
  log('\n--- 4. 空任务不占位 ---')
  const noTask = store.getState().sessions.find((s) => s.path !== target.path)
  if (noTask) {
    await store.getState().switchSession(noTask.path)
    for (let i = 0; i < 25; i++) {
      await sleep(400)
      if (store.getState().todos.length === 0) break
    }
    ok(store.getState().todos.length === 0, '切到无任务的会话后 todos 清空')
    ok(!q('.rightpanel'), '不显示空的「任务」区块')
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
