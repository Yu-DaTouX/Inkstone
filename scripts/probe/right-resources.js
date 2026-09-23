/*
 * 右栏资源保留（实施-11 H-2）。
 *
 * 用户报的问题：切右栏标签会把**已经打开的资源**一起关掉 ——
 * `switchWindow('tools')` 过去直接 `closeBrowser()`，而 `BrowserManager.close()`
 * 会关掉内部所有网页并断开外部 Chrome。表面标签还在，资源却已经没了。
 *
 * 现在的契约（RightPanel.switchWindow / closeWindow）：
 *   · 切页 = 只隐藏原生视图，**保留**浏览器 / 审查 / 文件预览；
 *   · 关闭标签 = 才释放对应资源（且只释放那一个）；
 *   · 收起右栏 = 只改布局，不改变任何资源。
 *
 * cost 0：浏览器用 `about:blank`，文件用会话 cwd 里的 README，不调模型。
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
  const tab = (name) => click(`[data-testid="right-window-tab-${name}"]`)

  try {
    for (let i = 0; i < 80; i++) {
      if (st().conn === 'ready' && st().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    /* 先确保右栏是展开的，否则标签行根本不在 DOM 里。 */
    if (!st().settings?.rightPanelOpen) await st().setRightPanelOpen(true)
    await sleep(600)

    const cwd = st().session?.cwd ?? '.'
    out.push(`  会话 cwd = ${cwd}`)
    ok(!!q('[data-testid="right-window-tabs"]'), '右栏窗口标签行在（右栏已展开）')

    /* ---- 1. 打开浏览器，切走再切回 ---- */
    out.push('')
    out.push('=== 1. 浏览器：切页不销毁 ===')
    await st().openBrowser('about:blank')
    await sleep(1200)
    ok(!!st().browserState.open, '浏览器已打开（about:blank）')
    const url1 = st().browserState.url
    const tabs1 = (st().browserState.tabs ?? []).length
    out.push(`  打开后：url=${JSON.stringify(url1)} tabs=${tabs1}`)

    tab('tools')
    await sleep(500)
    ok(!!st().browserState.open, '切到「工具」后浏览器**没有**被关闭（核心回归点）')
    ok(st().browserState.url === url1, '地址没变（页面没有被重建）')

    tab('file')
    await sleep(500)
    ok(!!st().browserState.open, '切到「文件」后浏览器仍在')

    tab('browser')
    await sleep(700)
    ok(!!st().browserState.open && st().browserState.url === url1, '切回「浏览器」还是同一个页面')

    /* ---- 2. 审查与浏览器并存 ---- */
    out.push('')
    out.push('=== 2. 审查 / 文件与浏览器并存 ===')
    st().openReview()
    await sleep(400)
    tab('tools')
    await sleep(400)
    ok(!!st().reviewOpen, '切到「工具」后审查资源仍在（不是被关掉）')
    ok(!!st().browserState.open, '审查打开后浏览器仍保留')

    /* ---- 3. 文件预览 ---- */
    await st().previewFile('README.md', undefined, cwd)
    await sleep(900)
    const fp1 = st().filePreview?.path ?? ''
    ok(!!fp1, `文件预览已打开（path=${fp1 || '-'}）`)
    tab('tools')
    await sleep(400)
    ok(st().filePreview?.path === fp1, '切到「工具」后文件预览仍在')
    ok(!!st().browserState.open && !!st().reviewOpen, '三个资源同时保留（浏览器 + 审查 + 文件）')

    tab('browser')
    await sleep(600)
    ok(st().browserState.url === url1 && st().filePreview?.path === fp1, '来回切页后浏览器与文件都没丢')

    /* ---- 4. 收起右栏只改布局 ---- */
    out.push('')
    out.push('=== 4. 收起右栏不改变资源 ===')
    /*
     * 先确认一个**设计行为**：存在文件预览时，收起右栏会被自动展开
     *（`RightPanel` 的 effect：filePreview && !open → setRightPanelOpen(true)，
     * 因为文件窗口就在右栏里，收着等于用户看不到自己刚点的文件）。
     * 所以「收起后不占宽度」要在**没有文件预览**的情况下验。
     */
    await st().setRightPanelOpen(false)
    await sleep(700)
    out.push(`  有文件预览时收起：rightPanelOpen=${String(st().settings?.rightPanelOpen)}（自动展开，设计如此）`)
    ok(
      !!st().browserState.open && !!st().reviewOpen && !!st().filePreview,
      '这时浏览器 / 审查 / 文件预览三者都还在'
    )

    st().closePreview()
    await sleep(500)
    /*
     * H-3b：收起整个工作栏 = 连原生网页一起不可见，右栏渲染为 null（0 宽）。
     * 资源本身不销毁；展开后回到原来的活动页。
     */
    await st().setRightPanelOpen(false)
    await sleep(800)
    const collapsedEl = q('[data-testid="rightpanel"]')
    const collapsedW = collapsedEl ? Math.round(collapsedEl.getBoundingClientRect().width) : 0
    out.push(`  收起：rightpanel 在 DOM=${!!collapsedEl} 宽=${collapsedW}`)
    ok(!collapsedEl || collapsedW < 1, '收起右栏后右栏不占布局宽度（含原生网页）')
    ok(!!st().reviewOpen, '收起右栏后审查资源仍在（收起只改布局，不销毁资源）')
    ok(!!st().browserState.open, '收起右栏后浏览器资源仍在')
    ok(st().browserNativeVisible === false, '收起右栏时原生网页也不可见')

    await st().setRightPanelOpen(true)
    await sleep(700)
    ok(!!q('[data-testid="rightpanel"]'), '展开右栏后工作栏回到布局')
    ok(st().reviewOpen && st().browserState.open, '展开后资源都没丢')

    /* ---- 5. 显式关闭只释放对应的那一个 ---- */
    out.push('')
    out.push('=== 5. 显式关闭逐个释放 ===')
    /* 先把浏览器重新开起来，才能验“关浏览器只释放浏览器”。 */
    await st().openBrowser('about:blank')
    await sleep(1000)
    /* 审查也要重新打开（第 4 节验“收起”时把它关了），否则“关浏览器不影响审查”没有前提。 */
    st().openReview()
    await sleep(600)
    out.push(`  readPreview IPC 可用=${typeof window.yan?.readPreview}`)
    /*
     * 诊断：先直接写一次 store，看 filePreview 会不会被外部清掉。
     * 如果这一条能留住而 previewFile 留不住，就是 previewFile 自己的问题。
     */
    store.setState({ filePreview: { path: 'DIAG.md', cwd, loading: false, data: null } })
    await sleep(250)
    out.push(`  直接 set filePreview 后 250ms：${JSON.stringify(st().filePreview?.path ?? null)}`)
    st().closePreview()
    await sleep(300)
    await st().previewFile('README.md', undefined, cwd)
    out.push(
      `  调用 previewFile 后立即：${JSON.stringify(
        st().filePreview ? { path: st().filePreview.path, loading: st().filePreview.loading } : null
      )}`
    )
    await sleep(800)
    out.push(`  800ms 后：${String(!!st().filePreview)}`)
    out.push(`  关闭前：filePreview=${String(!!st().filePreview)} reviewOpen=${String(!!st().reviewOpen)}`)
    tab('browser')
    await sleep(500)
    out.push(`  切到浏览器标签后：filePreview=${String(!!st().filePreview)}`)
    const closedBrowser = click('[data-testid="right-window-tab-browser"] .review-tab-close')
    ok(closedBrowser, '浏览器标签上有显式关闭按钮')
    await sleep(1000)
    out.push(
      `  关浏览器后：browserOpen=${String(!!st().browserState.open)} reviewOpen=${String(!!st().reviewOpen)} ` +
        `filePreview=${String(!!st().filePreview)} 文件标签在 DOM=${!!q('[data-testid="right-window-tab-file"]')}`
    )
    ok(!st().browserState.open, '点关闭后浏览器真的被释放')
    ok(!!st().reviewOpen, '关浏览器不影响审查资源')
    ok(!!st().filePreview, '关浏览器不影响文件预览资源')

    const closedFile = click('[data-testid="right-window-tab-file"] .review-tab-close')
    ok(closedFile, '文件标签上有显式关闭按钮')
    await sleep(700)
    ok(!st().filePreview, '点关闭后文件预览被释放')
    ok(!!st().reviewOpen, '关文件不影响审查')

    const closedReview = click('[data-testid="review-tab"] .review-tab-close')
    ok(closedReview, '审查标签上有显式关闭按钮')
    await sleep(700)
    ok(!st().reviewOpen, '点关闭后审查被释放')
    ok(!!q('[data-testid="right-window-tab-start"]'), '全部关掉后固定导航仍在（回到开始页，不是空白）')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
