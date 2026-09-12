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
    for (const h of qa('.proj-head')) if (h.classList.contains('collapsed')) click(h)
    await sleep(600)

    log('=== 1. 会话栏不再有「分支」动作按钮 ===')
    ok(!q('[data-testid="rail-branches"]'), '没有右侧的分支动作按钮（创建分支只在对话窗口里）')

    log('=== 2. 子会话行：编号 + 来源 ===')
    const nos = qa('[data-testid="rail-branch-no"]').map((e) => e.textContent.trim())
    log(`  分支编号：${JSON.stringify(nos)}`)
    ok(nos.includes('#1') && nos.includes('#2'), '两个子会话分别显示 #1 / #2')
    const origins = qa('[data-testid="rail-branch-origin"]').map((e) => e.textContent.trim())
    log(`  来源行：「${origins[0] ?? '(无)'}」`)
    ok(origins.length >= 2, '子会话行显示了「分叉自哪句话」')
    // 合成家族那两条的来源必须是那句「源问题」（可能还混有真实 fixture 的子会话）
    ok(origins.filter((t) => t.includes('源问题')).length >= 2, '合成家族的来源就是父会话里那句话')

    log('=== 3. 分叉树：默认折叠，开关在标题旁 ===')
    const toggle = q('[data-testid="rail-branch-toggle"]')
    ok(!!toggle, '父会话行有分叉开关')
    ok(toggle && toggle.getAttribute('data-open') === '0', '默认是折叠的')
    ok(!q('[data-testid="rail-branch-tree"]'), '折叠时看不到树')

    if (toggle) {
      // 开关是 .srow 的兄弟（不能嵌在行按钮里），且紧挨标题
      ok(toggle.parentElement?.classList.contains('srow-row'), '开关与标题在同一行主体里')
      ok(!!toggle.closest('.srow-wrap')?.querySelector('.srow'), '行主体里还有会话按钮')

      click(toggle)
      await until(() => !!q('[data-testid="rail-branch-tree"]'), 6000)
      const tree = q('[data-testid="rail-branch-tree"]')
      ok(!!tree, '点开关能展开分叉树')
      const items = qa('[data-testid="rail-branch-item"]')
      log(`  树里 ${items.length} 条：${items.map((e) => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ')}`)
      ok(items.length === 2, '树里列出两条分支')
      ok(items.some((e) => /#1/.test(e.textContent)), '树里带分支编号')
      ok(items.every((e) => /源问题/.test(e.textContent)), '树里带「分叉自哪句话」')

      log('=== 4. 点树里的分支 → 切到那个会话 ===')
      click(items[items.length - 1])
      await until(() => String(store.getState().session?.sessionFile ?? '').includes('child'), 20000)
      const cur = String(store.getState().session?.sessionFile ?? '')
      log(`  当前会话文件：…${cur.slice(-34)}`)
      ok(cur.includes('child'), '点树里的分支能切过去')
    }

    log('=== 5. 进入会话不会把它置顶（按创建时间新→旧） ===')
    // 用 path（title 属性）比，不用会话名（名字可能被标题生成改掉）
    const paths = () => qa('.rail .srow').map((e) => e.getAttribute('title') || '')
    const before = paths()
    // 专门挑靠后的一行 —— 如果它被置顶，顺序一定会变
    const rows = qa('.srow')
    const other = rows[Math.max(1, rows.length - 2)]
    if (other) {
      click(other)
      await sleep(1800)
      const after = paths()
      const common = before.filter((p) => after.includes(p))
      const afterCommon = after.filter((p) => before.includes(p))
      const same = JSON.stringify(common) === JSON.stringify(afterCommon)
      log(`  切换后公共行顺序一致：${same}（${common.length} 行）`)
      ok(same, '切换会话后列表顺序不变（不再按 mtime 置顶）')
      ok(after[0] !== other.getAttribute('title') || before[0] === other.getAttribute('title'), '刚切过去的会话没有被置顶')
    }

    log('=== 6. 选中行的时间不与动作按钮重叠 ===')
    const sel = q('.srow-wrap.has-acts') ?? q('.srow-wrap.sel')
    ok(!!sel, '有选中的会话行')
    if (sel) {
      const rule = findRule(/\.srow-wrap:hover\s+\.srow-time/)
      ok(!!rule && /opacity\s*:\s*0/.test(rule.style?.cssText ?? rule.cssText ?? ''), '悬停时时间让位（不叠在动作按钮上）')
    }

    log('=== 7. 「新对话」与「删除会话」按钮真的能用 ===')
    window.confirm = () => true

    // 新对话：点左栏顶部的按钮，应该不报错、并换到一个新会话
    const beforePath = String(store.getState().session?.sessionFile ?? '')
    const err0 = store.getState().notices.filter((n) => n.kind === 'error').length
    click(q('[data-testid="rail-new"]'))
    await sleep(3000)
    const errs = store.getState().notices.filter((n) => n.kind === 'error')
    ok(errs.length <= err0, '点「新对话」没有报错')
    const afterPath = String(store.getState().session?.sessionFile ?? '')
    log(`  会话文件：…${beforePath.slice(-20)} → …${afterPath.slice(-20)}`)
    ok(!!afterPath, '新对话后仍有一个当前会话')

    // 删除：非选中行也要能开 ⋯ 菜单（以前只在选中行渲染 → 而删除又对选中行禁用 → 永远删不了）
    const cur = String(store.getState().session?.sessionFile ?? '')
    const rows2 = qa('.srow')
    const victim = rows2.find((r) => {
      const p = r.getAttribute('title')
      return p && p !== cur && !r.classList.contains('sel') && !/FAMILY/.test(r.textContent)
    })
    ok(!!victim, '找到一条可删的非当前会话')
    if (victim) {
      const path = victim.getAttribute('title')
      const actsBtn = victim.closest('.srow-wrap')?.querySelector('.srow-acts button')
      ok(!!actsBtn, '非选中行也有 ⋯ 按钮（不需要先选中）')
      if (actsBtn) {
        click(actsBtn)
        await until(() => !!q('.srow-menu'), 4000)
        const del = q('.srow-menu .srow-menu-btn.danger')
        ok(!!del && !del.disabled, '删除按钮可用（不是 disabled）')
        if (del && !del.disabled) {
          click(del)
          await sleep(1800)
          ok(!store.getState().sessions.some((s) => s.path === path), '删除后会话从列表消失')
        }
      }
    }

    return out.join('\n')
  } catch (e) {
    return out.concat(`  ✗ 抛异常：${e && e.message}`).join('\n')
  }
})()
