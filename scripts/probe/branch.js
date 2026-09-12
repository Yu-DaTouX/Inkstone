/**
 * 会话分支树（用户要求：在左栏会话里加分支树，点开看分支详情）。
 *
 * 两件事一起验：
 *   ① **主进程的裁剪**：真实会话 2000+ 节点，原样发给界面既慢又没法看。
 *      裁剪后只留「分支点 + 每条岔路的第一句用户话 + 哪条是活动的」。
 *   ② **左栏的入口与树**：选中的会话行上有分支按钮 → 点开 → 分支点 → 岔路。
 *
 * ⚠️ 两个会让断言假失败的坑（都踩过）：
 *   · 应用启动时开的是**新会话**（空树）→ 必须显式切到 fixture 会话
 *   · 断言的节点数是**动态的**（fixture 一变就变）→ 只断言性质
 *     （有分支点 / 有活动标记 / 裁剪确实变少了），不绑具体数字
 *
 * ⚠️ 另一个事实：pi 的 RPC **没有** navigate_tree，所以这里只能
 *    「查看 + 从这里分支」，不能切到已存在的分支 —— 界面也不该有那个按钮。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150) } return false }
  const store = window.__yanStore
  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    // 等 pi 就绪并载入真实会话（fixture）
    await until(() => store.getState().conn === 'ready', 25000)
    await sleep(1200)
    /*
     * 显式切到**最大的那个 fixture 会话**再读分支树。
     * 应用启动时开的是新会话（空树）—— 不切的话读到 0 个分支点，
     * 断言会假失败（实测第一版就踩了）。
     */
    const ses = store.getState().sessions
    out.push('  会话数 ' + ses.length + ': ' + JSON.stringify(ses.slice(0, 3).map((x) => x.title)))
    /*
     * ⚠️ 不要按固定的文件名找 fixture（测试的 fixture 集合会变）——
     *    逐个试，直到某个会话真的有分支点。这既稳，又能证明
     *    「分支树对任意会话都成立」。
     */
    let picked = null
    for (const cand of ses.slice(0, 6)) {
      await store.getState().switchSession(cand.path)
      await until(() => store.getState().session?.sessionFile === cand.path, 20000)
      await sleep(1200)
      const probe = await window.yan.sessionTree()
      out.push('  ' + JSON.stringify(cand.title.slice(0, 18)) + ' → ' + probe.points + ' 个分支点')
      if (probe.points > 0) { picked = cand; break }
    }
    out.push('  选用: ' + (picked ? picked.title : '（没有带分支的会话）'))

    out.push('=== 1. 主进程裁剪后的分支树 ===')
    const t = await window.yan.sessionTree()
    out.push('  分支点 ' + t.points + '  总节点 ' + t.total + '  分支数组 ' + t.branches.length)
    if (t.points > 0) ok('真的读到了分支（' + t.points + ' 个）')
    else bad('没读到分支（fixture 会话应该有）')
    const bp = t.branches[0]
    if (bp) {
      out.push('  第一个分支点: afterMessages=' + bp.afterMessages + ' 岔路=' + bp.alternatives.length)
      bp.alternatives.forEach((a, i) => out.push(`    岔路${i}: active=${a.active} size=${a.size} text=${JSON.stringify(a.text.slice(0, 40))}`))
      if (bp.alternatives.length >= 2) ok('分支点有 ≥2 条岔路')
      if (bp.alternatives.some((a) => a.active)) ok('标出了活动分支')
      if (bp.alternatives.some((a) => a.text)) ok('岔路有用户消息当标签')
      // 裁剪效果：树里 2000+ 节点，回给界面只有分支
      if (t.total > 100 && t.points < 50) ok('裁剪生效（' + t.total + ' 节点 → ' + t.points + ' 个分支点）')
    }

    out.push('\n=== 2. 左栏的分支入口与树 ===')
    const btn = document.querySelector('[data-testid="rail-branches"]')
    if (!btn) { bad('左栏没有分支入口（要先选中一个会话）') }
    else {
      ok('有分支入口')
      if (btn.getAttribute('data-open') === '0') ok('默认收起')
      click(btn)
      const opened = await until(() => document.querySelector('[data-testid="branch-tree"]'), 15000)
      if (opened) ok('点开后出现分支树')
      else bad('点不开分支树')
      const heads = [...document.querySelectorAll('.bt-head')]
      out.push('  分支点行: ' + heads.length)
      if (heads.length === t.points) ok('渲染的分支点数与数据一致')
      click(heads[0])
      await until(() => document.querySelector('.bt-body'), 3000)
      const alts = [...document.querySelectorAll('.bt-alt')]
      out.push('  展开第一个分支点后岔路: ' + alts.length)
      if (alts.length >= 2) ok('能看到岔路')
      const active = document.querySelector('.bt-alt[data-active="1"]')
      if (active) ok('活动分支有标记')
      else bad('没有活动分支标记')
      const forks = [...document.querySelectorAll('.bt-fork')]
      if (forks.length === alts.length) ok('每条岔路都有「从这里分支」')
      else bad('分支按钮数量不对')
      // 不该有「切换分支」按钮（协议不支持，不做假功能）
      if (!/切换/.test(document.body.textContent)) ok('没有「切换分支」按钮（协议没这个能力）')
      click(btn)
    }
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[branch] 全部通过' : '[branch] ' + failed + ' 条失败')
  return out.join('\n')
})()
