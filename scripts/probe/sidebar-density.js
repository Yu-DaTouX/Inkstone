;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  for (let i = 0; i < 80; i++) {
    if (document.querySelector('[data-testid="v3-sidebar"]') && store.getState().settings) break
    await sleep(200)
  }
  await sleep(800)
  const s = store.getState()
  store.getState().setSettings({ ...s.settings, density: 'comfortable' })
  const cwd = s.sessions[0]?.cwd ?? s.cwd ?? 'E:/demo'
  const titles = ['完整重构方案', 'OpenClaude右侧面板设计对比', '子代理实现与宿主通知时机', 'Agent搜索功能', '界面审查', '模型正式文字流式输出问题', 'WiFi 和以太网连接故障', '界面显示过小', '网络卡顿问题排查', '美国免费VPS搭建', '子代理天气查询', '缓存命中率分析']
  const now = Date.now()
  const fake = titles.map((title, i) => ({ id: `fake-${i}`, path: `${cwd}/fake-${i}.jsonl`, cwd, title, named: true, createdAt: now - i * 60_000, updatedAt: now - i * 60_000, lastActivityAt: now - i * 60_000, messageCount: 4 }))
  const inject = () => store.setState({ sessions: [...fake, ...store.getState().sessions.filter((x) => !String(x.id).startsWith('fake-'))] })
  inject()
  const aside = () => document.querySelector('[data-testid="v3-sidebar"]')
  const measure = () => {
    const rows = [...document.querySelectorAll('.v3-srow')].slice(0, 6).map((el) => Math.round(el.getBoundingClientRect().height))
    const tops = [...document.querySelectorAll('.v3-srow')].slice(0, 6).map((el) => Math.round(el.getBoundingClientRect().top))
    const pitch = tops.length > 1 ? (tops[tops.length - 1] - tops[0]) / (tops.length - 1) : 0
    const title = document.querySelector('.v3-srow .v3-row-title')
    const nav = [...(aside()?.querySelectorAll('nav a, nav button, .v3-nav-item, [role="link"]') ?? [])].slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().height))
    return { density: document.documentElement.dataset.density, scope: aside()?.dataset.densityScope ?? null, rows, pitch, font: title ? getComputedStyle(title).fontSize : null, nav, sessionsShown: document.querySelectorAll('.v3-srow').length }
  }
  const out = {}
  aside()?.removeAttribute('data-density-scope')
  await sleep(500)
  inject()
  out.before = measure()
  await sleep(7000)
  aside()?.setAttribute('data-density-scope', 'compact')
  await sleep(500)
  out.after = measure()
  await sleep(8000)
  const lines = [JSON.stringify(out)]
  const check = (good, label) => lines.push(`${good ? '  \u2713 ' : '  \u2717 '}${label}`)
  check(out.after.density === 'comfortable' && out.after.scope === 'compact', '舒适档下左栏使用 compact 密度作用域')
  check(out.after.pitch > 0 && out.after.pitch < out.before.pitch, `会话行间距变小（${out.before.pitch}\u2192${out.after.pitch}）`)
  check(parseFloat(out.after.font) < parseFloat(out.before.font), `会话标题字号变小（${out.before.font}\u2192${out.after.font}）`)
  return lines.join('\n')
})()
