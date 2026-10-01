(async () => {
  const store = window.__yanStore
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const out = []
  const ok = (value, message) => out.push(`${value ? '✓' : '✗'} ${message}`)
  const q = () => document.querySelector('[data-testid="cap-codemode"]')
  const waitFor = async expected => {
    for (let i = 0; i < 40; i++) {
      if (q()?.getAttribute('aria-checked') === String(expected)) return true
      await sleep(50)
    }
    return false
  }
  try {
    store.getState().openSettings('capabilities')
    await sleep(300)
    ok(q()?.getAttribute('role') === 'switch', '能力页提供可访问的 Codemode 开关')
    ok(await waitFor(true), '旧设置没有该字段时默认开启')
    q()?.focus()
    ok(document.activeElement === q(), '开关可获得键盘焦点')
    q()?.click()
    ok(await waitFor(false), '点击关闭更新界面')
    ok((await window.yan.getSettings()).codemodeEnabled === false, '关闭写入实际桌面设置')
    await store.getState().patchSettings({ responseDetail: 'standard' })
    ok((await window.yan.getSettings()).codemodeEnabled === false, '其他设置修改保留关闭偏好')
    store.getState().closeSettings()
    store.getState().openSettings('capabilities')
    await sleep(300)
    ok(await waitFor(false), '重开设置页仍显示关闭')
    q()?.click()
    ok(await waitFor(true), '点击重新开启')
    ok((await window.yan.getSettings()).codemodeEnabled === true, '重新开启写入实际桌面设置')
    store.getState().closeSettings()
  } catch (error) {
    ok(false, error?.message ?? String(error))
  }
  return out.join('\n')
})()
