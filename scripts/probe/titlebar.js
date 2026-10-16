;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return Date.now() - t0
      await sleep(100)
    }
    return -1
  }

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  store.getState().closeSettings()
  await sleep(400)

  out.push('=== 1. 置顶按钮的位置 ===')
  const pin = q('[data-testid="win-pin"]')
  ok(!!pin, '存在置顶按钮（data-testid=win-pin）')

  const wctrl = q('.wctrl')
  ok(!!wctrl, '存在窗口控制区（.wctrl）')

  if (pin && wctrl) {
    const a = pin.getBoundingClientRect()
    const b = wctrl.getBoundingClientRect()
    out.push(`  置顶 right=${Math.round(a.right)} / 窗口控制 left=${Math.round(b.left)}`)
    ok(a.right <= b.left + 1, '置顶按钮在窗口控制按钮的左边')
    ok(Math.abs(a.top - b.top) < 40, '与窗口控制在同一行（标题栏内）')
  }

  out.push('')
  out.push('=== 2. 默认不置顶（不能偷偷开） ===')
  await until(() => store.getState().settings != null, 5000)
  out.push('  store.alwaysOnTop = ' + store.getState().alwaysOnTop)
  ok(store.getState().alwaysOnTop !== true, '默认不在置顶态')
  ok(pin?.getAttribute('data-on') === '0', '按钮的选中态是关')

  out.push('')
  out.push('=== 3. 切换置顶 ===')
  pin?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const onMs = await until(() => store.getState().alwaysOnTop === true, 6000)
  const on = store.getState().alwaysOnTop
  out.push('  点击后 store.alwaysOnTop = ' + on + '（等了 ' + onMs + 'ms）')
  ok(on === true, '点一下变置顶（store 收到主进程回报的真实状态）')
  ok(pin?.getAttribute('data-on') === '1', '按钮的选中态跟着变')

  pin?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const offMs = await until(() => store.getState().alwaysOnTop === false, 6000)
  out.push('  再点一次后 = ' + store.getState().alwaysOnTop + '（等了 ' + offMs + 'ms）')
  ok(store.getState().alwaysOnTop === false, '再点一下取消置顶')

  out.push('')
  out.push('=== 4. 精简掉的重复入口 ===')
  const tbText = q('.tb-right')?.textContent ?? ''
  out.push('  .tb-right 文本: ' + JSON.stringify(tbText))
  ok(!tbText.includes('中/EN'), '标题栏不再有「中/EN」（已在设置的外观页）')
  ok(!q('.tb-right [title*="语言"]'), '标题栏不再有语言按钮')
  ok(!q('.tb-right [title*="主题"]'), '标题栏不再有主题按钮')
  ok(
    qa('.tb-right .tb-icon').every((b) => b.getAttribute('data-testid')),
    '标题栏右侧只剩有 testid 的功能按钮（右栏开关 / 置顶）'
  )

  out.push('')
  out.push('=== 5. 设置面板里能改语言 / 主题 / 置顶 ===')
  store.getState().openSettings('appearance')
  await sleep(600)
  const body = q('.settings-body')?.textContent ?? ''
  out.push('  外观页文本片段: ' + JSON.stringify(body.replace(/\s+/g, ' ').slice(0, 90)))
  ok(!!body, '外观页渲染了')
  ok(/中文|English|language|语言/i.test(body), '外观页里有语言切换')
  ok(/深色|浅色|dark|light/i.test(body), '外观页里有主题切换')
  ok(!!q('[data-testid="set-always-on-top"]'), '外观页里有置顶开关（与标题栏按钮同一状态）')

  const railBtn = q('[data-testid="rail-settings"]')
  out.push('  左栏设置入口: ' + (railBtn ? '有' : '无'))
  ok(!!railBtn, '左栏底部还有设置入口（齿轮从标题栏搬走后仍有路可走）')

  store.getState().closeSettings()

  out.push('')
  out.push('=== 6. 图标无空引用 ===')
  for (const sel of ['[data-testid="win-pin"] .ico', '[data-testid="rail-settings"] .ico']) {
    const ico = q(sel)
    const use = ico?.querySelector('use')
    const href = use?.getAttribute('href') ?? ''
    out.push(`  ${sel} → ${href || '(无)'}`)
    ok(!!href && href !== '#', `${sel} 有真实图标引用`)
  }
  const spriteText = document.querySelector('#yan-icons')?.innerHTML ?? document.body.innerHTML
  ok(spriteText.includes('id="i-pin"'), 'sprite 里有 i-pin')
  ok(spriteText.includes('id="i-settings"'), 'sprite 里有 i-settings（否则设置齿轮是空的）')

  return out.join('\n')
})()
