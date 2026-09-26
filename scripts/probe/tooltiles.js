/*
 * 工具磁贴：位置切换、单实例、键盘与拖动（实施-12 U-4 / U-5，cost 0）。
 *
 * 这一片最容易「看起来对、其实静默坏掉」的点：
 *   ① 一个 id 出现两份实例（工具页一份、浮动层一份）—— 两边都订阅、都发请求；
 *   ② 键盘移动与拖放各写一套放置逻辑，结果两套行为不一致；
 *   ③ 拖动每帧写盘 / 取消也写盘，重现「拖动中被旧布局抢回」；
 *   ④ 越界 rect 让磁贴跑到屏外（缩窗后找不回来）。
 *
 * 探针只走 UI 与 store 的公开入口；结束时恢复默认布局，不污染真实设置。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore
  const ALL = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions']
  const layoutNow = () => store.getState().settings?.toolLayout
  const placementOf = (id) => (layoutNow()?.tiles ?? []).find((t) => t.id === id)?.placement
  const revision = () => layoutNow()?.revision ?? 0
  const putLayout = async (tiles) => {
    await store.getState().setToolLayout({ version: 2, revision: revision() + 1, tiles })
    await sleep(650)
  }
  const resetLayout = () =>
    putLayout(ALL.map((id, i) => ({ id, placement: 'docked', order: i })))
  const floatRectOf = (id) => (layoutNow()?.tiles ?? []).find((t) => t.id === id)?.rect

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(300)
      } else await sleep(150)
    }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await resetLayout()
    click(q('[data-testid="right-window-tab-start"]'))
    await until(() => qa('.rp-body > .rp-slot').length > 0, 4000)
    await sleep(400)

    out.push('=== 1. 工具库已撤下（实施-20 U5）===')
    ok(!q('[data-testid="tool-lib-btn"]'), '工具库入口不存在')
    ok(!q('[data-testid="tool-lib"]'), '工具库弹层不存在')
    /* 移出为浮动的入口改由分区把手的键盘路径承担（下面 section 2 验证） */
    ok(!!q('[data-testid="grip-todo"]') && !!q('[data-testid="grip-files"]'), '分区把手仍在')

    out.push('\n=== 2. 键盘移出为浮动（单实例） ===')
    const gq = q('[data-testid="grip-queue"]')
    gq?.focus()
    gq?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }))
    await until(() => !!q('[data-testid="float-tile-queue"]'), 4000)
    await sleep(300)
    ok(!!q('[data-testid="float-tile-queue"]'), '浮动磁贴已渲染')
    ok(!q('.rp-slot[data-tool-id="queue"]'), '工具页里的 queue 内容不再渲染（不是两份实例）')
    ok(qa('[data-testid="float-tile-queue"]').length === 1, '同一 id 只有一个浮动实例')
    ok(!!q('[data-testid="float-ph-queue"]'), '工具页保留「已浮动」轻量占位')
    ok(placementOf('queue') === 'floating', 'toolLayout 已落盘 floating')
    const r0 = floatRectOf('queue')
    ok(!!r0 && r0.w > 0 && r0.h > 0, `浮动 rect 已记录（w=${r0?.w?.toFixed(3)}）`)

    out.push('\n=== 3. 键盘路径：Alt+← 移出 / Alt+→ 放回（与按钮同一条命令） ===')
    const grip = q('[data-testid="grip-context"]')
    grip?.focus()
    grip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }))
    await until(() => !!q('[data-testid="float-tile-context"]'), 4000)
    ok(!!q('[data-testid="float-tile-context"]'), 'Alt+← 把 context 移出为浮动')
    const head = q('[data-testid="float-head-context"]')
    ok(!!head, '浮动磁贴有可拖动的头部')
    // 键盘没法直接作用在浮动头上（无把手），放回走 float-dock 按钮 / 工具库
    click(q('[data-testid="float-dock-context"]'))
    await until(() => placementOf('context') === 'docked', 4000)
    ok(placementOf('context') === 'docked', '浮动头上的「放回工具页」按钮生效')
    ok(!q('[data-testid="float-tile-context"]'), '放回后浮动实例消失')

    out.push('\n=== 4. 拖动浮动磁贴：只 commit 时写盘 ===')
    const tile = q('[data-testid="float-tile-queue"]')
    const head2 = q('[data-testid="float-head-queue"]')
    const beforeDrag = floatRectOf('queue')
    const box = tile.getBoundingClientRect()
    const pe = (type, x, y, buttons) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 21,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y
      })
    const startX = head2.getBoundingClientRect().left + 40
    const startY = head2.getBoundingClientRect().top + 16
    head2.dispatchEvent(pe('pointerdown', startX, startY, 1))
    await sleep(60)
    /* 先移 3px（低于 6px 阈值）：不该进入 dragging */
    head2.dispatchEvent(pe('pointermove', startX + 3, startY + 2, 1))
    await sleep(50)
    const duringThreshold = floatRectOf('queue')
    ok(JSON.stringify(duringThreshold) === JSON.stringify(beforeDrag), '阈值内的移动不写盘')
    for (let i = 1; i <= 10; i++) {
      head2.dispatchEvent(pe('pointermove', startX + i * 9, startY + i * 6, 1))
    }
    await sleep(80)
    const mid = q('[data-testid="float-tile-queue"]')
    const midRect = mid.getBoundingClientRect()
    ok(Math.abs(midRect.left - box.left) > 20, '拖动中磁贴跟手移动')
    head2.dispatchEvent(pe('pointerup', startX + 90, startY + 60, 0))
    await until(() => JSON.stringify(floatRectOf('queue')) !== JSON.stringify(beforeDrag), 4000)
    const afterDrag = floatRectOf('queue')
    ok(JSON.stringify(afterDrag) !== JSON.stringify(beforeDrag), '放开后新位置落盘')

    out.push('\n=== 4b. 拖动中的吸附对齐 + 参考线 ===')
    const tSnap = q('[data-testid="float-tile-queue"]')
    const hSnap = q('[data-testid="float-head-queue"]')
    const bSnap = tSnap.getBoundingClientRect()
    const sxSnap = hSnap.getBoundingClientRect().left + 40
    const sySnap = hSnap.getBoundingClientRect().top + 16
    /* 目标：磁贴**右缘**贴工作区右缘（差 4px，在 8px 阈值内 → 应该被吸过去） */
    const wsBox = document.querySelector('.workspace').getBoundingClientRect()
    const wantRight = wsBox.left + wsBox.width - bSnap.width + 4
    hSnap.dispatchEvent(pe('pointerdown', sxSnap, sySnap, 1))
    await sleep(50)
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      hSnap.dispatchEvent(pe('pointermove', sxSnap + ((wantRight - bSnap.left) * i) / steps, sySnap + 6 * i, 1))
    }
    await sleep(120)
    const guides = qa('[data-testid="float-snap-guide"]')
    ok(guides.length > 0, '拖动中画出吸附参考线')
    ok(
      guides.some((g) => g.getAttribute('data-axis') === 'x'),
      '水平参考线标出「吸到了哪条竖线」'
    )
    const snappedRect = q('[data-testid="float-tile-queue"]').getBoundingClientRect()
    ok(
      Math.abs(snappedRect.left - (wantRight - 4)) <= 1,
      '右缘真的贴到工作区右缘（吸附生效，误差 ' + Math.abs(snappedRect.left - (wantRight - 4)).toFixed(1) + 'px）'
    )
    hSnap.dispatchEvent(pe('pointerup', sxSnap + (wantRight - bSnap.left), sySnap + 72, 0))
    await sleep(400)
    ok(qa('[data-testid="float-snap-guide"]').length === 0, '松手后参考线消失（不留在界面上）')

    /* 吸到整个工作区右缘时，指针可能同时落在右栏；松手按产品规则会停靠。
       Esc 场景需要浮动磁贴，先用同一份已记录 rect 恢复测试前提。 */
    if (placementOf('queue') !== 'floating') {
      await putLayout((layoutNow()?.tiles ?? []).map((t) =>
        t.id === 'queue' ? { ...t, placement: 'floating', rect: afterDrag } : t
      ))
    }
    ok(await until(() => !!q('[data-testid="float-tile-queue"]'), 4000), 'Esc 场景开始前磁贴仍在浮动层')

    out.push('\n=== 5. Esc 取消：不写盘、位置还原 ===')
    const beforeEsc = floatRectOf('queue')
    const revBefore = revision()
    const t2 = q('[data-testid="float-tile-queue"]')
    const h3 = q('[data-testid="float-head-queue"]')
    const b3 = t2.getBoundingClientRect()
    const sx = h3.getBoundingClientRect().left + 40
    const sy = h3.getBoundingClientRect().top + 16
    h3.dispatchEvent(pe('pointerdown', sx, sy, 1))
    await sleep(50)
    for (let i = 1; i <= 8; i++) h3.dispatchEvent(pe('pointermove', sx - i * 8, sy - i * 5, 1))
    await sleep(60)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    h3.dispatchEvent(pe('pointercancel', sx - 64, sy - 40, 0))
    await sleep(500)
    ok(JSON.stringify(floatRectOf('queue')) === JSON.stringify(beforeEsc), 'Esc / cancel 后位置还原')
    ok(revision() === revBefore, '取消不产生新的 layout 写入')
    const t3 = q('[data-testid="float-tile-queue"]').getBoundingClientRect()
    ok(Math.abs(t3.left - b3.left) < 1, '视觉上也回到原位置')

    out.push('\n=== 6. 越界 rect 夹取：缩窗不丢磁贴 ===')
    await putLayout(
      (layoutNow()?.tiles ?? ALL.map((id, i) => ({ id, placement: 'docked', order: i }))).map((t) =>
        t.id === 'queue' ? { ...t, placement: 'floating', rect: { x: 1, y: 1, w: 0.3, h: 0.3 } } : t
      )
    )
    await until(() => !!q('[data-testid="float-tile-queue"]'), 4000)
    await sleep(300)
    const ws = q('.workspace').getBoundingClientRect()
    const tr = q('[data-testid="float-tile-queue"]').getBoundingClientRect()
    ok(tr.right <= ws.right + 1 && tr.bottom <= ws.bottom + 1, '越界坐标被夹回内容区（不丢到屏外）')
    ok(tr.left >= ws.left - 1 && tr.top >= ws.top - 1, '夹取后左上角仍可见')

    out.push('\n=== 7. 拖回工具页：栏内出现插入位置 ===')
    /*
     * 浮窗本体拖动时是「跟着指针走的真磁贴」，但栏内的槽位不在这个组件的
     * DOM 里 —— 松手会插到哪，以前完全没有提示。现在它与栏内重排共用
     * store 里的落点，画同一条插入线。
     */
    await until(() => !!q('[data-testid="float-tile-queue"]'), 4000)
    const h4 = q('[data-testid="float-head-queue"]')
    const hr4 = h4.getBoundingClientRect()
    const firstSlot = document.querySelector('.rp-body > .rp-slot')
    const sr4 = firstSlot?.getBoundingClientRect()
    const bx = hr4.left + 40
    const by = hr4.top + 16
    const cx = sr4 ? sr4.left + sr4.width / 2 : bx
    const cy = sr4 ? sr4.top + sr4.height / 2 : by
    const lineAt = () =>
      [...document.querySelectorAll('.rp-slot')].find((el) => el.dataset.over === 'before' || el.dataset.over === 'after')
    h4.dispatchEvent(pe('pointerdown', bx, by, 1))
    await sleep(50)
    for (let i = 1; i <= 10; i++) {
      h4.dispatchEvent(pe('pointermove', bx + ((cx - bx) * i) / 10, by + ((cy - by) * i) / 10, 1))
    }
    await sleep(120)
    const line4 = lineAt()
    if (line4) ok(true, '拖回工具页时栏内出现插入位置（' + line4.dataset.toolId + ' ' + line4.dataset.over + '）')
    else bad('拖回工具页时没有插入位置预览')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    h4.dispatchEvent(pe('pointercancel', cx, cy, 0))
    await sleep(400)
    ok(!lineAt(), '取消后插入位置已撤掉')

    out.push('\n=== 8. 右栏收起，浮动磁贴不跟着消失 ===')
    await store.getState().toggleRightPanel()
    await sleep(500)
    ok(!!q('[data-testid="float-tile-queue"]'), '收起右栏后浮动磁贴仍在')
    await store.getState().toggleRightPanel()
    await sleep(400)

    out.push('\n=== 9. 恢复默认：布局回停靠，业务数据不动 ===')
    const todosBefore = store.getState().todos.length
    await resetLayout()
    await sleep(500)
    ok(!q('[data-testid="float-tile-queue"]'), '恢复默认后没有浮动项')
    ok(placementOf('queue') === 'docked' && placementOf('context') === 'docked', '全部回到工具页')
    ok((layoutNow()?.tiles ?? []).every((t) => t.placement !== 'library'), '库位已清空')
    ok(store.getState().todos.length === todosBefore, '恢复默认不改业务数据（任务数不变）')
    if (q('[data-testid="tool-lib"]')) click(q('[data-testid="tool-lib-btn"]'))

    return out.join('\n')
  } catch (error) {
    out.push('  ✗ 探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
