/*
 * 工具磁贴跨重启（实施-12 U-6，第一次启动，cost 0）。
 *
 * 第一次启动只做一件事：把 context 移出为浮动，并把「放到了哪」写进
 * localStorage 交给第二次启动的探针核对。真正的断言在
 * `tile-restart-restart.js` 里（新进程里才是「重启恢复」）。
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
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const store = window.__yanStore
  const ALL = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions']

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
    await until(() => !!store.getState().settings?.toolLayout, 6000)
    const cur = store.getState().settings?.toolLayout
    await store.getState().setToolLayout({
      version: 2,
      revision: (cur?.revision ?? 0) + 1,
      tiles: ALL.map((id, i) => ({
        id,
        placement: id === 'context' ? 'floating' : 'docked',
        order: i,
        ...(id === 'context' ? { rect: { x: 0.18, y: 0.22, w: 0.24, h: 0.36 } } : {})
      }))
    })
    await until(() => !!q('[data-testid="float-tile-context"]'), 6000)
    const tile = q('[data-testid="float-tile-context"]')
    ok(!!tile, '第一次启动：context 已浮动并渲染')
    const saved = store.getState().settings?.toolLayout?.tiles.find((t) => t.id === 'context')
    ok(saved?.placement === 'floating' && !!saved.rect, '浮动位置已写进设置')
    localStorage.setItem(
      'yan.tile-restart-probe',
      JSON.stringify({ rect: saved?.rect, revision: store.getState().settings?.toolLayout?.revision })
    )
    /* 顺手记一下坐标，重启后要逐项比对（归一化值不受窗口大小影响） */
    out.push('  交接给重启：' + localStorage.getItem('yan.tile-restart-probe'))
    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
