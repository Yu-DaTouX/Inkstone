;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 5000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const enableInput = () => q('v3-devices-enable')?.querySelector('input') ?? q('v3-devices-enable')
  const enabled = () => !!enableInput()?.checked
  const badgeText = () => q('v3-devices-settings')?.querySelector('.ui-badge, [class*="badge"]')?.textContent ?? ''
  const press = (testId) => {
    const node = q(testId)
    node?.click()
    return !!node
  }

  try {
    out.push('=== 设备与同步：开关回显、监听地址、二维码（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    window.location.hash = '#/settings'
    await wait(200)
    window.__yanStore.getState().openSettings('devices')
    check(await until(() => q('v3-devices-settings') && q('v3-devices-bind'), 8000), '设备分区与监听地址行已渲染')
    check(!enabled(), '初始开关为关')
    check(q('v3-devices-bind-tailscale')?.getAttribute('aria-pressed') === 'true' || q('v3-devices-bind-tailscale')?.getAttribute('data-selected') === 'true', '默认监听 Tailscale')

    enableInput()?.click()
    check(await until(enabled, 5000), '点开关后开关回显为开')
    const tailscaleUp = await until(() => /100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(badgeText()), 4000)
    if (tailscaleUp) {
      out.push('  · 本机 Tailscale 在线，跳过「找不到 Tailscale」报错检查')
    } else {
      check(await until(() => q('v3-devices-start-error'), 6000), `Tailscale 不在线时显示开启失败原因（${q('v3-devices-start-error')?.textContent?.trim() ?? '无'}）`)
    }

    press('v3-devices-bind-loopback')
    check(await until(() => badgeText().includes('127.0.0.1'), 8000), `改为仅本机后运行在 127.0.0.1（徽标=${badgeText()}）`)
    check(!q('v3-devices-start-error'), '运行后不再显示失败原因')
    check(await until(() => /手机和其他电脑连不上|cannot connect/.test(q('v3-devices-settings')?.innerText ?? ''), 3000), '仅本机时提示别的设备连不上')

    press('v3-devices-bind-lan')
    const lanUp = await until(() => /(^|\D)(10|172|192)\.\d+\.\d+\.\d+:/.test(badgeText()), 8000)
    check(lanUp, `改为局域网后监听局域网地址（徽标=${badgeText()}）`)
    if (lanUp) {
      press('v3-devices-pair')
      check(await until(() => q('v3-devices-pairing-qr')?.querySelector('svg'), 6000), '生成配对码后显示二维码')
      check(/^\d{6}$/.test(q('v3-devices-pairing-code')?.querySelector('strong')?.textContent ?? ''), '显示 6 位配对码')
      q('v3-devices-pairing')?.scrollIntoView({ block: 'center' })
      await wait(4500)
      const cancel = [...(q('v3-devices-pairing')?.querySelectorAll('button') ?? [])].find((b) => /取消|Cancel/.test(b.textContent ?? ''))
      cancel?.click()
      check(await until(() => !q('v3-devices-pairing'), 4000), '取消配对后回到生成按钮')
    }

    enableInput()?.click()
    check(await until(() => !enabled(), 5000), '再点开关后回显为关')
    check(await until(() => !/:\d+/.test(badgeText()), 6000), `关闭后服务停止（徽标=${badgeText()}）`)
    check(document.documentElement.scrollWidth <= window.innerWidth + 1, '页面没有横向溢出')
    out.push('证据范围：隔离数据目录、真实主进程接入服务（本机/局域网短暂监听、无已配对设备）；未验真实手机扫码与 Radmin VPN 网卡。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
