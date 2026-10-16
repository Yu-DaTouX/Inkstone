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

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    if (!st().settings?.rightPanelOpen) await st().setRightPanelOpen(true)
    await sleep(600)

    const read = () => st().browserNativeVisible
    const setActive = async (active) => {
      st().setBrowserSurfaceActive(active)
      await sleep(300)
    }
    ok(!!q('[data-testid="tile-workspace"]') && !!q('[data-workspace-pane]'), '右栏磁贴工作区已挂载')

    out.push('')
    out.push('=== 1. 浏览器打开且是活动页 ===')
    await st().openBrowser('about:blank')
    await sleep(1200)
    ok(!!st().browserState.open, '浏览器已打开（about:blank）')
    await setActive(true)
    ok(read() === true, `浏览器是活动页且无浮层 → 期望可见（实际 ${read()}）`)

    out.push('')
    out.push('=== 2. 活动页不是浏览器 ===')
    await setActive(false)
    ok(st().browserState.open, '切走后浏览器资源保留')
    ok(read() === false, `活动页不是浏览器 → 期望隐藏（实际 ${read()}）`)
    await setActive(true)
    ok(read() === true, '切回浏览器恢复可见')

    out.push('')
    out.push('=== 3. 设置浮层 blocker ===')
    st().openSettings('appearance')
    await sleep(400)
    ok(read() === false, `设置打开时原生网页隐藏（实际 ${read()}）`)
    st().closeSettings()
    await sleep(400)
    ok(read() === true, `设置关闭后按当时状态恢复可见（实际 ${read()}）`)

    out.push('')
    out.push('=== 4. 右栏开关（已退役）===')
    await st().setRightPanelOpen(false)
    await sleep(400)
    ok(read() === true, `收起右栏不再让原生网页消失（实际 ${read()}）—— 由浏览器磁贴可见性决定`)
    await st().setRightPanelOpen(true)
    await sleep(300)

    out.push('')
    out.push('=== 5. blocker token 归属 ===')
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

    out.push('')
    out.push('=== 6. 子代理详情 blocker ===')
    const releaseSub = st().acquireOverlayBlocker('subagent-preview')
    await sleep(200)
    ok(read() === false, '子代理详情占用时原生网页隐藏')
    releaseSub()
    await sleep(300)
    ok(read() === true, '关闭详情只释放自己的 blocker，恢复网页')

    await st().closeBrowser()
    await sleep(400)
    ok(read() === false, '关闭浏览器后不显示原生网页')

    return out.join('\n')
  } catch (error) {
    out.push('  ✗ 探针异常：' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
