;(async () => {
  const out = []
  const ok = (cond, s, detail) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s + (cond || !detail ? '' : `（${detail}）`))
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

  try {
    localStorage.setItem('yan.onboarded', '1')
    const ta = q('[data-testid="composer"]')
    if (!ta) return '✗ 找不到输入框'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(
      ta,
      '依次用 bash 工具执行这三条命令，每条单独执行，不要改写：\n' +
        '1. yan skill read --id skill:office\n' +
        '2. yan skill read --id skill:tutor\n' +
        '3. yan research --help\n' +
        '执行完后只输出三行，格式严格如下，值照命令输出填写，不要编造：\n' +
        'OFFICE=<第 1 条输出里的 contentHash 值；没有就写 NONE>\n' +
        'TUTOR=<第 2 条输出里的错误码（例如 skill_unavailable）；成功读到就写 OK>\n' +
        'RESEARCH_SKILL_REF=<第 3 条输出里出现 "skill:" 就写 YES，否则 NO>'
    )
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) return '✗ 发送键不可用'
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    let sawTool = false
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      await sleep(500)
      if (q('[data-testid="turn-process"]')) sawTool = true
      const reply = qa('.msg.assistant .md').map((e) => e.textContent).join('\n')
      const busy = !!q('.trow[data-state="running"]') || !!q('[data-testid="working"]')
      if (sawTool && /RESEARCH_SKILL_REF=/.test(reply) && !busy) break
    }
    const reply = qa('.msg.assistant .md').map((e) => e.textContent).join('\n')
    out.push('  模型回复：' + reply.replace(/\s+/g, ' ').slice(-240))
    ok(sawTool, '模型发起了工具调用')
    for (const btn of qa('[data-testid="turn-process-toggle"]')) if (btn.getAttribute('aria-expanded') !== 'true') btn.click()
    await sleep(400)
    ok(qa('.trow').length >= 3, `三条命令都执行了（工具行 ${qa('.trow').length}）`)

    const office = reply.match(/OFFICE=([^\s]+)/)?.[1] ?? ''
    const tutor = reply.match(/TUTOR=([^\s]+)/)?.[1] ?? ''
    const ref = reply.match(/RESEARCH_SKILL_REF=([^\s]+)/)?.[1] ?? ''
    ok(!!office && office !== 'NONE', '现存的 office 技能读得到（有 contentHash）', office)
    ok(/unavailable|找不到|not.?found/i.test(tutor), '已删除的 tutor 技能报不可用', tutor)
    ok(ref === 'NO', 'yan research --help 不再指向技能', ref)
    ok(!/不是内部或外部命令|command not found|is not recognized/i.test(document.body.innerText || ''), 'yan 命令可用')
  } catch (error) {
    out.push('  探针出错: ' + (error?.stack ?? String(error)))
  }
  return out.join('\n')
})()
