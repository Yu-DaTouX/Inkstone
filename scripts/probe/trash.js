/**
 * 删除会话的确认框：标题、按钮样式、不换行、Esc 不误删（方案 15）。
 *
 * 为什么只测确认框、不跑真删除：真实删除会动用户的会话文件。
 * 成功后的「轻量通知 + 撤销」需要真实删除才能看到，留给真实窗口验收
 * （后端删除/恢复本身由 test-unit 覆盖）。
 *
 * 这里钉住的是**回归点**：曾经「撤销删除」借用 `.send`（输入框发送按钮的
 * 圆形专用样式），四个中文字被挤进圆里换行；标题还停留在「删除这个会话」。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && (store?.getState().sessions?.length ?? 0) > 0) break
      await sleep(250)
    }
    await sleep(800)

    const before = store.getState().sessions.length
    out.push(`  会话数（删除前）= ${before}`)

    /* 当前会话禁止删除，挑一条未选中的 */
    const row = qa('.srow-wrap').find((w) => w.querySelector('.srow') && !w.querySelector('.srow.sel'))
    ok(!!row, '找到一条非当前会话（当前会话禁止删除）')
    if (!row) return out.join('\n')

    click(row.querySelector('.srow-acts button'))
    await sleep(200)
    const danger = row.querySelector('.srow-menu-btn.danger:not([disabled])')
    ok(!!danger, '右键菜单里的「删除」可用（不是 disabled）')
    if (!danger) return out.join('\n')

    click(danger)
    await sleep(400)

    const dlg = q('.rail-delete-dialog')
    ok(!!dlg, '打开了删除确认框')
    if (!dlg) return out.join('\n')

    const title = dlg.querySelector('.modal-title')?.textContent ?? ''
    out.push(`  标题 = ${JSON.stringify(title)}`)
    ok(/回收站|trash/i.test(title), '标题改成「将会话移入回收站？」（与状态匹配，不是旧的「删除这个会话」）')

    const msg = dlg.querySelector('.modal-message')?.textContent ?? ''
    ok(/回收站|trash/i.test(msg), '正文说明会话会移到回收站')
    ok(/撤销|undone/i.test(msg), '正文说明本次运行内可撤销')

    const btns = qa('.rail-delete-dialog .modal-foot .btn')
    out.push(`  底部按钮 = ${btns.map((b) => JSON.stringify((b.textContent || '').trim())).join(' / ')}`)
    const confirm = dlg.querySelector('.modal-foot .btn.danger')
    ok(!!confirm, '有危险样式的确认按钮')
    if (confirm) {
      ok(!confirm.classList.contains('send'), '确认按钮不再借用 .send（圆形发送按钮样式）')
      const h = confirm.getBoundingClientRect().height
      out.push(`  确认按钮高度 = ${h.toFixed(1)}px，scrollWidth=${confirm.scrollWidth} clientWidth=${confirm.clientWidth}`)
      ok(h >= 28 && h <= 34, `按钮高度在 28–34px（推荐 30–32）`)
      ok(confirm.scrollWidth <= confirm.clientWidth + 1, '按钮文字完整：没有因为固定圆形尺寸被裁/换行')
      ok(getComputedStyle(confirm).whiteSpace !== 'normal' || confirm.scrollWidth <= confirm.clientWidth + 1, '文字不换行')
    }

    /* Esc 关闭，且**不能**发生删除 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
    ok(!q('.rail-delete-dialog'), 'Esc 能关掉确认框')
    ok(store.getState().sessions.length === before, '只是打开又关闭，没有真的删除任何会话')

    /* ================================================================
     * N15：删除成功后的轻量通知条
     *
     * 这里有**真实删除**（默认跑在隔离的 YAN_SESSIONS_DIR 临时目录里，
     * 删除的也是从真实会话只读拷贝出来的 fixture）。每个用例要么撤销、
     * 要么接受的永久移除只发生在临时目录。
     * ⚠️ YAN_TEST_ISOLATED=0 调试时会真的动当前会话目录，不要在这种模式下跑。
     * ================================================================ */
    out.push('')
    out.push('=== N15：删除成功 → 通知条（30 秒计时 / 窄栏 / 撤销）===')

    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const freeRows = () => qa('.srow-wrap').filter((w) => w.querySelector('.srow') && !w.querySelector('.srow.sel'))
    /** 真删一条非当前会话；返回通知条元素（失败返回 null） */
    const deleteOne = async () => {
      const target = freeRows()[0]
      if (!target) return null
      click(target.querySelector('.srow-acts button'))
      await sleep(250)
      const danger = target.querySelector('.srow-menu-btn.danger:not([disabled])')
      if (!danger) return null
      click(danger)
      await sleep(450)
      const d = q('.rail-delete-dialog')
      if (!d) return null
      const input = d.querySelector('.modal-input')
      setValue(input, input.placeholder)
      await sleep(200)
      const confirm = d.querySelector('.modal-foot .btn.danger')
      if (!confirm || confirm.disabled) return null
      click(confirm)
      for (let i = 0; i < 40; i++) {
        if (q('[data-testid="trash-notice"]')) break
        await sleep(150)
      }
      return q('[data-testid="trash-notice"]')
    }

    const countBefore = store.getState().sessions.length
    const notice = await deleteOne()
    ok(!!notice, '删除成功后出现轻量通知条')
    if (!notice) {
      out.push('  （隔离目录里没有可删的非当前会话 —— 只跑了确认框部分）')
      return out.join('\n')
    }

    ok(notice.getAttribute('role') === 'status', '通知条用 role=status（不抢焦点、可播报）')
    ok(!q('.rail-delete-dialog'), '删除成功后确认框自动关闭（不再弹第二个模态框）')
    ok(
      store.getState().sessions.length === countBefore - 1,
      `会话数 ${countBefore} → ${store.getState().sessions.length}`
    )
    ok(!!notice.querySelector('[data-testid="trash-undo"]'), '通知条上有撤销入口')
    out.push('  文案 = ' + JSON.stringify((notice.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)))

    /*
     * 30 秒计时：等到 3.2 秒仍然在。旧实现里「删除成功」根本没有计时
     *（只有恢复成功后 2.6 秒收走），所以这条同时钉住「不要立刻消失」。
     * 不在这里等满 30 秒：那是交互体验数字，靠源码常量 + 手工确认。
     */
    await sleep(3200)
    ok(!!q('[data-testid="trash-notice"]'), '3.2 秒后通知仍在（不是 2.6 秒就收走）')

    /* 窄栏：文案最多两行、按钮不被挤成竖条 */
    await store.getState().setPanelWidth({ railWidth: 210 })
    await sleep(450)
    const n2 = q('[data-testid="trash-notice"]')
    const railBox = q('.rail')?.getBoundingClientRect()
    const noticeBox = n2?.getBoundingClientRect()
    const undoBtn = q('[data-testid="trash-undo"]')
    const btnBox = undoBtn?.getBoundingClientRect()
    const fs = n2 ? parseFloat(getComputedStyle(n2).fontSize) : 12
    out.push(`  左栏 ${railBox?.width.toFixed(0)}px / 通知高 ${noticeBox?.height.toFixed(1)}px / 字号 ${fs.toFixed(1)}`)
    ok(!!noticeBox && !!railBox && noticeBox.width <= railBox.width, '通知条不超出左栏宽度')
    ok(
      !!noticeBox && noticeBox.height <= fs * 1.4 * 2 + 24,
      `高度不超过两行 + 内边距（实际 ${noticeBox?.height.toFixed(1)}px）`
    )
    ok(!!btnBox && btnBox.width >= btnBox.height, '撤销按钮是横条，没被挤成细长竖条')
    ok(!!undoBtn && undoBtn.scrollWidth <= undoBtn.clientWidth + 1, '撤销按钮文字完整（没被裁）')
    const textBox = n2.querySelector('.rail-trash-text')?.getBoundingClientRect()
    ok(!!textBox && !!btnBox && textBox.right <= btnBox.left + 1, '文案区与按钮不重叠')

    /* 撤销：会话回来 + 提示变「已恢复」 + 2.6 秒后自动收走 */
    if (undoBtn) click(undoBtn)
    for (let i = 0; i < 50; i++) {
      if (store.getState().sessions.length === countBefore) break
      await sleep(200)
    }
    ok(store.getState().sessions.length === countBefore, '撤销后会话数回到删除前')
    const restored = q('[data-testid="trash-notice"]')
    out.push('  撤销后文案 = ' + JSON.stringify((restored?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)))
    ok(!!restored, '撤销后仍显示结果反馈')
    ok(!q('[data-testid="trash-undo"]'), '恢复完成后不再显示撤销按钮')
    await sleep(3000)
    ok(!q('[data-testid="trash-notice"]'), '恢复成功的提示随后自动收走')

    /* 关闭按钮：只关提示，不误触发其它动作 */
    const n3 = await deleteOne()
    if (n3) {
      const closeBtn = n3.querySelector('.btn.icon')
      out.push('  关闭按钮 aria-label = ' + JSON.stringify(closeBtn?.getAttribute('aria-label')))
      ok(!!closeBtn, '通知条有关闭按钮')
      ok(closeBtn?.getAttribute('aria-label')?.length > 0, '关闭按钮有无障碍名称（不是只有一个叉）')
      if (closeBtn) click(closeBtn)
      await sleep(350)
      ok(!q('[data-testid="trash-notice"]'), '点关闭后通知立刻消失')
      ok(!q('.rail-delete-dialog'), '关闭通知不会打开任何对话框')
    }
    /* 把左栏宽度交还给后面的场景 */
    await store.getState().setPanelWidth({ railWidth: 0 })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
