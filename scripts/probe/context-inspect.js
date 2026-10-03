/* 真实一轮对话后，上下文浮层应出现「固定部分明细」：系统提示分段 + 工具定义（context-inspect 薄层上报）。 */
;(async () => {
  const out = []
  const ok = (v, label) => out.push(`  ${v ? '✓' : '✗'} ${label}`)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const q = s => document.querySelector(s)
  const qa = s => [...document.querySelectorAll(s)]
  try {
    localStorage.setItem('yan.onboarded', '1')
    const ta = q('[data-testid="composer"]')
    if (!ta) return '✗ 找不到输入框'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '只回复两个字：收到。不要调用任何工具。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="send"]')
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await sleep(500)
      const txt = qa('.msg.assistant .md').map(e => e.textContent).join('')
      const busy = !!q('.cursor') || send.textContent.includes('中止')
      if (txt.length > 0 && !busy) break
    }
    ok(qa('.msg.assistant .md').map(e => e.textContent).join('').length > 0, '真实模型回复了一轮')
    await sleep(1500)
    q('[data-testid="composer-context"]')?.click()
    let box = null
    for (let i = 0; i < 20 && !box; i += 1) { await sleep(300); box = q('[data-testid="ctx-inspect"]') }
    ok(!!box, '浮层出现「固定部分明细」')
    if (box) {
      box.open = true
      await sleep(200)
      const sections = qa('[data-testid="ctx-inspect"] > .ctx-inspect-list:first-of-type > li')
      const tools = qa('[data-testid="ctx-inspect-tools"] li')
      ok(sections.length >= 2, `系统提示被拆成多段（${sections.length}）`)
      ok(tools.length >= 1, `列出了工具定义（${tools.length}）`)
      ok(/系统提示 [\d.]+k? · 工具定义 [\d.]+k?/.test(box.querySelector('summary')?.textContent ?? ''), '汇总行含系统提示与工具定义 token')
      out.push('  摘要：' + (box.querySelector('summary')?.textContent ?? ''))
      out.push('  分段：' + sections.map(s => s.textContent.replace(/\s+/g, ' ').trim()).join(' | '))
    }
  } catch (error) { ok(false, error.stack ?? String(error)) }
  return out.join('\n')
})()
