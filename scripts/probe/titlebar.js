/**
 * 标题栏：置顶按钮 + 精简掉的重复入口。
 *
 * 用户要求：
 *   · 置顶给一个按钮，放在**窗口控制按钮（— □ ✕）的左边**
 *   · 把旁边的「设置」与「中/英文」放去设置里
 *     （两者在设置面板「外观」tab 里本来就有；设置齿轮在左栏底部也有）
 *
 * 置顶是**真实窗口状态**（win.isAlwaysOnTop()），所以断言分两层：
 *   ① DOM：按钮在正确位置、选中态跟着状态
 *   ② 主进程：点下去真的改了窗口层级（靠 store.alwaysOnTop 回报）
 */
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
  /** 轮询到条件成立（不用固定 sleep 等 IPC 往返 —— 全量跑时会被拖慢） */
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

  /* ---------------- 1. 置顶按钮存在且在窗口控制左边 ---------------- */
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
    // 垂直上要在同一条（都在标题栏里）
    ok(Math.abs(a.top - b.top) < 40, '与窗口控制在同一行（标题栏内）')
  }

  /* ---------------- 2. 默认不置顶 ---------------- */
  out.push('')
  out.push('=== 2. 默认不置顶（不能偷偷开） ===')
  // 等设置从主进程回来（别在 store 还是初始默认值时断言）
  await until(() => store.getState().settings != null, 5000)
  out.push('  store.alwaysOnTop = ' + store.getState().alwaysOnTop)
  ok(store.getState().alwaysOnTop !== true, '默认不在置顶态')
  ok(pin?.getAttribute('data-on') === '0', '按钮的选中态是关')

  /* ---------------- 3. 点一下真的置顶 ---------------- */
  out.push('')
  out.push('=== 3. 切换置顶 ===')
  pin?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  /*
   * ⚠️ 轮询等状态，不要用固定 sleep。
   *    置顶要走：渲染端 IPC → 主进程 setAlwaysOnTop → always-on-top-changed
   *    事件 → push 回渲染端。全量跑（前一个场景刚跑完）时这条链可能超过 1.2s，
   *    固定等待会假失败 —— 实测就在全量第 2 轮挂过。
   */
  const onMs = await until(() => store.getState().alwaysOnTop === true, 6000)
  const on = store.getState().alwaysOnTop
  out.push('  点击后 store.alwaysOnTop = ' + on + '（等了 ' + onMs + 'ms）')
  ok(on === true, '点一下变置顶（store 收到主进程回报的真实状态）')
  ok(pin?.getAttribute('data-on') === '1', '按钮的选中态跟着变')

  // 再点一下关掉 —— 留一个干净的退出状态（别让下次启动是置顶的）
  pin?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const offMs = await until(() => store.getState().alwaysOnTop === false, 6000)
  out.push('  再点一次后 = ' + store.getState().alwaysOnTop + '（等了 ' + offMs + 'ms）')
  ok(store.getState().alwaysOnTop === false, '再点一下取消置顶')

  /* ---------------- 4. 标题栏不再有重复入口 ---------------- */
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

  /* ---------------- 5. 设置里能改语言和主题（搬家后的落点） ---------------- */
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

  // 左栏底部仍有设置入口（齿轮搬走的落点）
  const railBtn = q('[data-testid="rail-settings"]')
  out.push('  左栏设置入口: ' + (railBtn ? '有' : '无'))
  ok(!!railBtn, '左栏底部还有设置入口（齿轮从标题栏搬走后仍有路可走）')

  store.getState().closeSettings()

  /* ---------------- 6. 图标真的渲染出来了（不是空引用） ---------------- */
  out.push('')
  out.push('=== 6. 图标无空引用 ===')
  // 这是本会话踩的坑：跑 npm run icons 把 i-settings 删了，
  // 因为 prototype.html 的 sprite 与 sprite.ts 本来就不一致。
  for (const sel of ['[data-testid="win-pin"] .ico', '[data-testid="rail-settings"] .ico']) {
    const ico = q(sel)
    const use = ico?.querySelector('use')
    const href = use?.getAttribute('href') ?? ''
    out.push(`  ${sel} → ${href || '(无)'}`)
    ok(!!href && href !== '#', `${sel} 有真实图标引用`)
  }
  // 引用的 symbol 必须真的在 sprite 里
  const spriteText = document.querySelector('#yan-icons')?.innerHTML ?? document.body.innerHTML
  ok(spriteText.includes('id="i-pin"'), 'sprite 里有 i-pin')
  ok(spriteText.includes('id="i-settings"'), 'sprite 里有 i-settings（否则设置齿轮是空的）')

  return out.join('\n')
})()
