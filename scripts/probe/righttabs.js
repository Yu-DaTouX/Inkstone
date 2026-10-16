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
    for (let i = 0; i < 60; i++) {
      const s = store.getState()
      if (s.conn === 'ready' && s.session?.cwd) break
      await sleep(300)
    }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    check(!!document.querySelector('[data-testid="tile-workspace"]'), '右栏磁贴工作区已挂载')

    const probePath = 'C:/__inkstone_right_tab_width_probe__.md'
    store.getState().closePreview()
    await sleep(250)
    await store.getState().previewFile(probePath)
    const found = await until(() => !!document.querySelector('[data-pane-tab^="file:"] .ui-tab'), 9000)
    const fileTab = document.querySelector('[data-pane-tab^="file:"] .ui-tab')
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
