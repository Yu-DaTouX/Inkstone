;(async () => {
  const store = window.__yanStore
  const st = () => store.getState()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (sel) => {
    const el = q(sel)
    if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return !!el
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (const button of document.querySelectorAll('.ob-card button')) {
      if (/开始使用|完成/.test(button.textContent)) button.click()
    }
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    await st().patchSettings({ rightPanelOpen: true, uiScale: 1 })
    if (!st().settings?.rightPanelOpen) await st().setRightPanelOpen(true)
    await sleep(600)

    await st().openBrowser('http://127.0.0.1:38418')
    await sleep(1500)
    click('[data-testid="right-window-tab-browser"]')
    await sleep(800)
    if (st().browserNativeVisible !== true) throw new Error(`浏览器可见性期望 true，实际 ${st().browserNativeVisible}`)
    console.error('NATIVE_OVERLAY_READY phase=browser')
    await sleep(9000)

    st().openSettings('appearance')
    await sleep(800)
    if (st().browserNativeVisible !== false) throw new Error(`浮层打开时网页应隐藏，实际 ${st().browserNativeVisible}`)
    console.error('NATIVE_OVERLAY_READY phase=settings')
    await sleep(9000)

    st().closeSettings()
    await sleep(400)
    await st().closeBrowser()
    console.error('NATIVE_OVERLAY_DONE ok=true browser=true settings=true')
    return 'native overlay phases done'
  } catch (error) {
    console.error(`NATIVE_OVERLAY_DONE ok=false error=${error?.message ?? String(error)}`)
    return `native overlay probe failed: ${error?.message ?? String(error)}`
  }
})()
