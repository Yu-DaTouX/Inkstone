;(async () => {
  const out = [], store = window.__yanStore
  const q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)]
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ok = (value, label) => out.push('  ' + (value ? '✓' : '✗') + ' ' + label)
  const until = async fn => { for (let i = 0; i < 80; i++) { if (fn()) return true; await sleep(100) } return false }
  let previous
  try {
    if (!await until(() => store.getState().settings && q('[data-testid="permission-picker"]'))) throw new Error('permission picker not ready')
    previous = store.getState().settings.permissionMode
    store.getState().closeSettings()
    await store.getState().patchSettings({ permissionMode: 'danger' })
    q('[data-testid="permission-picker"]').click()
    if (!await until(() => q('.ui-choice-menu'))) throw new Error('permission menu not mounted')
    const choices = qa('.ui-choice-menu [role="menuitemradio"]')
    ok(choices.length === 2 && choices.map(x => x.dataset.value).join(',') === 'danger,all', '正式入口只有危险审批与原生两档')
    ok(q('.ui-choice-menu [data-value="danger"]')?.getAttribute('aria-checked') === 'true', '危险审批标出当前档位')
    choices[0].focus()
    choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    ok(document.activeElement?.dataset.value === 'all', 'End键可到原生档，不提前改变设置')
    ok(store.getState().settings.permissionMode === 'danger', '键盘浏览不切换权限')
    document.activeElement.click()
    await until(() => store.getState().settings.permissionMode === 'all' && !q('.ui-choice-menu'))
    ok(store.getState().settings.permissionMode === 'all', '选中原生档更新渲染状态')
    ok((await window.yan.getSettings()).permissionMode === 'all', '原生档由正式IPC持久化')
    ok(q('[data-testid="permission-picker"]')?.getAttribute('aria-expanded') === 'false', '选中后权限菜单关闭')
    q('[data-testid="permission-picker"]').click()
    await until(() => q('.ui-choice-menu [data-value="danger"]'))
    q('.ui-choice-menu [data-value="danger"]').click()
    await until(() => store.getState().settings.permissionMode === 'danger' && !q('.ui-choice-menu'))
    ok((await window.yan.getSettings()).permissionMode === 'danger', '可切回危险审批并持久化')
  } catch (error) { ok(false, String(error)) }
  finally {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (previous) {
      try { await store.getState().patchSettings({ permissionMode: previous }) }
      catch (error) { ok(false, '权限复位失败: ' + String(error)) }
    }
  }
  return out.join('\n')
})()
