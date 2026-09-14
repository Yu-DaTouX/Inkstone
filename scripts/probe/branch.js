/*
 * 会话分叉树（左栏）——用户要求：
 *   · 会话栏**不要**那个「分支」动作按钮（创建分支只在对话窗口里）
 *   · 分叉树**默认折叠**，开关放在**会话标题旁边**
 *   · 展开后列出每条分支：编号、分叉自哪句话、点击跳过去
 *   · 子会话行上也要有编号 `#N` 与来源
 *
 * 数据来自 pi 的 `session` 头 `parentSession`。fixture 是合成的分支家族
 * （父 + 两个子，见 test-live 的 writeBranchFamily），不依赖真实会话。
 */
;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const sessionPath = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') || ''
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(150) }
    return false
  }
  const store = window.__yanStore

  const findRule = (re) => {
    for (const sheet of document.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }
      for (const r of rules) if (r.selectorText && re.test(r.selectorText)) return r
    }
    return null
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) { click(b); await sleep(300) } else await sleep(150)
    }
    store.getState().setRailPinned(true)
    await until(() => store.getState().conn === 'ready', 25000)
    await until(
      () => store.getState().sessions.some((s) => String(s.title).includes('YAN-FAMILY')),
      20000
    )
    await sleep(900)
    /* 项目行现在拆成「切项目」+「折叠」（N05）：展开要点折叠按钮 */
    for (const h of qa('[data-testid="rail-project-fold"]')) {
      if (h.getAttribute('aria-expanded') === 'false') click(h)
    }
    await sleep(600)

    log('=== 1. 会话栏不再有「分支」动作按钮 ===')
    ok(!q('[data-testid="rail-branches"]'), '没有右侧的分支动作按钮（创建分支只在对话窗口里）')

    log('=== 2. 分叉树：默认折叠，子会话不提前出现在根列表 ===')
    const familyRoot = qa('.srow').find((e) => /YAN-FAMILY/.test(e.textContent))
    const familyPath = sessionPath(familyRoot)
    ok(!!familyRoot && !!familyPath, '找到合成家族父会话及其 data-session-path')
    const familyRows = qa('.srow-wrap').filter((e) => sessionPath(e) === familyPath)
    ok(familyRows.length === 1 && !!familyRows[0]?.closest('.proj'), '父会话只出现在一个项目树节点下')
    const familyChildren = store.getState().sessions.filter((s) => s.parentSession === familyPath)
    ok(familyChildren.length === 2, 'fixture 父会话恰有两个子会话')
    const visibleBefore = new Set(qa('.srow').map(sessionPath))
    ok(familyChildren.every((s) => !visibleBefore.has(s.path)), '折叠时子会话不在根列表中')
    const toggle = familyRoot?.closest('.srow-wrap')?.querySelector('[data-testid="rail-branch-toggle"]')
    ok(!!toggle, '父会话行有分叉开关')
    ok(toggle && toggle.getAttribute('data-open') === '0', '默认是折叠的')
    ok(!familyRoot?.closest('.srow-wrap')?.querySelector('[data-testid="rail-branch-tree"]'), '折叠时父行下看不到树')

    log('=== 3. 展开后：递归树只挂在唯一父节点，行宽统一 ===')
    if (toggle) {
      // 开关是 .srow 的兄弟（不能嵌在行按钮里），且紧挨标题
      ok(toggle.parentElement?.classList.contains('srow-row'), '开关与标题在同一行主体里')
      ok(!!toggle.closest('.srow-wrap')?.querySelector('.srow'), '行主体里还有会话按钮')

      click(toggle)
      await until(() => !!q('[data-testid="rail-branch-tree"]'), 6000)
      const tree = q('[data-testid="rail-branch-tree"]')
      ok(!!tree, '点开关能展开分叉树')
      const items = tree ? [...tree.querySelectorAll('[data-testid="rail-branch-item"]')] : []
      log(`  树里 ${items.length} 条：${items.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')}`)
      ok(items.length === 2, '树里列出两条分支')
      ok(items.some((e) => /#1/.test(e.textContent)), '树里带分支编号')
      const origins = tree ? [...tree.querySelectorAll('[data-testid="rail-branch-origin"]')] : []
      ok(origins.length === 2 && origins.every((e) => getComputedStyle(e).display === 'none'), '来源字段保留但按设计隐藏')
      ok(origins.every((e) => (e.getAttribute('title') || '').includes('YAN-FAMILY 源问题')), '来源 tooltip 保留完整原句')
      ok(items.every((e) => (e.getAttribute('title') || '').includes('YAN-FAMILY 源问题') && (e.getAttribute('title') || '').includes(sessionPath(e))), '子会话 title 同时包含来源与路径')
      const paths = items.map(sessionPath)
      ok(paths.every((p) => familyChildren.some((s) => s.path === p)) && new Set(paths).size === 2, '树中两个子会话路径各出现一次')
      ok(items.every((e) => !e.querySelector('[data-testid="rail-branch-tree"]') && (e.closest('.srow-wrap')?.querySelector('[data-testid="rail-branch-toggle"]')?.getAttribute('data-open') === '0' || !e.closest('.srow-wrap')?.querySelector('[data-testid="rail-branch-toggle"]'))), '父会话展开时默认只显示第一层子节点')
      const rowWidths = qa('.rail .srow-row').map((e) => e.getBoundingClientRect().width).filter((n) => n > 0)
      const widthSpan = rowWidths.length ? Math.max(...rowWidths) - Math.min(...rowWidths) : Infinity
      ok(widthSpan <= 1, '可见 .srow-row 宽度统一（误差 ≤1px）')
    }

    log('=== 4. 时间与操作按钮不重叠 ===')
    const sel = q('.srow-wrap.has-acts') ?? q('.srow-wrap.sel')
    ok(!!sel, '有选中的会话行')
    if (sel) {
      const rule = findRule(/\.srow-wrap:hover\s+\.srow-time/)
      ok(!!rule && /opacity\s*:\s*0/.test(rule.style?.cssText ?? rule.cssText ?? ''), '悬停时时间让位（不叠在动作按钮上）')
    }

    return out.join('\n')
  } catch (e) {
    return out.concat(`  ✗ 抛异常：${e && e.message}`).join('\n')
  }
})()
