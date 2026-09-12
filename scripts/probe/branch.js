/*
 * 会话分支（左栏）——用户要求：
 *   · 会话栏**不要**那个「分支」按钮（分支只在对话窗口里做）
 *   · 会话栏显示：分支数、分支会话及其编号、分叉自哪句话、能点进那段对话
 *
 * 数据来源是 pi 的 `session` 头里的 `parentSession`（分叉自哪个会话文件），
 * 不是会话内的 get_tree —— 这轮把 get_tree 那条链路（分支树）整个删掉了。
 *
 * fixture 用**合成的**分支家族（父 + 两个子，见 test-live 的 writeBranchFamily），
 * 不依赖真实会话里恰好有分叉。
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

  /** 样式表里找一条规则（`:hover` 类断言只能这么验，见 HANDOFF §8） */
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

    // 展开所有项目分组（分支家族在 homedir 那个项目下）
    for (const h of qa('.proj-head')) if (h.classList.contains('collapsed')) click(h)
    await sleep(600)

    log('=== 1. 会话栏不再有「分支」按钮 ===')
    ok(!q('[data-testid="rail-branches"]'), '没有分支按钮了（分支只在对话窗口里做）')
    ok(!q('.srow-branches'), '会话行下方不再挂会话内分支树')

    log('=== 2. 分支数 / 编号 / 来源 ===')
    const count = q('[data-testid="rail-branch-count"]')
    ok(!!count, '父会话行显示了分支数')
    log(`  分支数徽标：「${count?.textContent ?? '(无)'}」`)
    ok(!!count && String(count.textContent).includes('2'), '分支数 = 2（合成家族有两个子会话）')

    const nos = qa('[data-testid="rail-branch-no"]').map((e) => e.textContent.trim())
    log(`  分支编号：${JSON.stringify(nos)}`)
    ok(nos.includes('#1') && nos.includes('#2'), '两个子会话分别显示 #1 / #2')

    const origins = qa('[data-testid="rail-branch-origin"]').map((e) => e.textContent.trim())
    log(`  来源行：「${origins[0] ?? '(无)'}」`)
    ok(origins.length >= 2, '子会话显示了「分叉自哪句话」')
    ok(origins.every((t) => t.includes('源问题')), '来源就是父会话里那句话')

    log('=== 3. 点分支会话能切过去（链接到那段对话）===')
    const childRow = qa('.srow').find((r) => r.querySelector('[data-testid="rail-branch-no"]'))
    ok(!!childRow, '找得到一条分支会话行')
    if (childRow) {
      click(childRow)
      await until(
        () => String(store.getState().session?.sessionFile ?? '').includes('child'),
        20000
      )
      const cur = String(store.getState().session?.sessionFile ?? '')
      log(`  当前会话文件：…${cur.slice(-34)}`)
      ok(cur.includes('child'), '点分支会话行真的切到了那个分支会话')
    }

    log('=== 4. 选中行的「时间」不与动作按钮重叠（上一轮报的 UI bug）===')
    const sel = q('.srow-wrap.has-acts') ?? q('.srow-wrap.sel')
    ok(!!sel, '有选中的会话行')
    if (sel) {
      ok(!!sel.querySelector('.srow-acts'), '选中行有动作按钮')
      /*
       * 时间与动作按钮都落在行右缘，靠 `:hover` 切换显隐；
       * 而 DOM 断言测不了 :hover（见 HANDOFF §8），
       * 所以验证「规则存在」：带动作的行悬停时把时间藏起来。
       */
      const rule = findRule(/\.srow-wrap\.has-acts:hover\s+\.srow-time/)
      ok(!!rule, '有规则：带动作按钮的行悬停时隐藏相对时间')
      ok(!!rule && /opacity\s*:\s*0/.test(rule.style?.cssText ?? rule.cssText ?? ''), '该规则确实把 opacity 设为 0')
    }

    return out.join('\n')
  } catch (e) {
    return out.concat(`  ✗ 抛异常：${e && e.message}`).join('\n')
  }
})()
