/**
 * 接入本机 Chrome（外部浏览器）。
 *
 * 为什么用无头：测试不该弹出一个真窗口、也不该要求登录。场景通过
 * `YAN_CHROME_HEADLESS=1` 让控制器用 `--headless=new` 启动 Chrome；
 * 这里验证的是**接入链路**（启动 → CDP → observe → 断开 → 状态同步），
 * 与真实登录态无关。
 *
 * 用 `about:blank` 而不是 ChatGPT：不依赖网络，断言的是通道而不是页面内容。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? `  ${extra}` : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const st = () => store.getState().browserState

  // 关掉引导层
  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) click(b)
    await sleep(120)
  }
  if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  await sleep(400)

  /* ---- 1. 先开内置浏览器，露出工具栏 ---- */
  out.push('=== 1. 工具栏入口 ===')
  await store.getState().openBrowser('about:blank')
  await until(() => !!q('[data-testid="browser-surface"]'))
  ok(!!q('[data-testid="browser-surface"]'), '内置浏览器面板已打开')
  const btn = q('[data-testid="browser-external-chrome"]')
  ok(!!btn, '工具栏有「接入本机 Chrome」按钮')

  /* ---- 2. 接入（无头）---- */
  out.push('')
  out.push('=== 2. 接入本机 Chrome ===')
  await store.getState().openExternalChrome('about:blank')
  const connected = await until(() => st().mode === 'external', 25_000)
  ok(connected, '状态切到 external 模式', `mode=${st().mode}`)
  ok(!!st().external?.debuggingPort, '报告了调试端口', String(st().external?.debuggingPort ?? '-'))
  ok(st().external?.url?.startsWith('about:blank') === true, '外部目标 url = about:blank', st().external?.url ?? '-')

  ok(await until(() => !!q('[data-testid="browser-external-note"]')), 'viewport 显示外部 Chrome 说明')
  ok(q('[data-testid="browser-external-chrome"]')?.classList.contains('on') === true, '按钮进入「已接入」态')

  /* ---- 3. 用 pi 工具走同一条 bridge ---- */
  out.push('')
  out.push('=== 3. observe 走外部 Chrome ===')
  const observation = await window.yan.browser.observe()
  ok(typeof observation?.generationId === 'string' && observation.generationId.length > 0, 'observe 返回 generationId')
  ok(observation.url.startsWith('about:blank'), 'observe 的 url 来自外部页面', observation.url)

  /* ---- 3b. 标签列表 / 切换 / 关闭 ---- */
  out.push('')
  out.push('=== 3b. 标签页 ===')
  ok(Array.isArray(st().tabs), '状态里给出 Chrome 标签列表')
  ok(typeof st().canGoBack === 'boolean' && typeof st().canGoForward === 'boolean', '历史状态是布尔值')
  const firstId = st().activeTabId
  const embeddedCount = st().tabs.filter((t) => !t.id.startsWith('chrome:')).length
  await window.yan.browser.newTab('about:blank')
  ok(await until(() => st().tabs.filter((t) => t.id.startsWith('chrome:')).length === 2), '新建后有两个 Chrome 标签', `tabs=${st().tabs?.length}`)
  ok((st().tabs?.length ?? 0) === embeddedCount + 2, '统一列表同时保留内置标签', `tabs=${st().tabs?.length}`)
  // 新建后新标签才是 active，所以 other 是原来那个 Chrome 标签
  const other = st().tabs.find((t) => t.id.startsWith('chrome:') && t.id !== st().activeTabId)
  ok(!!other, '能找出另一个 Chrome 标签')
  if (other) {
    await window.yan.browser.switchTab(other.id)
    ok(await until(() => st().activeTabId === other.id), '切换后 activeTabId 指向该标签')
    await window.yan.browser.closeTab(other.id)
    ok(await until(() => st().tabs.filter((t) => t.id.startsWith('chrome:')).length === 1), '关闭后只剩一个 Chrome 标签', `tabs=${st().tabs?.length}`)
    const current = st().activeTabId
    await window.yan.browser.closeTab(current)
    ok(await until(() => st().mode === 'embedded'), '关闭最后一个 Chrome 标签后回到内置模式', `mode=${st().mode}`)
    ok(
      st().tabs.length === embeddedCount && st().activeTabId && !st().activeTabId.startsWith('chrome:'),
      '关闭外部标签后恢复内置标签',
      `active=${st().activeTabId} first=${firstId}`
    )
  }

  /* ---- 4. 断开 ---- */
  out.push('')
  out.push('=== 4. 断开 ===')
  await store.getState().closeExternalChrome()
  ok(await until(() => st().mode !== 'external'), '断开后不再处于 external 模式')
  ok(st().mode === 'embedded' && st().open, '断开后保留内置浏览器面板', `mode=${st().mode} open=${st().open}`)

  return out.join('\n')
})()
