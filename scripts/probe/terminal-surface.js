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

  click(q('[data-testid="right-window-tab-start"]'))
  await sleep(400)
  const toolMenu = q('[data-testid="right-tool-menu"]')
  ok(!!toolMenu, '工作窗口显示工具菜单入口')
  click(toolMenu)
  const menuOpened = await until(() =>
    !!q('[data-testid="right-tool-menu-popover"]')
  )
  ok(menuOpened, '打开工作区工具菜单')
  if (!menuOpened) return out.join('\n')
  const terminalOption = qa('[data-testid="right-tool-menu-popover"] .rp-tool-menu-item')
    .find((el) => /终端|terminal/i.test(el.textContent ?? ''))
  ok(!!terminalOption, '工具菜单列出终端入口')
  if (!terminalOption) return out.join('\n')
  click(terminalOption)
  ok(await until(() => !!q('[data-testid="terminal-surface"]')), '点击后渲染出终端表面')
  ok(await until(() => !!q('[data-testid="terminal-host"] .xterm')), 'xterm 真的挂载了（.xterm 在 DOM 里）')

  let activeId = store.getState().activeTerminalId
  ok(!!activeId, `宿主开出了会话（${activeId}）`)
  const tab = q('[data-pane-tab="terminal:' + activeId + '"]')
  ok(!!tab, '工作窗口里出现该会话的标签（带会话身份）')
  const info = store.getState().terminals.find((t) => t.id === activeId)
  ok(!!info?.cwd && info.cwd.length > 0, `会话工作目录正确（${info?.cwd}）`)
  ok(info?.alive === true, '会话在运行')

  const token = 'YAN_TERM_UI_OK'
  await window.yan.terminal.write(activeId, `echo ${token}\r\n`)
  const renderedText = () => (q('.xterm-accessibility-tree') ?? q('.xterm-rows'))?.textContent ?? ''
  const seen = await until(() => renderedText().includes(token), 8000)
  ok(seen, '命令真的执行、输出进了 xterm 的行（界面路径，不只是主进程缓冲）')

  const snapBefore = await window.yan.terminal.attach(activeId)
  await window.yan.terminal.resize(activeId, 100, 30)
  const snapAfter = await window.yan.terminal.attach(activeId)
  ok(snapAfter?.cols === 100 && snapAfter?.rows === 30, `resize 真的落到宿主（${snapBefore?.cols}x${snapBefore?.rows} → ${snapAfter?.cols}x${snapAfter?.rows}）`)

  const termTab = q('[data-pane-tab="terminal:' + activeId + '"]')
  termTab?.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 12 })
  )
  await until(() => !!q('.tile-layout-menu'))
  const hideItem = qa('.tile-layout-menu [role="menuitem"]').find((el) => el.textContent.trim() === '隐藏面板')
  ok(!!hideItem, '磁贴右键菜单有「隐藏面板」')
  hideItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await sleep(500)
  ok(!q('[data-workspace-pane="terminal:' + activeId + '"]:not([hidden])'), '隐藏终端磁贴（保留会话）')
  ok((await window.yan.terminal.list()).some((t) => t.id === activeId), '隐藏磁贴没有 kill 会话（资源仍在）')
  await window.__yanOpenWorkspaceTool('终端', 'terminal:' + activeId)
  const tabBack = q('[data-pane-tab="terminal:' + activeId + '"] button[role="tab"]')
  click(tabBack)
  ok(await until(() => !!q('.xterm-accessibility-tree, .xterm-rows')), '切回终端标签后表面重新渲染')
  ok(
    await until(() => renderedText().includes(token), 8000),
    '重连后仍能看到之前的输出（缓冲回放，不是空壳）'
  )
  ok(store.getState().activeTerminalId === activeId, '重连回到同一个会话（身份不变）')

  const closeBtn = q('[data-pane-tab="terminal:' + activeId + '"] .ui-tab-close')
  click(closeBtn)
  await sleep(600)
  const listed = (await window.yan.terminal.list()).some((t) => t.id === activeId)
  ok(!listed, '关掉标签后宿主列表里也没有它了（真的 kill，不是只隐藏）')
  ok(store.getState().terminals.every((t) => t.id !== activeId), '界面列表同步移除')

  return out.join('\n')
})()
