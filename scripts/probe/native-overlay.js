/*
 * 原生视图与浮层遮挡（实施-11 H-9a / 实施-12 U-6 残余）——配合
 * `scripts/capture-native-overlay.mjs` 的**真窗口**截图流程。
 *
 * 探针只负责把界面带到两个需要看图的状态，并在每个状态发出一个 marker；
 * 截图由宿主侧的 PowerShell（PrintWindow）完成 —— 渲染进程的 capturePage
 * 看不到原生 `WebContentsView`。
 */
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

    /* ---- phase 1：浏览器是活动页、没有浮层 —— 原生网页应当可见 ---- */
    await st().openBrowser('http://127.0.0.1:38418')
    await sleep(1500)
    click('[data-testid="right-window-tab-browser"]')
    await sleep(800)
    if (st().browserNativeVisible !== true) throw new Error(`浏览器可见性期望 true，实际 ${st().browserNativeVisible}`)
    console.error('NATIVE_OVERLAY_READY phase=browser')
    await sleep(9000)

    /* ---- phase 2：打开设置浮层 —— 原生网页让位，面板完整可见 ---- */
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
