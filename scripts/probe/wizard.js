;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: +r.x.toFixed(1),
      y: +r.y.toFixed(1),
      w: +r.width.toFixed(1),
      h: +r.height.toFixed(1),
      right: +r.right.toFixed(1),
      bottom: +r.bottom.toFixed(1)
    }
  }
  const next = async () => {
    click(q('[data-testid="wiz-next"]'))
    await sleep(320)
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(700)
    localStorage.setItem('yan.onboarded', '1')

    store.getState().openSettings('about')
    ok(await until(() => q('[data-testid="wiz-reopen"]')), '设置 → 关于 有「配置向导」入口')
    click(q('[data-testid="wiz-reopen"]'))
    ok(await until(() => q('[data-testid="wizard"]')), '点入口打开了向导')
    await sleep(600)

    const steps = [...document.querySelectorAll('.wiz-step')]
    ok(steps.length === 6, `步骤条 6 步（实际 ${steps.length}）`)
    ok(!!q('[data-testid="wiz-panel-welcome"]'), '首屏是欢迎页')
    const card = q('[data-testid="wizard"]')
    const cardBox = box(card)
    out.push(`  窗口 ${window.innerWidth}×${window.innerHeight} · 卡片 ${cardBox?.w.toFixed(0)}×${cardBox?.h.toFixed(0)}`)
    ok(!!cardBox && cardBox.right <= window.innerWidth + 1 && cardBox.bottom <= window.innerHeight + 1, '卡片不溢出窗口')

    await next()
    ok(await until(() => q('[data-testid="wiz-panel-theme"]')), '第 2 步：外观与主题')
    const before = store.getState().settings?.theme ?? 'dark'
    const target = before === 'dark' ? 'light' : 'dark'
    click(q(`[data-testid="wiz-theme-${target}"]`))
    const changed = await until(() => store.getState().settings?.theme === target, 3000)
    ok(changed, `外观步切主题落盘（${before} → ${target}）`)
    const persisted = (await window.yan.getSettings()).theme
    ok(persisted === target, `主题写进了设置文件（实际 ${persisted}）`)
    click(q(`[data-testid="wiz-theme-${before}"]`))
    await until(() => store.getState().settings?.theme === before, 3000)
    ok(!!q('[data-testid="set-background"]'), '外观步复用设置里的背景控件')
    ok(!!q('[data-testid="set-font-ui"]'), '外观步带字体项')
    ok(!!q('[data-testid="set-font-size-body-now"]'), '外观步带字号项')

    await next()
    ok(await until(() => q('[data-testid="wiz-panel-sound"]')), '第 3 步：提醒')
    ok(!!q('[data-testid="set-sound-enabled"]'), '提醒步复用「提示音」开关')
    ok(!!q('[data-testid="set-sound-notify"]'), '提醒步复用「系统通知」开关')

    await next()
    ok(await until(() => q('[data-testid="wiz-panel-auth"]')), '第 4 步：模型接入')
    ok(await until(() => q('[data-testid="auth-recheck"]'), 8000), '接入步复用接入分区（有「重新检测」）')

    await next()
    ok(await until(() => q('[data-testid="wiz-panel-context"]')), '第 5 步：上下文')
    const def = q('[data-testid="wiz-ctx-400000"]')
    ok(!!def, '压缩上限有 400k 档')
    ok(def?.getAttribute('data-on') === '1', '默认选中的是 400k')
    const nowText = (q('[data-testid="wiz-ctx-now"]')?.textContent ?? '').trim()
    out.push(`  当前档说明：${JSON.stringify(nowText)}`)
    click(q('[data-testid="wiz-ctx-300000"]'))
    ok(await until(() => store.getState().settings?.autoCompactTokens === 300000, 3000), '改档位写进设置')
    const ctxPersisted = (await window.yan.getSettings()).autoCompactTokens
    ok(ctxPersisted === 300000, `压缩上限写进了设置文件（实际 ${ctxPersisted}）`)
    click(q('[data-testid="wiz-ctx-400000"]'))
    await until(() => store.getState().settings?.autoCompactTokens === undefined, 3000)

    await next()
    ok(await until(() => q('[data-testid="wiz-panel-done"]')), '第 6 步：功能入口')
    const entries = document.querySelectorAll('.wiz-list li')
    out.push(`  功能入口 ${entries.length} 条`)
    ok(entries.length >= 4, '列出了多个功能入口')
    click(q('[data-testid="wiz-back"]'))
    ok(await until(() => q('[data-testid="wiz-panel-context"]')), '「上一步」能回到上一屏')

    click(q('[data-testid="wiz-step-auth"]'))
    ok(await until(() => q('[data-testid="wiz-panel-auth"]')), '点步骤条能直接跳到「模型接入」')

    const foot = document.querySelector('[data-testid="wizard"] .ob-foot')
    const btns = [...(foot?.querySelectorAll('button') ?? [])]
    const fBox = box(foot)
    ok(btns.length === 2, `底栏两个按钮（实际 ${btns.length}）`)
    ok(btns.every((b) => box(b).right <= fBox.right + 1), '按钮不溢出底栏')
    ok(btns.every((b) => b.scrollWidth <= b.clientWidth + 1), '按钮文字没有被裁')
    ok([...document.querySelectorAll('.wiz-step')].every((s) => s.scrollWidth <= s.clientWidth + 1), '步骤条文字没有被裁')

    click(q('[data-testid="wiz-step-done"]'))
    await until(() => q('[data-testid="wiz-panel-done"]'))
    click(q('[data-testid="wiz-done"]'))
    await sleep(500)
    ok(!q('[data-testid="wizard"]'), '「开始使用」关闭了向导')

    const closeTab = [...document.querySelectorAll('.settings-tab')].find((x) => /关闭|Close/.test(x.textContent || ''))
    if (closeTab) click(closeTab)
    await sleep(300)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
