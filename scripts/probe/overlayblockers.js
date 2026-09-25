/*
 * 原生网页显隐协调（实施-11 H-9a，cost 0）。
 *
 * 过去每个浮层各写各的 `browser.setVisible`，谁关闭谁就把网页提前露出来。
 * 现在只有一个协调器：四条件（浏览器打开 / 右栏展开 / 活动页是浏览器 /
 * 没有 overlay blocker）同时成立才可见，浮层只领自己的 token。
 *
 * 探针通过 store 的 `browserNativeVisible`（协调器算出的期望值）观察接线，
 * 不再靠各处 setVisible 的副作用。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const st = () => store.getState()
  const click = (sel) => {
    const el = q(sel)
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return !!el
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    if (!st().settings?.rightPanelOpen) await st().setRightPanelOpen(true)
    await sleep(600)

    const read = () => st().browserNativeVisible
    ok(!!q('[data-testid="right-window-tabs"]'), '右栏窗口标签行在（右栏已展开）')

    /* ---- 1. 打开浏览器并切到它：应可见 ---- */
    out.push('')
    out.push('=== 1. 浏览器打开且是活动页 ===')
    await st().openBrowser('about:blank')
    await sleep(1200)
    ok(!!st().browserState.open, '浏览器已打开（about:blank）')
    click('[data-testid="right-window-tab-browser"]')
    await sleep(600)
    ok(read() === true, `浏览器是活动页且无浮层 → 期望可见（实际 ${read()}）`)

    /* ---- 2. 切到工具：应隐藏，资源仍在 ---- */
    out.push('')
    out.push('=== 2. 活动页不是浏览器 ===')
    click('[data-testid="right-window-tab-start"]')
    await sleep(500)
    ok(st().browserState.open, '切到工具后浏览器资源保留')
    ok(read() === false, `活动页不是浏览器 → 期望隐藏（实际 ${read()}）`)
    click('[data-testid="right-window-tab-browser"]')
    await sleep(500)
    ok(read() === true, '切回浏览器恢复可见')

    /* ---- 3. overlay blocker：设置打开/关闭 ---- */
    out.push('')
    out.push('=== 3. 设置浮层 blocker ===')
    st().openSettings('appearance')
    await sleep(400)
    ok(read() === false, `设置打开时原生网页隐藏（实际 ${read()}）`)
    st().closeSettings()
    await sleep(400)
    ok(read() === true, `设置关闭后按当时状态恢复可见（实际 ${read()}）`)

    /* ---- 4. 审查资源：活动页切走后隐藏，关审查回浏览器恢复 ---- */
    out.push('')
    out.push('=== 4. 审查资源切换 ===')
    st().openReview()
    await sleep(500)
    ok(read() === false, `审查打开时原生网页隐藏（实际 ${read()}）`)
    ok(st().browserState.open, '审查打开不销毁浏览器资源')
    st().closeReview()
    await sleep(500)
    ok(read() === true, `关审查回到浏览器活动页 → 恢复可见（实际 ${read()}）`)

    /* ---- 5. 收起右栏：原生区域一起不可见 ---- */
    out.push('')
    out.push('=== 5. 收起右栏 ===')
    await st().setRightPanelOpen(false)
    await sleep(500)
    ok(read() === false, `收起右栏时原生网页不可见（实际 ${read()}）`)
    await st().setRightPanelOpen(true)
    await sleep(500)
    ok(read() === true, '展开右栏后恢复可见')

    /* ---- 6. 直接领 token：只释放自己 ---- */
    out.push('')
    out.push('=== 6. blocker token 归属 ===')
    const releaseA = st().acquireOverlayBlocker('probe-a')
    await sleep(200)
    ok(read() === false, '领一个 blocker 就隐藏')
    const releaseB = st().acquireOverlayBlocker('probe-b')
    await sleep(200)
    releaseA()
    await sleep(200)
    ok(read() === false, '释放 a 后 b 还在，仍隐藏（不提前恢复）')
    releaseB()
    await sleep(300)
    ok(read() === true, '释放自己的 b 后恢复可见')

    /* ---- 7. 子代理详情 blocker（旧 right placement 路径） ---- */
    out.push('')
    out.push('=== 7. 子代理详情 blocker ===')
    const releaseSub = st().acquireOverlayBlocker('subagent-preview')
    await sleep(200)
    ok(read() === false, '子代理详情占用时原生网页隐藏')
    releaseSub()
    await sleep(300)
    ok(read() === true, '关闭详情只释放自己的 blocker，恢复网页')

    /* 收尾：关掉浏览器 */
    await st().closeBrowser()
    await sleep(400)
    ok(read() === false, '关闭浏览器后不显示原生网页')

    out.push('')
    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
