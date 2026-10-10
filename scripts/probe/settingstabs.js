/** 设置导航、独立插件市场、键盘焦点和高级披露。 */
;(async () => {
  const out = []
  const ok = (condition, label) => { out.push((condition ? '  ✓ ' : '  ✗ ') + label); return !!condition }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const click = (element) => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const order = ['auth', 'appearance', 'workspace', 'capabilities', 'market', 'devices', 'about']
  const anchors = {
    auth: ['auth-msg', 'auth-recheck'],
    appearance: ['set-ui-scale', 'set-density', 'theme-dark', 'set-sound', 'set-sound-enabled'],
    workspace: ['set-auto-archive', 'ctx-native-settings'],
    capabilities: ['set-capabilities'],
    market: ['plugin-market', 'market-ours', 'market-hermes-download'],
    devices: ['settings-voice', 'voice-state', 'voice-models', 'settings-remote', 'settings-peer'],
    about: ['pi-redetect', 'about-build']
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const button = [...card.querySelectorAll('button')].find((element) => /开始使用|完成/.test(element.textContent))
      click(button)
      await sleep(120)
    }
    if (!store.getState().settingsOpen) click(q('[data-testid="rail-settings"]'))
    await sleep(400)

    out.push('=== 设置导航 ===')
    ok(qa('.settings').length === 1, '设置面板只有一个实例')
    const tabs = qa('.settings-tabs [role="tab"]')
    ok(tabs.length === order.length, `七页导航（实际 ${tabs.length}）`)
    ok(tabs.map((element) => element.id.replace('settings-tab-', '')).join(',') === order.join(','), '页签顺序与设计规范一致')
    const selected = q('.settings-tabs [role="tab"][aria-selected="true"]')
    ok(!!selected, '只有当前页被选中')
    selected?.focus()
    selected?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await sleep(250)
    ok(q('.settings-tabs [role="tab"][aria-selected="true"]') !== selected, '方向键切到下一页')
    ok(document.activeElement === q('.settings-tabs [role="tab"][aria-selected="true"]'), '切页后焦点跟随')

    out.push('\n=== 每页内容 ===')
    for (const id of order) {
      const started = performance.now()
      click(q(`#settings-tab-${id}`))
      for (let n = 0; n < 40 && !anchors[id].some((name) => !!q(`[data-testid="${name}"]`)); n++) await sleep(50)
      out.push(`  ${id}：首次内容就绪 ${Math.round(performance.now() - started)}ms`)
      ok(!!q('#settings-tabpanel[role="tabpanel"]'), `${id}：内容区存在`)
      ok(anchors[id].some((name) => !!q(`[data-testid="${name}"]`)), `${id}：真实内容锚点存在`)
    }

    out.push('\n=== 合并页和低频选项 ===')
    click(q('#settings-tab-workspace'))
    await sleep(250)
    ok(!!q('[data-testid="ctx-native-settings"]'), '工作区与上下文页提供 Agent 原生压缩操作')
    ok(!q('[data-testid="ctx-budget-v1"]') && !q('[data-testid="ctx-fold-toggle"]') && !q('[data-testid="kn-toggle-btn"]'), '退役宿主预算、折叠与知识开关不再出现')
    click(q('#settings-tab-capabilities'))
    await sleep(250)
    ok(!!q('[data-testid="set-capabilities"]') && !!q('#settings-tab-market'), '能力保留原页，插件市场独立入口')
    const searchRow = q('[data-testid="cap-search-api"]')
    ok(!!searchRow, '能力页有「增强搜索」')
    for (const id of ['tavily', 'brave', 'firecrawl', 'context7']) {
      /* 环境变量已配置时界面故意不再给输入框（key 来源是环境变量），状态行会写明 */
      const viaEnv = /环境变量|environment variable/.test(q(`[data-testid="cap-search-api-status-${id}"]`)?.textContent ?? '')
      ok(!!q(`[data-testid="cap-search-api-${id}"]`) && (!!q(`[data-testid="cap-search-api-key-${id}"]`) || viaEnv), `增强搜索：${id} 有独立的 key 输入（或已由环境变量配置）`)
    }
    click(q('#settings-tab-devices'))
    await sleep(250)
    ok(!!q('[data-testid="settings-remote"]') && !!q('[data-testid="settings-peer"]'), '语音、手机与砚互联共用设备页')
    click(q('#settings-tab-appearance'))
    await sleep(250)
    ok(q('[data-testid="set-sound-enabled"]')?.getAttribute('role') === 'switch', '声音布尔项使用 Switch')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(350)
    ok(!q('.settings'), 'Esc 关闭设置面板')
    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
