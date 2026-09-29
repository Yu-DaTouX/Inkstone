/*
 * 启动耗时：把渲染端的性能标记打出来（只测量，不断言，用于改动前后对比）。
 * 标记来自 store.bootstrap（yan:bootstrap-*、yan:boot:<请求名>）与 boot-splash（yan:splash-dismiss）。
 * 时间轴以页面导航起点为 0。
 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 100 && !performance.getEntriesByName('yan:splash-dismiss').length; i++) await sleep(100)
  const marks = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('yan:'))
  out.push('=== 启动标记（ms，自页面导航起点）===')
  for (const m of marks) out.push('  ' + m.name.padEnd(28) + Math.round(m.startTime))
  const t0 = performance.getEntriesByName('yan:bootstrap-start')[0]?.startTime ?? 0
  out.push('=== bootstrap 内各请求完成时刻（自 bootstrap 起点）===')
  for (const m of performance.getEntriesByType('measure').filter((x) => x.name.startsWith('yan:boot:'))) out.push('  ' + m.name.slice(9).padEnd(16) + Math.round(m.duration))
  const nav = performance.getEntriesByType('navigation')[0]
  if (nav) out.push('  DOM 就绪 ' + Math.round(nav.domContentLoadedEventEnd) + ' · load ' + Math.round(nav.loadEventEnd) + ' · bootstrap 起点 ' + Math.round(t0))
  out.push(performance.getEntriesByName('yan:splash-dismiss').length ? '  ✓ 启动画面已撤' : '  ✗ 启动画面 10 秒内没撤')
  return out.join('\n')
})()
