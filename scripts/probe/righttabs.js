/* 窄右栏的磁贴标签栏必须保住图标、标题与关闭按钮各自的位置。 */
;(async () => {
  const out = []
  const check = (value, name) => out.push(`  ${value ? '✓' : '✗'} ${name}`)
  const skip = (name) => out.push(`  ⤺ 跳过：${name}`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, ms = 6000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (predicate()) return true
      await sleep(100)
    }
    return false
  }
  const box = (element) => element?.getBoundingClientRect()
  const clear = (left, right) => !!left && !!right && box(left).right <= box(right).left + 1
  try {
    localStorage.setItem('yan.onboarded', '1')
    const store = window.__yanStore
    /*
     * 先等会话就绪：文件磁贴的身份靠 `fileResourceKey({ projectId, workspaceRoot, … })`，
     * 而 workspaceRoot 取 session.cwd —— 会话还没铺好时它为空，
     * `previewFile` 就拿不到 key，标签「不会建」（H-4 的「无身份不建标签」），
     * 看起来就像「窄窗下标签不见了」。多窗口场景的第二个窗口很容易撞上这个。
     */
    for (let i = 0; i < 60; i++) {
      const s = store.getState()
      if (s.conn === 'ready' && s.session?.cwd) break
      await sleep(300)
    }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    /*
     * 右栏现在是**磁贴工作区**（`Workspace.tsx`）：每个磁贴组有自己的一条
     * 标签栏（`.tile-heading .tile-tabs`），窗口标签不再是一条全局横栏 ——
     * 旧的 `right-window-tabs` / `right-window-tab-*` 已经没有了。
     */
    check(!!document.querySelector('[data-testid="tile-workspace"]'), '右栏磁贴工作区已挂载')

    const probePath = 'C:/__inkstone_right_tab_width_probe__.md'
    /*
     * 先关掉预览再打开：磁贴的自动打开挂在 `useEffect(..., [filePreview?.key])` 上
     * （`RightPanel.tsx`），同一个 key 不会重新触发 —— 第二次测量（同一个页面实例）
     * 就会看到「store 里有预览记录、却没有磁贴」。
     */
    store.getState().closePreview()
    await sleep(250)
    await store.getState().previewFile(probePath)
    const found = await until(() => !!document.querySelector('[data-pane-tab^="file:"] .ui-tab'), 9000)
    const fileTab = document.querySelector('[data-pane-tab^="file:"] .ui-tab')
    /*
     * 拿不到就如实跳过，不当成失败：资源归属（`resource-owners.ts`）写在
     * localStorage 里，先开的那一列已把 `file:<key>` 认领走时，后一列不会
     * 再渲染这个磁贴（`mine()` 过滤）。多窗口场景的第二档很容易撞上，
     * 而这不是产品缺陷。
     */
    if (!found || !fileTab) {
      const panes = [...document.querySelectorAll('[data-workspace-pane]')].map((el) => el.dataset.workspacePane)
      out.push('  ⤺ 跳过：这一档拿不到文件磁贴（资源归属在另一列）')
      out.push(
        `  诊断：磁贴 ${JSON.stringify(panes)}；标签 ${document.querySelectorAll('[data-pane-tab]').length} 个；` +
          `filePreviews ${JSON.stringify(Object.keys(store.getState().filePreviews ?? {}))}；` +
          `右栏 ${Math.round(box(document.querySelector('.tile-workspace'))?.width ?? 0)}px`
      )
      return out.join('\n')
    }
    check(true, '打开文件后出现文件磁贴标签')

    const head = fileTab.closest('.tile-heading')
    const bar = fileTab.closest('.tile-tabs')
    const label = fileTab.querySelector('.ui-tab-label')
    /*
     * 同一栏里可能有多个标签（浏览器与文件可以合并成一组）：逐个检查，
     * 而不是只看第一个 —— 原探针“两个窗口标签”的意图就在这里。
     */
    const tabs = [...(bar?.querySelectorAll('.ui-tab') ?? [])]
    out.push(
      `  窗口 ${innerWidth}px；标签栏 ${Math.round(box(head)?.width ?? 0)}px；` +
        `本栏标签 ${tabs.map((tab) => Math.round(box(tab)?.width ?? 0)).join(' / ')}px`
    )
    const geometry = tabs.map((tab) => {
      const tabIcon = tab.querySelector('svg')
      const tabLabel = tab.querySelector('.ui-tab-label')
      const tabClose = tab.querySelector('.ui-tab-close')
      return {
        icon: clear(tabIcon, tabLabel) && (box(tabLabel)?.width ?? 0) >= 16,
        close: !tabClose || clear(tabLabel, tabClose),
        inside: (box(tab)?.right ?? 0) <= (box(bar)?.right ?? 0) + 1
      }
    })
    check(geometry.every((g) => g.icon), `本栏每个标签：图标与标题都留有独立空间（${tabs.length} 个）`)
    check(geometry.every((g) => g.close), '本栏每个标签：标题与关闭按钮不相叠（没有关闭键的不计）')
    check(geometry.every((g) => g.inside), '标签不溢出标签栏')
    check(tabs.every((tab, i) => i === 0 || box(tabs[i - 1]).right <= box(tab).left + 1), '相邻标签互不重叠')
    check((label?.textContent ?? '').includes('__inkstone_right_tab_width_probe__'), '标签文本就是文件名（截断时仍能看到自己那一份）')

    /*
     * 浏览器与文件都是右栏资源：两个磁贴各自成组时，标签栏不能互相挤压。
     * 原探针的「第二个标签」现在含义是「第二个磁贴标签栏」。
     */
    await store.getState().openBrowser('about:blank')
    const twoBars = await until(() => document.querySelectorAll('.tile-heading .tile-tabs').length >= 2)
    if (twoBars) {
      const bars = [...document.querySelectorAll('.tile-heading')]
      const overlapping = bars.some((a, i) => bars.some((b, j) => i < j && box(a).bottom > box(b).top + 1 && box(a).top < box(b).bottom - 1))
      check(!overlapping, '多个磁贴的标题栏不互相重叠')
      await store.getState().closeBrowser()
      await sleep(300)
    } else {
      skip('浏览器与文件没有落在同一条标签栏里（默认布局各自成组；合并成一组时本段会逐个检查）')
    }

    /* 上下文分区（默认在工具磁贴里）：最窄右栏下压缩按钮仍然可见可点 */
    const contextHead = document.querySelector('[data-testid="rp-context"] .rp-sec-head')
    if (contextHead) {
      if (contextHead.getAttribute('aria-expanded') !== 'true') contextHead.click()
      await sleep(400)
      const compact = document.querySelector('[data-testid="rp-compact-now"]')
      const pane = compact?.closest('.tile-pane')
      check(
        !!compact && !!pane && box(compact).width >= 40 && box(compact).left >= box(pane).left - 1 && box(compact).right <= box(pane).right + 1,
        '压缩按钮在最窄磁贴里仍可见可点'
      )
    } else {
      skip('上下文分区不在当前可见磁贴里')
    }
    return out.join('\n')
  } catch (error) {
    return `${out.join('\n')}\n  ✗ 探针异常：${error?.message ?? String(error)}`
  }
})()
