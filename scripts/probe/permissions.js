;(async () => {
  const out = [], store = window.__yanStore
  const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)]
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ok = (value, label) => out.push('  ' + (value ? '✓' : '✗') + ' ' + label)
  const until = async fn => { for (let i = 0; i < 80; i++) { if (fn()) return true; await sleep(100) } return false }
  const MENU = '.composer-permission-menu'
  const items = () => qa(MENU + ' [role="menuitem"]')
  const picker = () => q('[data-testid="permission-picker"]')
  let previous
  try {
    if (!await until(() => store.getState().settings && picker())) throw new Error('permission picker not ready')
    previous = store.getState().settings.permissionMode
    store.getState().closeSettings()
    await store.getState().patchSettings({ permissionMode: 'danger' })
    await until(() => picker()?.dataset.mode === 'danger')
    picker().click()
    if (!await until(() => items().length > 0)) throw new Error('permission menu not mounted')
    const choices = items()
    ok(choices.length === 2 && /自动批准|Auto/.test(choices[0].textContent) && /不受限制|Unrestricted|Full/.test(choices[1].textContent), '正式入口只有自动批准与不受限制两档')
    ok(choices[0].dataset.current === 'true' && !choices[1].dataset.current, '自动批准标出当前档位')
    choices[0].focus()
    choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    await until(() => document.activeElement === items()[1])
    ok(document.activeElement === items()[1], 'End键可到不受限制档，不提前改变设置')
    ok(store.getState().settings.permissionMode === 'danger', '键盘浏览不切换权限')
    items()[1].click()
    const confirmShown = await until(() => q('[data-testid="permission-confirm-all"]'))
    ok(confirmShown, '切到不受限制前弹出确认')
    ok(store.getState().settings.permissionMode === 'danger', '确认前不切换权限')
    q('[data-testid="permission-confirm-all"]')?.click()
    await until(() => store.getState().settings.permissionMode === 'all' && !q(MENU))
    ok(store.getState().settings.permissionMode === 'all', '确认后更新渲染状态')
    ok((await window.yan.getSettings()).permissionMode === 'all', '不受限制由正式IPC持久化')
    await until(() => picker()?.getAttribute('aria-expanded') !== 'true')
    ok(picker()?.getAttribute('aria-expanded') !== 'true' && !q(MENU), '选中后权限菜单关闭')
    ok(picker()?.dataset.mode === 'all', '入口按钮显示当前档位')
    ok(await until(() => !q('[data-testid="permission-confirm-all"]')), '确认框随确认关闭')
    picker().click()
    await until(() => items().length === 2)
    items()[0]?.click()
    await until(() => store.getState().settings.permissionMode === 'danger' && !q(MENU))
    ok(!q('[data-testid="permission-confirm-all"]'), '切回自动批准不需要确认')
    ok((await window.yan.getSettings()).permissionMode === 'danger', '可切回自动批准并持久化')
  } catch (error) { ok(false, String(error)) }
  finally {
    if (q(MENU)) document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    if (previous) {
      try { await store.getState().patchSettings({ permissionMode: previous }) }
      catch (error) { ok(false, '权限复位失败: ' + String(error)) }
    }
  }
  return out.join('\n')
})()
