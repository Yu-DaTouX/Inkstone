;(async () => {
  const out = [], store = window.__yanStore
  const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)]
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ok = (value, label) => out.push('  ' + (value ? '✓' : '✗') + ' ' + label)
  const until = async (fn, tries = 80) => { for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(100) } return false }
  const mode = () => store.getState().settings?.permissionMode
  const segmented = value => q('[data-testid="v3-security-mode-' + value + '"]')
  const pressed = el => ['aria-pressed', 'aria-checked'].some(name => el?.getAttribute(name) === 'true')
  const modelTrigger = () => q('[data-chat-provider-model-picker]')
  const accessRow = () => q('.composer-model-menu [data-composer-permissions]')
  const unrestrictedSwitch = () => q('[data-testid="permission-all"]')
  let previous
  try {
    if (!await until(() => store.getState().settings && store.getState().session)) throw new Error('store not ready')
    previous = mode()

    out.push('--- 1. 设置里的权限档位 ---')
    store.getState().closeSettings()
    await store.getState().patchSettings({ permissionMode: 'danger' })
    await until(() => mode() === 'danger')
    store.getState().openSettings('security')
    if (!await until(() => q('[data-testid="v3-security-settings"]') && segmented('danger'))) throw new Error('security settings not mounted')
    ok(pressed(segmented('danger')) && !pressed(segmented('all')), '设置分段标出当前档位（自动批准）')

    segmented('all').click()
    const confirmShown = await until(() => q('[data-testid="v3-security-all-confirm"]'))
    ok(confirmShown, '设置里切到不受限制前弹出确认')
    ok(mode() === 'danger', '确认前不切换权限')
    q('[data-testid="v3-security-all-confirm"]').click()
    ok(await until(() => mode() === 'all'), '确认后渲染状态切到不受限制')
    ok((await window.yan.getSettings()).permissionMode === 'all', '不受限制由正式 IPC 持久化')
    ok(await until(() => !q('[data-testid="v3-security-all-confirm"]')), '确认框随确认关闭')
    const outsideSwitch = () => q('[data-testid="v3-security-outside"]')
    ok(await until(() => outsideSwitch()?.getAttribute('data-disabled') === 'true' || outsideSwitch()?.querySelector('input')?.disabled === true), '不受限制档下「项目外写入」开关被禁用')

    segmented('danger').click()
    ok(await until(() => mode() === 'danger'), '切回自动批准立即生效')
    ok(!q('[data-testid="v3-security-all-confirm"]'), '切回自动批准不需要确认')
    ok((await window.yan.getSettings()).permissionMode === 'danger', '切回自动批准由正式 IPC 持久化')

    out.push('')
    out.push('--- 2. 输入框的权限入口 ---')
    store.getState().closeSettings()
    await until(() => !q('[data-testid="v3-security-settings"]'))
    if (!await until(() => modelTrigger() && q('[data-composer-permission-trigger]'))) throw new Error('composer permission entry not mounted')
    const chip = () => q('[data-composer-permission-trigger]')
    ok(chip()?.dataset.permissionMode === 'danger', '输入框权限按钮显示当前档位')
    modelTrigger().click()
    if (!await until(() => accessRow())) throw new Error('model menu access row not mounted')
    ok(accessRow()?.dataset.permissionMode === 'danger', '模型菜单权限行显示当前档位')
    ok(unrestrictedSwitch()?.getAttribute('data-unrestricted') !== 'true', '不受限制开关初始为关')
    unrestrictedSwitch().click()
    ok(await until(() => mode() === 'all'), '模型菜单开关切到不受限制')
    ok((await window.yan.getSettings()).permissionMode === 'all', '菜单里的切换同样走正式 IPC')
    ok(await until(() => chip()?.dataset.permissionMode === 'all'), '输入框权限按钮跟随更新')
    ok(await until(() => unrestrictedSwitch()?.getAttribute('data-unrestricted') === 'true'), '开关标出已开启')
    unrestrictedSwitch().click()
    ok(await until(() => mode() === 'danger'), '模型菜单开关可切回自动批准')
    ok((await window.yan.getSettings()).permissionMode === 'danger', '切回同样持久化')
  } catch (error) { ok(false, String(error)) }
  finally {
    const dialog = q('.settings-confirm-overlay')
    if (dialog) document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    if (q('[data-composer-model-menu]')) document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    if (store) {
      try { store.getState().closeSettings() } catch (error) { }
      if (previous) {
        try { await store.getState().patchSettings({ permissionMode: previous }) }
        catch (error) { ok(false, '权限复位失败: ' + String(error)) }
      }
    }
  }
  return out.join('\n')
})()
