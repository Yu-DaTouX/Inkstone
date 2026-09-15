/* 真实 Electron 探针：确认工具栏旁开关、右栏 BrowserView 与 renderer 状态能闭环。 */
(async () => {
  let button = document.querySelector('[data-testid="browser-view-toggle"]')
  if (!button) {
    const panelToggle = document.querySelector('[data-testid="rightpanel-toggle"]')
    if (panelToggle) {
      panelToggle.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      button = document.querySelector('[data-testid="browser-view-toggle"]')
    }
  }
  if (!button) throw new Error('找不到内置浏览器按钮')
  button.click()
  await new Promise((resolve) => setTimeout(resolve, 1800))
  const state = await window.yan.browser.getState()
  const observation = await window.yan.browser.observe()
  const viewport = document.querySelector('[data-testid="browser-surface"] .browser-viewport')
  const rect = viewport ? viewport.getBoundingClientRect() : null
  const surface = document.querySelector('[data-testid="rightpanel"] [data-testid="browser-surface"]')
  const centerMode = document.querySelector('.center.browser-mode')
  if (!state.open) throw new Error(`浏览器未打开: ${JSON.stringify(state)}`)
  if (!surface || centerMode || button.getAttribute('aria-checked') !== 'true') {
    throw new Error('浏览器没有在右侧工具栏面板中打开')
  }
  if (!observation.generationId || observation.accessibilityNodeCount < 1 || !observation.domSnapshotCaptured) {
    throw new Error(`CDP 观察结果不完整: ${JSON.stringify(observation)}`)
  }
  const firstTab = state.activeTabId
  const withSecondTab = await window.yan.browser.newTab('https://example.com')
  if (!firstTab || (withSecondTab.tabs || []).length < 2) throw new Error(`标签页未创建: ${JSON.stringify(withSecondTab)}`)
  await window.yan.browser.switchTab(firstTab)
  const secondTab = (withSecondTab.tabs || []).find((tab) => tab.id !== firstTab)
  if (secondTab) await window.yan.browser.closeTab(secondTab.id)

  /*
   * 加载/错误提示必须落在工具栏里（原生 WebContentsView 之上）。
   * 之前它们被定位到网页区域，而网页是主进程的原生视图、永远盖住渲染层，
   * 用户根本看不到导航失败。用一次必然失败的连接来触发那条提示。
   */
  const form = document.querySelector('[data-testid="browser-surface"] .browser-address')
  const input = form && form.querySelector('input')
  const errorViewport = document.querySelector('[data-testid="browser-surface"] .browser-viewport')
  if (form && input && errorViewport) {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(input, 'http://127.0.0.1:1/')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 60))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const errorEl = document.querySelector('[data-testid="browser-surface"] .browser-error')
    if (!errorEl) throw new Error('导航失败后没有显示错误提示')
    const errorRect = errorEl.getBoundingClientRect()
    const viewportRect = errorViewport.getBoundingClientRect()
    if (errorRect.bottom > viewportRect.top + 1) {
      throw new Error(`错误提示落在网页区域内，会被原生视图遮住：${errorRect.bottom} > ${viewportRect.top}`)
    }
  }

  const finalState = await window.yan.browser.getState()
  const finalViewport = document.querySelector('[data-testid="browser-surface"] .browser-viewport')
  const finalRect = finalViewport ? finalViewport.getBoundingClientRect() : null
  if (finalRect && rect && Math.abs(finalRect.width - rect.width) > 1) {
    throw new Error(`浏览器区域宽度被内容撑变形：${rect.width} -> ${finalRect.width}`)
  }

  /* 逐站权限：默认拒绝的基础上，允许用户临时授予并随后撤销。 */
  const permissionOrigin = /^https?:/i.test(state.url) ? new URL(state.url).origin : 'https://example.com'
  const permissionName = 'notifications'
  const allowed = await window.yan.browser.setPermission(permissionName, permissionOrigin, true)
  if (!allowed.ok) throw new Error(`逐站权限允许失败：${allowed.error || 'unknown'}`)
  const allowedState = await window.yan.browser.getState()
  const allowedRecord = (allowedState.permissions || []).find(
    (item) => item.permission === permissionName && item.origin === permissionOrigin
  )
  if (!allowedRecord || allowedRecord.status !== 'allowed') {
    throw new Error(`逐站权限未记录为 allowed：${JSON.stringify(allowedState.permissions)}`)
  }
  const revoked = await window.yan.browser.setPermission(permissionName, permissionOrigin, false)
  if (!revoked.ok) throw new Error(`逐站权限撤销失败：${revoked.error || 'unknown'}`)
  const revokedState = await window.yan.browser.getState()
  const revokedRecord = (revokedState.permissions || []).find(
    (item) => item.permission === permissionName && item.origin === permissionOrigin
  )
  if (!revokedRecord || revokedRecord.status !== 'blocked') {
    throw new Error(`逐站权限未记录为 blocked：${JSON.stringify(revokedState.permissions)}`)
  }

  /*
   * 用户要求：浏览器与工具栏**独立** —— 收起工具栏时浏览器要独占整列，
   * 不能再留着一排工具栏标题/分区。这里按住这个回归点。
   */
  const surfaceBox = () => document.querySelector('[data-testid="browser-surface"]')?.getBoundingClientRect()
  const beforeH = surfaceBox()?.height ?? 0
  const panelToggle = document.querySelector('[data-testid="rightpanel-toggle"]')
  if (panelToggle) {
    panelToggle.click()
    await new Promise((r) => setTimeout(r, 700))
    const rpTopGone = !document.querySelector('.rp-top')
    const bodyGone = !document.querySelector('[data-testid="rp-body"]')
    const afterH = surfaceBox()?.height ?? 0
    if (!rpTopGone || !bodyGone) throw new Error('收起工具栏后仍渲染了工具栏内容（浏览器没有独占右栏）')
    if (!(afterH > beforeH)) throw new Error(`收起工具栏后浏览器没有变高：${beforeH} -> ${afterH}`)
    panelToggle.click()
    await new Promise((r) => setTimeout(r, 700))
  }

  return JSON.stringify({ open: state.open, hasUrl: Boolean(state.url), rightPanel: true, centerUnchanged: !centerMode, title: state.title, generation: observation.generationId, elements: observation.elements.length, tabs: finalState.tabs?.length || 0, viewport: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, finalViewport: finalRect && { x: finalRect.x, y: finalRect.y, width: finalRect.width, height: finalRect.height }, nativeBounds: finalState.nativeBounds })
})()
