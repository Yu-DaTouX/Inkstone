/*
 * 工具磁贴跨重启（实施-12 U-6，第二次启动，cost 0）。
 *
 * 由 `test-live` 的 `restart` 分支拉起：同一份 YAN_DATA_DIR / YAN_USER_DATA，
 * 全新进程。要证明的是「浮动位置不是内存态」：
 *   · 读盘回来的 toolLayout 里 context 仍是 floating，rect 与上一次一致；
 *   · 界面真的把它渲染出来了（不是只躺在设置里）；
 *   · 默认布局没有被重启悄悄改写（其余项仍在停靠位）。
 *
 * 结束时恢复默认布局，不污染这份隔离设置。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const until = async (fn, ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(150)
    }
    return false
  }
  const store = window.__yanStore
  const ALL = ['todo', 'context', 'files', 'quota', 'queue', 'ext', 'log', 'actions']

  try {
    for (let i = 0; i < 60; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    const handoff = JSON.parse(localStorage.getItem('yan.tile-restart-probe') ?? 'null')
    ok(!!handoff, '第一次启动的交接数据可读')

    const tile = (store.getState().settings?.toolLayout?.tiles ?? []).find((t) => t.id === 'context')
    ok(tile?.placement === 'floating', '重启后 context 仍是浮动（从磁盘读回）')
    ok(
      !!tile?.rect && Math.abs(tile.rect.x - handoff.rect.x) < 1e-6 && Math.abs(tile.rect.y - handoff.rect.y) < 1e-6,
      `重启后浮动坐标与上次一致（x=${tile?.rect?.x}）`
    )
    ok(
      (store.getState().settings?.toolLayout?.tiles ?? []).filter((t) => t.placement === 'floating').length === 1,
      '只有 context 一个浮动项，其余仍在停靠位'
    )
    await until(() => !!q('[data-testid="float-tile-context"]'), 8000)
    ok(!!q('[data-testid="float-tile-context"]'), '重启后界面真的把它渲染成浮动磁贴')
    ok(!q('.rp-slot[data-tool-id="context"]'), '重启后工具页没有第二份 context 实例')

    /* 恢复默认：重启后的清理也要走同一份布局契约 */
    const cur = store.getState().settings?.toolLayout
    await store.getState().setToolLayout({
      version: 2,
      revision: (cur?.revision ?? 0) + 1,
      tiles: ALL.map((id, i) => ({ id, placement: 'docked', order: i }))
    })
    await sleep(500)
    ok(!q('[data-testid="float-tile-context"]'), '恢复默认后没有浮动项')
    localStorage.removeItem('yan.tile-restart-probe')
    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
