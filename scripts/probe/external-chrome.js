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

  /* ---- 4. 断开 ---- */
  out.push('')
  out.push('=== 4. 断开 ===')
  await store.getState().closeExternalChrome()
  ok(await until(() => st().mode !== 'external'), '断开后不再处于 external 模式')
  ok(!st().open, '断开后浏览器面板回到关闭状态')

  return out.join('\n')
})()
