/* Narrow right-panel tabs must preserve separate icon, label, close and add targets. */
;(async () => {
  const out = []
  const check = (value, name) => out.push(`  ${value ? '✓' : '✗'} ${name}`)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, ms = 5000) => {
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
    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    await until(() => !!document.querySelector('[data-testid="right-window-tabs"]'))
    await store.getState().previewFile('C:/__inkstone_right_tab_width_probe__.md')
    check(await until(() => !!document.querySelector('[data-testid="right-window-tab-file"]')), '打开文件后出现第二个窗口标签')

    const bar = document.querySelector('[data-testid="right-window-tabs"]')
    const start = document.querySelector('[data-testid="right-window-tab-start"]')
    const file = document.querySelector('[data-testid="right-window-tab-file"]')
    const plus = document.querySelector('[data-testid="right-tool-menu"]')
    const startIcon = start?.querySelector('svg')
    const startText = start?.querySelector('.rp-title')
    const fileIcon = file?.querySelector('svg')
    const fileText = file?.querySelector('span')
    const fileClose = file?.querySelector('.ui-tab-close')
    out.push(`  窗口 ${innerWidth}px；右栏 ${Math.round(box(bar)?.width ?? 0)}px；标签 ${Math.round(box(start)?.width ?? 0)} / ${Math.round(box(file)?.width ?? 0)}px`)
    check(clear(startIcon, startText) && (box(startText)?.width ?? 0) >= 20, '检查器图标与标题留有独立空间')
    check(clear(fileIcon, fileText) && clear(fileText, fileClose) && (box(fileText)?.width ?? 0) >= 16, '文件图标、标题和关闭按钮不相叠')
    check(!!plus && box(plus).right <= box(bar).right + 1 && box(plus).left >= box(bar).left, '新增按钮在可见窗口栏内')
    check(!!start?.getAttribute('title'), '截断时仍能读到检查器完整标题')
    start?.click()
    await sleep(150)
    const contextHead = document.querySelector('[data-testid="rp-context"] .rp-sec-head')
    if (contextHead?.getAttribute('aria-expanded') !== 'true') contextHead?.click()
    await sleep(500)
    const compact = document.querySelector('[data-testid="rp-compact-now"]')
    const panel = document.querySelector('[data-testid="rightpanel"]')
    check(!!compact && box(compact).width >= 40 && box(compact).left >= box(panel).left && box(compact).right <= box(panel).right + 1, '压缩按钮在最窄右栏仍可见可点')
    check([...document.querySelectorAll('.rp-grip')].every((grip) => grip.offsetParent === grip.closest('.rp-sec-row')), '排序把手分别定位在各自标题内')
    const session = store.getState().session
    store.setState({ session: { ...session, isCompacting: true } })
    await sleep(200)
    check(!!document.querySelector('.rp-header-compacting .ui-run-dot') && !document.querySelector('.rp-header-compacting .ui-spin'), '压缩摘要使用静态 RunDot')
    store.setState({ session })
    return out.join('\n')
  } catch (error) {
    return `${out.join('\n')}\n  ✗ 探针异常：${error?.message ?? String(error)}`
  }
})()
