;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(80) } return false }
  const store = window.__yanStore
  const box = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0), vis: cs.visibility, disp: cs.display }
  }
  const visible = (b) => !!b && b.disp !== 'none' && b.vis !== 'hidden' && b.w > 0 && b.h > 0

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(800)

    out.push('=== 0. 环境 ===')
    out.push('  窗口 ' + window.innerWidth + '×' + window.innerHeight + '  设备像素比 ' + devicePixelRatio)
    const centerW = box('.center')?.w ?? 0
    out.push('  三栏: rail=' + (box('.rail-slot')?.w ?? 0) + ' center=' + centerW + ' right=' + (box('.rightpanel, .rightstub')?.w ?? 0))
    if (centerW > 260) ok('中栏还有可用宽度（' + centerW + 'px）')
    else bad('中栏被挤到 ' + centerW + 'px（输入框会看不见）')

    out.push('\n=== 1. 展开态：输入框必须在 ===')
    const c1 = box('[data-testid="composer"]')
    out.push('  composer = ' + JSON.stringify(c1))
    if (visible(c1)) ok('输入框可见（' + c1.w + '×' + c1.h + '）')
    else bad('输入框不可见！' + JSON.stringify(c1))

    out.push('\n=== 2. 左栏收起：按钮位置 + 输入框 ===')
    const exp = box('[data-testid="rail-toggle"]')
    out.push('  展开态开关 ' + JSON.stringify(exp))
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await sleep(700)
    const toggleNow = box('[data-testid="rail-toggle"]')
    out.push('  收起后标题栏开关 ' + JSON.stringify(toggleNow))
    if (toggleNow && exp && toggleNow.x === exp.x && toggleNow.y === exp.y) ok('收起后开关没动（入口始终在标题栏）')
    else bad('开关位置变了：' + JSON.stringify(exp) + ' → ' + JSON.stringify(toggleNow))
    if (toggleNow && toggleNow.w >= 20) ok('开关有可点尺寸（' + toggleNow.w + 'px）')
    else bad('开关太小：' + JSON.stringify(toggleNow))

    const c2 = box('[data-testid="composer"]')
    out.push('  收起后 composer = ' + JSON.stringify(c2))
    if (visible(c2)) ok('左栏收起后输入框仍可见（' + c2.w + '×' + c2.h + '）')
    else bad('左栏收起后输入框不见了！' + JSON.stringify(c2))
    const centerW2 = box('.center')?.w ?? 0
    out.push('  收起后 center=' + centerW2 + '（展开时 ' + centerW + '）')
    if (centerW2 >= centerW) ok('收起左栏后中栏变宽（推挤式布局正确）')
    else bad('收起后中栏反而变窄：' + centerW + ' → ' + centerW2)

    const un = document.querySelector('[data-testid="rail-toggle"]')
    if (un) click(un)
    await until(() => store.getState().railPinned, 3000)
    await sleep(600)

    out.push('\n=== 3. 工具栏收起：开关位置 + 输入框 ===')
    const rpExp = box('[data-testid="right-tool-menu"]')
    await window.__yanOpenWorkspaceTool('文件', 'files')
    const rpUn = box('[data-testid="right-tool-menu"]')
    if (rpExp && rpUn && Math.abs(rpExp.x-rpUn.x)<1 && Math.abs(rpExp.y-rpUn.y)<1) ok('工作区入口位置不随磁贴打开改变')
    else bad('工作区入口移动')
    const pane = document.querySelector('[data-workspace-pane="files"]:not([hidden])')
    if (pane && pane.getBoundingClientRect().width >= 199) ok('窄窗文件磁贴保留最小阅读尺寸')
    else bad('文件磁贴没有可读宽度')
    document.querySelector('[data-pane-tab="files"]')?.querySelector('.ui-tab-close')?.click()
    await sleep(500)
    if (!document.querySelector('[data-workspace-pane="files"]:not([hidden])')) ok('文件磁贴可隐藏')
    else bad('文件磁贴仍可见')

    out.push('\n=== 4. 两侧都收起（最窄的可用状态）===')
    click(document.querySelector('[data-testid="rail-toggle"]'))
    await until(() => Math.abs((box('.rail-slot')?.w ?? -1)) < 1, 5000)
    const c4 = box('[data-testid="composer"]')
    const rw = box('.rail-slot')?.w ?? -1
    const gridCols = getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ')
    const pw = document.querySelector('[data-workspace-pane="files"]:not([hidden])')?.getBoundingClientRect().width ?? 0
    out.push('  rail=' + rw + ' right=' + pw + ' composer=' + JSON.stringify(c4))
    if (visible(c4)) ok('两侧都收起时输入框仍在（' + c4.w + '×' + c4.h + '）')
    else bad('两侧收起后输入框不见了！')
    out.push(`  收起后：rail=${rw}px panel=${pw}px`)
    if (rw < 1) ok(`左栏收起后 0 宽（${rw}px）`)
    else bad(`左栏收起后没让位：宽 ${rw}px（应为 0）`)
    if (pw === 0) ok('右栏收起后 0 宽（整个卸载，不占位）')
    else bad('右栏收起后仍有保留宽度：' + pw)

    store.getState().setRailPinned(true)
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[narrow] 全部通过' : '[narrow] ' + failed + ' 条失败')
  return out.join('\n')
})()
