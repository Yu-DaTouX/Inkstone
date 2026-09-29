/* Isolated desktop runtime: settings links, listener, pairing code and QR. No model call. */
;(async () => {
  const out = []
  const check = (condition, label) => out.push(`${condition ? '  ✓' : '  ✗'} ${label}`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      if (predicate()) return true
      await sleep(100)
    }
    return false
  }
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const original = (await window.yan.getSettings()).remoteAccess
  try {
    const port = 40000 + Math.floor(Math.random() * 10000)
    const status = await window.yan.remote.configure({ enabled: true, bind: 'loopback', port })
    check(!!status?.running && status.host === '127.0.0.1', '隔离实例在本机地址监听')
    store.setState({ settings: await window.yan.getSettings() })
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25 && q('.ob-card'); i++) {
      const button = [...q('.ob-card').querySelectorAll('button')].find((element) => /开始使用|完成/.test(element.textContent))
      if (button) button.click()
      await sleep(200)
    }
    if (!store.getState().settingsOpen) q('[data-testid="rail-settings"]')?.click()
    await until(() => !!q('#settings-tab-devices'))
    q('#settings-tab-devices')?.click()
    await until(() => !!q('[data-testid="settings-remote"]'))
    const panel = q('[data-testid="settings-remote"]')
    check(!!panel, '设备连接页里的手机接入区可打开')
    check(/Tailscale · Windows/.test(panel?.textContent ?? ''), '电脑端 Tailscale 下载入口可见')
    check(/Tailscale · Android/.test(panel?.textContent ?? ''), '手机端 Tailscale 下载入口可见')
    check(!!q('[data-testid="remote-guide"]'), '配对区的 GitHub 使用说明入口可见')
    check(!!q('[data-testid="remote-pair-start"]'), '生成配对码按钮可见')
    q('[data-testid="remote-pair-start"]')?.click()
    await until(() => !!q('[data-testid="remote-pairing-code"]'))
    check(/^\d{6}$/.test(q('[data-testid="remote-pairing-code"]')?.textContent ?? ''), '生成 6 位配对码')
    check(!!q('[data-testid="remote-pairing-qr"] svg path'), '配对链接二维码已渲染')
    check(!!q('[data-testid="remote-pairing-link-copy"]'), '同一配对链接可复制')
    return out.join('\n')
  } catch (error) {
    out.push(`  ✗ 探针异常：${error?.message ?? String(error)}`)
    return out.join('\n')
  } finally {
    await window.yan.remote.cancelPairing().catch(() => undefined)
    await window.yan.remote.configure(original).catch(() => undefined)
  }
})()
