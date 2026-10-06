/* 小屏下输入区占窗口高度的比例（量几何，不断言）。 */
;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  for (let i = 0; i < 60; i++) {
    if (q('.rail') && store.getState().settings) break
    await sleep(200)
  }
  await sleep(1200)
  const h = (el) => (el ? +el.getBoundingClientRect().height.toFixed(1) : null)
  const vh = window.innerHeight
  const wrap = q('.composer-wrap')
  const parts = {
    窗口: vh,
    输入区整体: h(wrap),
    输入卡片: h(q('.composer')),
    输入框: h(q('[data-testid="composer"]')),
    工具条: h(q('.composer-bar')),
    标题栏: h(q('.titlebar')),
    状态栏: h(q('.statusbar')),
    对话区: h(q('.stream'))
  }
  out.push(`  窗口 ${window.innerWidth}×${vh}`)
  for (const [k, v] of Object.entries(parts)) out.push(`    ${k}: ${v}`)
  if (parts.输入区整体) out.push(`  输入区占窗口高度 ${((parts.输入区整体 / vh) * 100).toFixed(1)}%；对话区占 ${parts.对话区 ? ((parts.对话区 / vh) * 100).toFixed(1) : '?'}%`)
  return out.join('\n')
})()
