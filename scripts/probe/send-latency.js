;(async () => {
  const out = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const composer = window.__yanComposer

  for (let i = 0; i < 60 && !store.getState().session?.model; i++) await sleep(300)
  out.push('模型：' + JSON.stringify(store.getState().session?.model?.id ?? store.getState().session?.model))

  const rows = []
  for (let n = 0; n < 1; n++) {
    const ta = q('[data-testid="composer-input"]')
    composer.set('只回复两个字：好的', ta)
    await sleep(300)
    const users0 = qa('.v3-msg.user').length
    const send = q('[data-testid="composer-send"]')
    const t = { click: performance.now() }
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const deadline = t.click + 90_000
    while (performance.now() < deadline) {
      const now = performance.now()
      if (!t.user && qa('.v3-msg.user').length > users0) t.user = now
      if (!t.run && store.getState().session?.isStreaming) t.run = now
      if (!t.act && q('[data-testid="v3-turn-activity"][data-working]')) t.act = now
      const reasonTxt = qa('.v3-think-peek, .v3-think-body').map((e) => e.textContent).join('')
      if (!t.think && reasonTxt.trim()) t.think = now
      const md = qa('.v3-msg.assistant .v3-prose').map((e) => e.textContent).join('')
      if (!t.text && md.trim()) t.text = now
      if (t.text && !store.getState().session?.isStreaming) {
        t.done = now
        break
      }
      await sleep(4)
    }
    const r = (k) => (t[k] ? Math.round(t[k] - t.click) : null)
    rows.push({ n: n + 1, 上屏: r('user'), 运行态: r('run'), 活动行: r('act'), 首推理: r('think'), 首正文: r('text'), 完成: r('done') })
    await sleep(1500)
  }
  out.push('耗时（ms，相对点击）：')
  for (const r of rows) out.push('  ' + JSON.stringify(r))
  return out.join('\n')
})()
