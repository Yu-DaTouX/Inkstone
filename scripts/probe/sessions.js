;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const skip = (s) => out.push('  ⤺ 跳过：' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

  const pathOf = (el) => el?.closest('.srow-wrap')?.getAttribute('data-session-path') ?? ''

  const t0 = Date.now()
  try {
    out.push('=== 0. 左栏 ===')
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
    const target = items.find((i) => {
      const n = i.querySelector('.srow-name')?.textContent ?? ''
      return !n.startsWith('~') && n.length > 4
    }) ?? items[1]

    const targetName = target.querySelector('.srow-name')?.textContent ?? ''
    const targetPath = pathOf(target)
    out.push('  切到: ' + JSON.stringify(targetName) + '  path=' + targetPath)

    const conn0 = store.getState().conn
    click(target)

    const loaded = await until(() => qa('.msg').length > 0, 8000)
    const msgsNow = qa('.msg').length
    ok(loaded, '切换后铺上了消息（peekSession 读文件，不等 pi）—— ' + msgsNow + ' 条')
    out.push('  用户 ' + qa('.msg.user').length + ' 条 / 助手 ' + qa('.msg.assistant').length + ' 条')

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

  const diag = []
  const unsub = store.subscribe((s, prev) => {
    if (s.messages !== prev.messages) {
      diag.push(`t+${Date.now() - t0} messages=${s.messages.length} peeked=${s.peekedPath ? 'yes' : 'no'} stream=${s.session?.isStreaming ? 'on' : 'off'}`)
    }
  })
  await sleep(9000)
  unsub()
  out.push('  [诊断] 切换后 9s 内 messages 变化：')
  for (const line of diag.slice(0, 20)) out.push('    ' + line)
  out.push('  [诊断] 结束时 .msg 节点数 = ' + qa('.msg').length + '，messages 长度 = ' + store.getState().messages.length)

    out.push('')
    out.push('=== 2. 新建会话 ===')
    const newBtn = q('[data-testid="rail-new"]')
    ok(!!newBtn, '有「新对话」按钮')

    if (conn0 !== 'ready') {
      skip(`pi 未就绪，新建要走 pi（window.yan.newSession），无法判定`)
    } else if (newBtn) {
      click(newBtn)
      const cleared = await until(() => store.getState().messages.length === 0, 8000)
      ok(cleared, '新建后会话消息清空（messages = ' + store.getState().messages.length + '）')
      const opening = await until(() => !!q('.empty-stream') || !!q('.wb-home'), 5000)
      ok(opening, '新建后显示开场（对话空态或工作台首页）')
    }

    out.push('')
    out.push('=== 3. 连接状态 ===')
    const conn = store.getState().conn
    out.push('  conn = ' + conn + '（输入框可用: ' + (!q('[data-testid="composer"]')?.disabled) + '）')
  } catch (e) {
    out.push('  ✗ 抛异常：' + (e && e.message ? e.message : String(e)))
  }

  return out.join('\n')
})()
