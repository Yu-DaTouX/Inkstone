;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  log('=== 记忆搬进设置 ===')

  /* 1. 右栏应该没了 */
  ok(!q('.status'), '右栏（.status）已移除')
  ok(!q('.status-panel'), '没有残留的右栏容器')

  /* 2. 消息流变宽了 */
  const center = q('.center')
  const cw = Math.round(center?.getBoundingClientRect().width ?? 0)
  log('  中间栏宽度: ' + cw)
  ok(cw > 1100, `中间栏变宽（${cw}px，撤掉 328px 右栏后）`)

  /* 3. 设置按钮存在，点了能开 */
  const btns = qa('.tb-right .btn.icon')
  log('  标题栏右侧图标按钮数: ' + btns.length)
  const setBtn = btns.find((b) => b.title && /设置|Settings/.test(b.title))
  ok(!!setBtn, '标题栏有「设置」按钮')
  if (!setBtn) return out.join('\n')

  click(setBtn)
  await sleep(400)
  ok(!!q('.settings'), '点开后出现设置面板')
  ok(store.getState().settingsOpen, 'store.settingsOpen = true')

  /* 4. 四个 tab */
  const tabs = qa('.settings-tab').map((x) => x.textContent)
  log('  tab: ' + JSON.stringify(tabs))
  ok(tabs.length >= 4, `有 ${tabs.length} 个 tab（含关闭）`)

  /* 5. 记忆 tab 里六个分区都在 */
  const memTab = qa('.settings-tab').find((x) => /记忆|Memory/.test(x.textContent))
  click(memTab)
  await sleep(400)
  const secs = qa('.mem-sections .sect').map((s) => s.dataset.sec)
  log('  记忆分区: ' + JSON.stringify(secs))
  ok(secs.length === 6, `六个分区都在（${secs.length}）`)
  for (const need of ['soul', 'about', 'impressions', 'people', 'projects', 'status']) {
    ok(secs.includes(need), `有 ${need}`)
  }

  /* 6. 切换 tab */
  for (const name of ['外观', '状态', '关于']) {
    const tb = qa('.settings-tab').find((x) => x.textContent.includes(name))
    if (!tb) { out.push('  ✗ 找不到 tab ' + name); continue }
    click(tb)
    await sleep(300)
    const rows = qa('.settings-body .set-row').length
    ok(rows > 0, `${name} tab 有 ${rows} 个设置项`)
  }

  /* 7. Esc 关闭 */
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(300)
  ok(!q('.settings'), 'Esc 能关闭')
  ok(!store.getState().settingsOpen, 'store.settingsOpen = false')

  /* 8. 输入区的紧凑状态条 */
  log('')
  log('=== 输入区状态条 ===')
  const ctx = q('.ctxbar')
  ok(!!ctx, '有 .ctxbar')
  if (ctx) {
    log('  内容: ' + JSON.stringify(ctx.textContent.replace(/\s+/g, ' ').trim()))
    const modelBtn = ctx.querySelector('.ctxbar-model')
    ok(!!modelBtn && (modelBtn.textContent ?? '').length > 0, '显示模型名')
    ok(!!ctx.querySelector('.ctxbar-meter'), '有上下文进度条')
    // 点模型名应该打开设置的「状态」tab
    click(modelBtn)
    await sleep(400)
    ok(store.getState().settingsOpen, '点模型名能打开设置')
    ok(store.getState().settingsTab === 'status', `定位到状态 tab（${store.getState().settingsTab}）`)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(300)
  }

  /* 9. 溢出回归 */
  log('')
  log('=== 溢出 ===')
  for (const sel of ['.rail', '.rail-body', '.app', '.settings-body']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    ok(over <= 0, `${sel} 无横向溢出（差 ${over}）`)
  }

  return out.join('\n')
})()
