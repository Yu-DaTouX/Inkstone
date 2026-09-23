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
  /* 新标签不能把用户正在看的页面夺走：切回去必须是原标签 */
  const backState = await window.yan.browser.getState()
  if (backState.activeTabId !== firstTab) {
    throw new Error(`切回原标签失败（阅读页被新标签夺走）：${backState.activeTabId} != ${firstTab}`)
  }
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

    /*
     * H-9 第二阶段：失败要给出“为什么 + 怎么办”，并保留原地址。
     * 只显示一句错误码等于让用户去猜。
     */
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

    /* 重试真的重新发起导航（不是把错误清掉了事）：仍连不上 → 仍在失败态 */
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 2500))
    if (!document.querySelector('[data-testid="browser-load-error"]')) {
      throw new Error('重试后失败态消失，像是假装成功了')
    }

    /*
     * 草稿与已提交地址分离：用户正在输入时，后台导航不得冲掉输入。
     * 这里从 push 通道送一个新地址进去（与主进程发 state 的路径相同），
     * 断言输入框仍是草稿。
     */
    const store = window.__yanStore
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

    /*
     * 多标签归属（H-9 第二阶段）：错误与地址都属于**活动标签**。
     * 切到正常页面不能把上一个标签的错误带过去，切回来也不能丢。
     */
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
    /* 收尾：把失败态抹掉，不给后面的断言留一个不可用页面 */
    await window.yan.browser.navigate('https://example.com')
    await new Promise((resolve) => setTimeout(resolve, 1500))
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
   * H-3b：收起整个工作栏 = 连原生网页一起不可见（不再沿用「只藏工具栏、
   * 网页仍满列」的旧语义）。这里按住新回归点：收起后右栏不在布局里，
   * 原生网页也不可见；展开后资源与页面都恢复。
   */
  const surfaceBox = () => document.querySelector('[data-testid="browser-surface"]')?.getBoundingClientRect()
  const panelToggle = document.querySelector('[data-testid="rightpanel-toggle"]')
  if (panelToggle) {
    panelToggle.click()
    await new Promise((r) => setTimeout(r, 700))
    const panelGone = !document.querySelector('[data-testid="rightpanel"]')
    const afterH = surfaceBox()?.height ?? 0
    if (!panelGone) throw new Error('收起右栏后工作栏仍在布局里')
    if (afterH > 0) throw new Error(`收起右栏后原生网页没有隐藏，仍有高度 ${afterH}`)
    panelToggle.click()
    await new Promise((r) => setTimeout(r, 700))
    if (!((surfaceBox()?.height ?? 0) > 0)) throw new Error('重新展开后浏览器没有恢复')
  }

  return JSON.stringify({ open: state.open, hasUrl: Boolean(state.url), rightPanel: true, centerUnchanged: !centerMode, title: state.title, generation: observation.generationId, elements: observation.elements.length, tabs: finalState.tabs?.length || 0, viewport: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, finalViewport: finalRect && { x: finalRect.x, y: finalRect.y, width: finalRect.width, height: finalRect.height }, nativeBounds: finalState.nativeBounds })
})()
