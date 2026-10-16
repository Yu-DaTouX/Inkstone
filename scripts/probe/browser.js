(async () => {
  const store = window.__yanStore
  if (!store) throw new Error('测试 store 未就绪')
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
  const surface = document.querySelector('[data-workspace-pane="browser"]:not([hidden]) [data-testid="browser-surface"]')
  const centerMode = document.querySelector('.center.browser-mode')
  if (!state.open) throw new Error(`浏览器未打开: ${JSON.stringify(state)}`)
  if (!surface || centerMode || button.getAttribute('aria-pressed') !== 'true') {
    throw new Error('浏览器没有在可见工作区磁贴中打开')
  }
  if (!observation.generationId || observation.accessibilityNodeCount < 1 || !observation.domSnapshotCaptured) {
    throw new Error(`CDP 观察结果不完整: ${JSON.stringify(observation)}`)
  }
  const firstTab = state.activeTabId
  const withSecondTab = await window.yan.browser.newTab('https://example.com')
  if (!firstTab || (withSecondTab.tabs || []).length < 2) throw new Error(`标签页未创建: ${JSON.stringify(withSecondTab)}`)
  await window.yan.browser.switchTab(firstTab)
  const backState = await window.yan.browser.getState()
  if (backState.activeTabId !== firstTab) {
    throw new Error(`切回原标签失败（阅读页被新标签夺走）：${backState.activeTabId} != ${firstTab}`)
  }
  const secondTab = (withSecondTab.tabs || []).find((tab) => tab.id !== firstTab)
  if (secondTab) await window.yan.browser.closeTab(secondTab.id)

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

    const loadError = document.querySelector('[data-testid="browser-load-error"]')
    if (!loadError) throw new Error('主框架加载失败后没有出现可操作的失败行')
    if (!/打不开该页面/.test(loadError.textContent || '')) {
      throw new Error(`失败行文案不对：${loadError.textContent}`)
    }
    const errorUrl = document.querySelector('[data-testid="browser-error-url"]')?.textContent?.trim() ?? ''
    if (!/127\.0\.0\.1:1/.test(errorUrl)) throw new Error(`失败行没有保留原地址：${errorUrl}`)
    const retry = document.querySelector('[data-testid="browser-error-retry"]')
    const external = document.querySelector('[data-testid="browser-error-external"]')
    if (!retry || !external) throw new Error('失败行缺少「重试」或「在外部浏览器打开」')

    retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    if (!document.querySelector('[data-testid="browser-load-error"]')) {
      throw new Error('重试后失败态消失，像是假装成功了')
    }

    const draftValue = 'draft-kept-by-user'
    setValue.call(input, draftValue)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.getState().applyPush({
      ch: 'browser-state',
      payload: { ...store.getState().browserState, url: 'https://pushed-after-draft.example/' }
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (input.value !== draftValue) {
      throw new Error(`后台导航冲掉了正在输入的草稿：${input.value}`)
    }

    const failedTab = (await window.yan.browser.getState()).activeTabId
    const withOther = await window.yan.browser.newTab('https://example.com')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    const onOk = await window.yan.browser.getState()
    if (onOk.loadError) throw new Error('切到正常页面后仍显示上一个标签的加载错误')
    const okTab = onOk.activeTabId ?? (withOther.tabs || []).find((tab) => tab.id !== failedTab)?.id
    await window.yan.browser.switchTab(failedTab)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const backToFailed = await window.yan.browser.getState()
    if (!backToFailed.loadError) throw new Error('切回失败标签后错误归属丢了')
    if (!/127\.0\.0\.1:1/.test(backToFailed.loadError.url || '')) {
      throw new Error(`错误归属到了别的标签地址：${backToFailed.loadError.url}`)
    }
    if (okTab) await window.yan.browser.closeTab(okTab)
    const afterClose = await window.yan.browser.getState()
    if (!(afterClose.tabs || []).some((tab) => tab.id === failedTab)) {
      throw new Error('关闭另一个标签把原标签也关了')
    }
    await window.yan.browser.navigate('https://example.com')
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  const finalState = await window.yan.browser.getState()
  const finalViewport = document.querySelector('[data-testid="browser-surface"] .browser-viewport')
  const finalRect = finalViewport ? finalViewport.getBoundingClientRect() : null
  if (finalRect && rect && Math.abs(finalRect.width - rect.width) > 1) {
    throw new Error(`浏览器区域宽度被内容撑变形：${rect.width} -> ${finalRect.width}`)
  }

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

  const surfaceBox = () => document.querySelector('[data-testid="browser-surface"]')?.getBoundingClientRect()
  const browserTab = document.querySelector('[data-pane-tab="browser"]')
  const hide = browserTab?.querySelector('.ui-tab-close')
  if (!hide) throw new Error('浏览器磁贴缺少隐藏入口')
  {
    const tabId = (await window.yan.browser.getState()).activeTabId
    hide.click()
    await new Promise((r) => setTimeout(r, 700))
    const panelGone = !document.querySelector('[data-workspace-pane="browser"]:not([hidden])')
    const afterH = surfaceBox()?.height ?? 0
    if (!panelGone) throw new Error('隐藏浏览器后磁贴仍在布局里')
    if (afterH > 0) throw new Error(`隐藏磁贴后网页仍有高度 ${afterH}`)
    if (store.getState().browserNativeVisible) throw new Error('隐藏磁贴后原生网页仍可见')
    if ((await window.yan.browser.getState()).activeTabId !== tabId) throw new Error('隐藏磁贴丢失浏览器资源')
    document.querySelector('[data-testid="right-tool-menu"]').click()
    await new Promise((r) => setTimeout(r, 100))
    const reopen = [...document.querySelectorAll('[data-testid="right-tool-menu-popover"] [role="menuitem"]')].find(el => el.textContent.trim() === '浏览器')
    if (!reopen) throw new Error('工作区工具菜单缺少浏览器入口')
    reopen.click()
    await new Promise((r) => setTimeout(r, 700))
    if (!((surfaceBox()?.height ?? 0) > 0)) throw new Error('重新打开后浏览器磁贴没有恢复')
    if (!store.getState().browserNativeVisible) throw new Error('重新打开后原生网页没有恢复')
    if ((await window.yan.browser.getState()).activeTabId !== tabId) throw new Error('恢复磁贴改变了活动网页')
  }

  return JSON.stringify({ open: state.open, hasUrl: Boolean(state.url), workspaceTile: true, centerUnchanged: !centerMode, title: state.title, generation: observation.generationId, elements: observation.elements.length, tabs: finalState.tabs?.length || 0, viewport: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, finalViewport: finalRect && { x: finalRect.x, y: finalRect.y, width: finalRect.width, height: finalRect.height }, nativeBounds: finalState.nativeBounds })
})()
