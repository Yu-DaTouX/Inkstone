/**
 * N21-4 / S1：派生状态（`YAN_DATA_DIR/context-state/<sessionId>.json`）的清理。
 *
 * 这一条 live 场景只做一件事：**通过真实界面删掉一条会话**。
 * 状态文件由 Node 侧（`scripts/test-live.mjs` 的种子步骤）用真实的
 * `context-state-store` 写进隔离目录 —— 探针跑在渲染进程里，
 * 按设计**碰不到** `YAN_DATA_DIR`（AGENTS.md 的边界），所以：
 *
 *   这里：删会话，并把删掉的 sessionId 打印成机器可读的一行；
 *   退出后（`afterExit: 'contextStateCleanup'`）：对文件系统断言
 *   「被删会话的状态没了、别人的还在」。
 *
 * 为什么要单独一条场景而不是塞进 `trash`：`trash` 验的是通知条与撤销，
 * 它最后会把会话恢复回来；而「删除时清派生状态」只发生在真删除那一刻。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (q('.rail') && (store?.getState().sessions?.length ?? 0) > 0) break
      await sleep(250)
    }
    await sleep(800)

    const sessions = store?.getState().sessions ?? []
    out.push(`  会话数 = ${sessions.length}`)
    const byPath = new Map(sessions.map((s) => [s.path, s]))

    /* 全量场景可能在上一条探针里把项目 / 分叉树折叠状态落了盘，先展开项目。 */
    for (const fold of qa('[data-testid="rail-project-fold"]')) {
      if (fold.getAttribute('aria-expanded') === 'false') click(fold)
    }
    await sleep(350)
    /* 当前会话禁止删除；优先选稳定的普通 fixture，避开分叉父会话的级联语义。 */
    const rows = qa('.srow-wrap').filter((w) => w.querySelector('.srow') && !w.querySelector('.srow.sel'))
    const row = rows.find((w) => /yan-plain-fixture|yan-todo-fixture/i.test(w.getAttribute('data-session-path') ?? '')) ?? rows[0]
    if (!ok(!!row, '找到一条非当前会话（当前会话禁止删除）')) return out.join('\n')

    const sessionPath = row.getAttribute('data-session-path') ?? ''
    const target = byPath.get(sessionPath)
    ok(!!target?.id, '从会话行拿到 sessionId（清理是按 sessionId 匹配文件名的）', JSON.stringify(target?.id))

    click(row.querySelector('.srow-acts button'))
    await sleep(250)
    /* 菜单 Portal 到 body（实施-12 U-2），行内查不到，从菜单容器取并核对归属 */
    const sessionMenu = q('[data-testid="rail-session-menu"]')
    ok(
      sessionMenu?.getAttribute('data-session-path') === sessionPath,
      '菜单属于这一行（data-session-path 一致）'
    )
    const danger = sessionMenu?.querySelector('.srow-menu-btn.danger:not([disabled])')
    if (!ok(!!danger, '菜单里的「删除」可用')) return out.join('\n')
    click(danger)
    await sleep(450)

    const dialog = q('.rail-delete-dialog')
    if (!ok(!!dialog, '打开了删除确认框')) return out.join('\n')
    const input = dialog.querySelector('.modal-input')
    /* 确认输入按实现要求填 placeholder（与 trash 场景一致，不绕过确认） */
    const setValue = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setValue(input, input.placeholder)
    await sleep(200)
    const confirm = dialog.querySelector('.modal-foot .btn.danger')
    if (!ok(!!confirm && !confirm.disabled, '确认按钮可用')) return out.join('\n')

    const before = sessions.length
    click(confirm)
    let done = false
    for (let i = 0; i < 60; i++) {
      if ((store.getState().sessions?.length ?? 0) === before - 1) {
        done = true
        break
      }
      await sleep(200)
    }
    ok(done, `删除生效：会话数 ${before} → ${store.getState().sessions?.length ?? '?'}`)
    ok(!!q('[data-testid="trash-notice"]'), '删除成功出现通知条（走的是真实删除链路）')

    /* 给 Node 侧的退出后检查留一行机器可读的结果 */
    out.push(`  ctxstate.deletedSessionId=${target?.id ?? ''}`)
    out.push(`  ctxstate.deletedSessionPath=${sessionPath}`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
