/**
 * 会话：左栏列出、切换（内容先铺 / pi 后切）、新建。
 *
 * ── 本轮重写（为什么以前是错的）──
 *  ① 左栏**不再「鼠标靠近边缘就展开」**（那个行为已按用户要求删除，见
 *     App.tsx 里 `railOpen` 上方的注释）。旧代码发一个 `mousemove` 就当作
 *     展开了，功能删掉后它其实**永远等不到**；而收起状态下 Rail 只渲染
 *     `.rail-compact`、不渲染会话行，于是 `items.length < 2` → 探针以
 *     「会话太少，无法测试切换」**假通过**（没有 ✗）。现在显式
 *     `setRailPinned(true)`，并把「展开成功」变成真断言。
 *  ② `.continuity`（连续性带）与 `.tb-sync` 这两个节点已随界面改版移除。
 *     旧代码对它们只有 `log(...)`（不带 ✗），所以断言失效也没人发现 ——
 *     这正是「假通过」的另一种形态。连接状态现在直接读 store 的真实字段。
 *  ③ 切换会话是**两段式**（见 store 的 `switchSession`）：先 `peekSession`
 *     读文件立刻铺内容，再让 pi 切过去。隔离测试环境里 pi 连不上：内容仍然
 *     应该出现（那是 peek 的功劳），而「选中态」要等 pi 回来的会话状态 ——
 *     所以前者断言、后者在 pi 未就绪时**显式跳过**（不报 ✗，否则环境问题
 *     会被读成代码回归）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  /** 显式跳过：环境不满足（不是失败），与 slashcmd.js 的写法一致 */
  const skip = (s) => out.push('  ⤺ 跳过：' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /** 轮询等条件成立（固定 sleep 在负载高时会不够） */
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120) }
    return fn()
  }

  const store = window.__yanStore
  if (!store) {
    out.push('  ✗ 拿不到 window.__yanStore')
    return out.join('\n')
  }

  /** 会话行对应的路径（`.srow-wrap` 上有 data-session-path，比解析 title 稳） */
  const pathOf = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') ?? ''

  try {
    out.push('=== 0. 左栏 ===')
    /* 显式展开：不再依赖「悬停」。收起时只渲染 .rail-compact，列表是空的 */
    store.getState().setRailPinned(true)
    const opened = await until(() => !!q('.app') && !q('.app').classList.contains('rail-off'))
    ok(opened, '显式展开后左栏可见（.rail-off 已移除）')

    const items = qa('.rail .srow')
    out.push('  会话行数: ' + items.length)
    if (!ok(items.length >= 2, '左栏列出了会话（' + items.length + ' 行，至少 2 行才能测切换）')) {
      return out.join('\n')
    }

    out.push('')
    out.push('=== 1. 切换会话 ===')
    /* 挑一条不是路径名、且有内容的会话（避免切到空会话） */
    const target = items.find((i) => {
      const n = i.querySelector('.srow-name')?.textContent ?? ''
      return !n.startsWith('~') && n.length > 4
    }) ?? items[1]

    const targetName = target.querySelector('.srow-name')?.textContent ?? ''
    const targetPath = pathOf(target)
    out.push('  切到: ' + JSON.stringify(targetName) + '  path=' + targetPath)

    const conn0 = store.getState().conn
    click(target)

    /*
     * 内容：peekSession 读文件 → 立刻铺上，**不需要 pi**。
     * 这是切换「感觉是瞬时的」那一半，必须有。
     */
    const loaded = await until(() => qa('.msg').length > 0, 8000)
    const msgsNow = qa('.msg').length
    ok(loaded, '切换后铺上了消息（peekSession 读文件，不等 pi）—— ' + msgsNow + ' 条')
    out.push('  用户 ' + qa('.msg.user').length + ' 条 / 助手 ' + qa('.msg.assistant').length + ' 条')

    /*
     * 选中态：`selected` 来自 `session.sessionFile`，而 `session` 由 pi 推的
     * sync / refreshSessions 更新 —— 隔离环境里 pi 起不来，它不会变。
     * 标题还可能被模型重写，所以按 **path** 比对，不按显示名。
     */
    if (conn0 === 'ready') {
      const selOk = await until(() => {
        const sel = q('.rail .srow.sel')
        return !!sel && pathOf(sel) === targetPath
      }, 8000)
      const selNow = pathOf(q('.rail .srow.sel'))
      ok(selOk, '选中态切到目标会话（实际：' + (selNow || '无选中行') + '）')
    } else {
      skip(`pi 未就绪（conn=${conn0}），「选中态」要等 pi 回来的会话状态，无法判定`)
    }

    out.push('')
    out.push('=== 2. 新建会话 ===')
    const newBtn = q('[data-testid="rail-new"]')
    ok(!!newBtn, '有「新对话」按钮')

    if (conn0 !== 'ready') {
      skip(`pi 未就绪，新建要走 pi（window.yan.newSession），无法判定`)
    } else if (newBtn) {
      click(newBtn)
      const cleared = await until(() => qa('.msg').length === 0, 8000)
      ok(cleared, '新建后消息清空（现在 ' + qa('.msg').length + ' 条）')
      ok(!!q('.empty-stream'), '空状态显示（.empty-stream）')
    }

    out.push('')
    out.push('=== 3. 连接状态 ===')
    /*
     * 只报告、不断言：隔离测试环境里 pi 本来就起不来（conn 可能是 exited），
     * 那是环境属性而非回归。真要看连接有没有坏，跑 live 场景的 .connbar。
     */
    const conn = store.getState().conn
    out.push('  conn = ' + conn + '（输入框可用: ' + (!q('[data-testid="composer"]')?.disabled) + '）')
  } catch (e) {
    out.push('  ✗ 抛异常：' + (e && e.message ? e.message : String(e)))
  }

  return out.join('\n')
})()
