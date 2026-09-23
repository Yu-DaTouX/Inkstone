/**
 * 交互终端表面的界面回归网（实施-11 H-11）。
 *
 * 打包态那一段（`scripts/probe/packaged.js`）证的是「原生依赖在 asarUnpack 后
 * 真的能起 PTY」；这一支证的是**工作窗口接线**：
 *   · 开始页有终端入口，且真的能开出一个会话（不是灰按钮）；
 *   · 终端页渲染出 xterm 的 DOM（`.xterm`），有标题栏与活动标签；
 *   · 从宿主写入的命令真的显示在 xterm 的行里（DOM 渲染器，可读）；
 *   · 标签关闭 = 真的 kill PTY（宿主列表里也没了），不是只把页面藏起来；
 *   · 重开面板能按会话 id 接回同一个会话（断线重连）。
 *
 * 不花 token：不发模型请求，只走宿主 PTY 与右栏 DOM。
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
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const button = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(500)
  store.getState().closeSettings?.()
  await sleep(200)

  const availability = await window.yan.terminal.available()
  ok(availability?.available === true, `宿主 PTY 可用（${JSON.stringify(availability)}）`)
  if (!availability?.available) return out.join('\n')

  if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
  await sleep(300)

  /* ① 开始页入口：切到开始页，点终端 */
  click(q('[data-testid="right-window-tab-start"]'))
  await sleep(400)
  const startEntry = q('[data-testid="start-terminal"]')
  ok(!!startEntry, '开始页有终端入口（不是灰按钮）')
  click(startEntry)
  ok(await until(() => !!q('[data-testid="terminal-surface"]')), '点击后渲染出终端表面')
  ok(await until(() => !!q('[data-testid="terminal-host"] .xterm')), 'xterm 真的挂载了（.xterm 在 DOM 里）')

  /* ② 活动会话与标签 */
  let activeId = store.getState().activeTerminalId
  ok(!!activeId, `宿主开出了会话（${activeId}）`)
  const tab = qa('[data-testid="right-window-tab-terminal"]').find((el) => el.dataset.terminalId === activeId)
  ok(!!tab, '工作窗口里出现该会话的标签（带会话身份）')
  const info = store.getState().terminals.find((t) => t.id === activeId)
  ok(!!info?.cwd && info.cwd.length > 0, `会话工作目录正确（${info?.cwd}）`)
  ok(info?.alive === true, '会话在运行')

  /* ③ 真实输入 / 输出：写一条命令，读 xterm 的行 */
  const token = 'YAN_TERM_UI_OK'
  await window.yan.terminal.write(activeId, `echo ${token}\r\n`)
  const seen = await until(() => (q('.xterm-rows')?.textContent ?? '').includes(token), 8000)
  ok(seen, '命令真的执行、输出进了 xterm 的行（界面路径，不只是主进程缓冲）')

  /* ④ 尺寸：resize 之后宿主快照跟着变 */
  const snapBefore = await window.yan.terminal.attach(activeId)
  await window.yan.terminal.resize(activeId, 100, 30)
  const snapAfter = await window.yan.terminal.attach(activeId)
  ok(snapAfter?.cols === 100 && snapAfter?.rows === 30, `resize 真的落到宿主（${snapBefore?.cols}x${snapBefore?.rows} → ${snapAfter?.cols}x${snapAfter?.rows}）`)

  /* ⑤ 断线重连：切走再切回，同一会话拿回它的输出 */
  click(q('[data-testid="right-window-tab-tools"]'))
  await sleep(500)
  const tabBack = qa('[data-testid="right-window-tab-terminal"]').find((el) => el.dataset.terminalId === activeId)
  click(tabBack)
  ok(await until(() => !!q('.xterm-rows')), '切回终端标签后表面重新渲染')
  ok(
    await until(() => (q('.xterm-rows')?.textContent ?? '').includes(token), 8000),
    '重连后仍能看到之前的输出（缓冲回放，不是空壳）'
  )
  ok(store.getState().activeTerminalId === activeId, '重连回到同一个会话（身份不变）')

  /* ⑥ 关闭标签 = kill PTY */
  const closeBtn = qa('[data-testid="right-window-tab-terminal"]')
    .find((el) => el.dataset.terminalId === activeId)
    ?.querySelector('.review-tab-close')
  click(closeBtn)
  await sleep(600)
  const listed = (await window.yan.terminal.list()).some((t) => t.id === activeId)
  ok(!listed, '关掉标签后宿主列表里也没有它了（真的 kill，不是只隐藏）')
  ok(store.getState().terminals.every((t) => t.id !== activeId), '界面列表同步移除')

  return out.join('\n')
})()
