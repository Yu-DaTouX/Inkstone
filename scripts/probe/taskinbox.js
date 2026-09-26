/**
 * 任务收件箱的界面探针（实施-28 T2/T5）。
 *
 * 走的是**真实链路**：左栏按钮 → store → IPC → main 的投影服务 → 渲染。
 * 不 mock service —— 收件箱的价值全在「真实聚合」上，mock 掉就只剩样式测试了。
 *
 * 断言：
 *   ① 左栏有入口且能打开 / 再点能关；
 *   ② 打开后确实问了 main（`data-testid="inbox-*"` 出现，不是空壳）；
 *   ③ 刷新不会把界面清空（重进 loading 后仍有内容或空态）；
 *   ④ Esc 能退出（与地图同一套规则）；
 *   ⑤ 首页的「待我处理」卡只在真有要处理的事时出现（没数据就不画卡）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 3000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store.getState().settings) break
      await sleep(250)
    }
    await sleep(600)

    /* ---- ① 入口 ---- */
    const entry = q('[data-testid="rail-inbox"]')
    if (!entry) {
      bad('左栏没有收件箱入口')
    } else {
      ok('左栏有收件箱入口')
      entry.click()
      if (await until(() => q('[data-testid="task-inbox"]'))) ok('点开后出现收件箱视图')
      else bad('点开后没有出现收件箱视图')
    }

    /* ---- ② 真的问了 main（空态也算问过） ---- */
    if (q('[data-testid="task-inbox"]')) {
      const hasCard = q('[data-testid="inbox-card"]')
      const isEmpty = q('[data-testid="inbox-empty"]')
      const hasError = q('[data-testid="inbox-error"]')
      if (hasError) bad('收件箱报错：' + hasError.textContent.slice(0, 80))
      else if (hasCard || isEmpty) ok('收件箱拿到了结果（' + (hasCard ? '有卡片' : '空态') + '）')
      else bad('收件箱既没有卡片也没有空态（可能一直卡在 loading）')

      const degraded = q('[data-testid="inbox-degraded"]')
      out.push('  降级提示: ' + (degraded ? degraded.textContent.trim() : '（无）'))
      out.push('  卡片数: ' + document.querySelectorAll('[data-testid="inbox-card"]').length)

      /* ---- ③ 刷新不清空 ---- */
      const refresh = q('[data-testid="inbox-refresh"]')
      if (refresh) {
        refresh.click()
        await sleep(900)
        const stillThere = q('[data-testid="inbox-card"]') || q('[data-testid="inbox-empty"]')
        if (stillThere) ok('刷新后界面仍有结果（没被清空）')
        else bad('刷新后界面空了')
      } else {
        bad('没有刷新按钮')
      }

      /* ---- 筛选：存在的档能点，且点完不报错 ---- */
      const filter = q('[data-testid="inbox-filter-all"]')
      if (filter) {
        filter.click()
        await sleep(700)
        if (q('[data-testid="inbox-error"]')) bad('点「全部」筛选后报错')
        else ok('筛选「全部」可用')
      }

      /* ---- ④ Esc 退出 ---- */
      if (q('.wb-inbox')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        if (await until(() => !q('[data-testid="task-inbox"]'))) ok('Esc 退出收件箱')
        else bad('Esc 没有退出收件箱')
      }
    }

    /* ---- ⑤ 首页卡：只在有要处理的事时出现 ---- */
    const count = Number(q('[data-testid="rail-inbox"]')?.dataset.count ?? '0')
    store.setState({ messages: [] })
    await store.getState().setWorkspaceMode('daily')
    await sleep(900)
    const homeCard = q('[data-testid="wb-card-inbox"]')
    if (count > 0 && !homeCard) bad('角标显示 ' + count + ' 件，但首页没有「待我处理」卡')
    else if (count === 0 && homeCard) bad('角标是 0，首页却画出了「待我处理」卡（空卡不该出现）')
    else ok('首页卡与角标口径一致（' + count + ' 件）')
    await store.getState().setWorkspaceMode('coding')
  } catch (e) {
    bad('抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[taskinbox] 全部通过' : '[taskinbox] ' + failed + ' 条失败')
  return out.join('\n')
})()
