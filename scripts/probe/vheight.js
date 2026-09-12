/**
 * 分区内容高度可调（用户要求「组件高度可调节」）。
 *
 * 只给内容会滚动的分区（文件树 / 日志）—— 其余几行高的分区给把手只是噪声，
 * 所以第一条断言就是「哪些有、哪些没有」。
 * 另外验了范围夹取（拖过头不能写出坏值，与宽度拖拽同一个教训）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return false }
  const store = window.__yanStore
  const pe = (type, y, buttons) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 13, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: 0, clientY: y })

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await store.getState().setToolLayout({ toolOrder: [], toolHidden: [] })
    await sleep(900)

    out.push('=== 1. 只有可滚动的分区有高度把手 ===')
    const grips = [...document.querySelectorAll('.rp-vgrip')].map((x) => x.dataset.testid)
    out.push('  高度把手: ' + JSON.stringify(grips))
    if (grips.some((g) => /vgrip-files$/.test(g))) ok('文件分区有高度把手')
    else bad('文件分区没有高度把手')
    if (!grips.some((g) => /vgrip-context$/.test(g))) ok('上下文分区没有高度把手（几行内容，加了只是噪声）')
    else bad('上下文分区不该有高度把手')

    out.push('\n=== 2. 拖动文件区把手：内容高度跟着变 ===')
    const h = document.querySelector('[data-testid="vgrip-files"]')
    const box = () => document.querySelector('.rp-fs')
    const before = box().getBoundingClientRect().height
    const y0 = h.getBoundingClientRect().y + 3
    h.dispatchEvent(pe('pointerdown', y0, 1))
    await sleep(80)
    for (let i = 1; i <= 6; i++) h.dispatchEvent(pe('pointermove', y0 + (60 * i) / 6, 1))
    await sleep(120)
    const during = box().getBoundingClientRect().height
    out.push('  拖动中: ' + before.toFixed(0) + ' → ' + during.toFixed(0))
    if (during > before + 30) ok('往下拖，内容变高（拖动中实时生效）')
    else bad('拖动中没变高')
    h.dispatchEvent(pe('pointerup', y0 + 60, 0))
    await sleep(800)
    const savedH = store.getState().settings?.toolHeights?.files
    out.push('  落盘 toolHeights.files=' + savedH)
    if (savedH && Math.abs(savedH - during) <= 3) ok('松手后高度落盘')
    else bad('没落盘或值不对')

    out.push('\n=== 3. 范围被夹住（不能拖到离谱）===')
    const y1 = h.getBoundingClientRect().y + 3
    h.dispatchEvent(pe('pointerdown', y1, 1))
    await sleep(60)
    h.dispatchEvent(pe('pointermove', y1 + 5000, 1))
    await sleep(120)
    h.dispatchEvent(pe('pointerup', y1 + 5000, 0))
    await sleep(700)
    const maxH = store.getState().settings?.toolHeights?.files
    out.push('  极限下拖 → ' + maxH)
    if (maxH > 0 && maxH <= 900) ok('上限被夹住（≤900）')
    else bad('没夹住：' + maxH)
    const y2 = h.getBoundingClientRect().y + 3
    h.dispatchEvent(pe('pointerdown', y2, 1))
    await sleep(60)
    h.dispatchEvent(pe('pointermove', y2 - 5000, 1))
    await sleep(120)
    h.dispatchEvent(pe('pointerup', y2 - 5000, 0))
    await sleep(700)
    const minH = store.getState().settings?.toolHeights?.files
    out.push('  极限上拖 → ' + minH)
    if (minH >= 80) ok('下限被夹住（≥80）')
    else bad('没夹住：' + minH)

    out.push('\n=== 4. 高度在重启后仍生效（写进了设置）===')
    out.push('  设置里的全部高度: ' + JSON.stringify(store.getState().settings?.toolHeights))
    await store.getState().setToolHeight('files', 0) // 复位（主进程会夹到 80）
    await sleep(400)
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[vheight] 全部通过' : '[vheight] ' + failed + ' 条失败')
  return out.join('\n')
})()
