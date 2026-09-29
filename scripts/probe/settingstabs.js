/** 九页设置导航、合并内容、键盘焦点和高级披露。 */
;(async () => {
  const out = []
  const ok = (condition, label) => { out.push((condition ? '  ✓ ' : '  ✗ ') + label); return !!condition }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const qa = (selector) => [...document.querySelectorAll(selector)]
  const click = (element) => element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const order = ['auth', 'appearance', 'input', 'workspace', 'context', 'capabilities', 'voice', 'devices', 'about']
  const anchors = {
    auth: ['auth-msg', 'auth-recheck'],
    appearance: ['set-ui-scale', 'set-density', 'theme-dark'],
    input: ['set-sound', 'set-sound-enabled'],
    workspace: ['set-workspace-mode', 'set-space-new-name'],
    context: ['ctx-budget-v1', 'ctx-fold-toggle', 'kn-toggle-btn'],
    capabilities: ['set-capabilities', 'set-packages'],
    voice: ['settings-voice', 'voice-state', 'voice-models'],
    devices: ['settings-remote', 'settings-peer'],
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

    out.push('=== 九页导航 ===')
    ok(qa('.settings').length === 1, '设置面板只有一个实例')
    const tabs = qa('.settings-tabs [role="tab"]')
    ok(tabs.length === order.length, `九页导航（实际 ${tabs.length}）`)
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
      click(q(`#settings-tab-${id}`))
      await sleep(230)
      ok(!!q('#settings-tabpanel[role="tabpanel"]'), `${id}：内容区存在`)
      ok(anchors[id].some((name) => !!q(`[data-testid="${name}"]`)), `${id}：真实内容锚点存在`)
    }

    out.push('\n=== 合并页和低频选项 ===')
    click(q('#settings-tab-context'))
    await sleep(250)
    ok(!!q('[data-testid="ctx-fold-toggle"]') && !!q('[data-testid="kn-toggle-btn"]'), '上下文与记忆共用一页')
    ok(qa('.settings-body .ui-disclosure').length > 0, '高级选项使用 Disclosure')
    click(q('#settings-tab-capabilities'))
    await sleep(250)
    ok(!!q('[data-testid="set-capabilities"]') && !!q('[data-testid="set-packages"]'), '能力与插件共用一页')
    click(q('#settings-tab-devices'))
    await sleep(250)
    ok(!!q('[data-testid="settings-remote"]') && !!q('[data-testid="settings-peer"]'), '手机与砚互联共用设备页')
    click(q('#settings-tab-input'))
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
