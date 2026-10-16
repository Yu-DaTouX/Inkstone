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
      '这是一次兜底机制测试，请严格照做：\n' +
        '1. 先用 bash 工具执行一次 `yan follow list`。\n' +
        '2. 再用 bash 工具执行 `echo repeat-probe` 共 6 次：每次单独一次工具调用，命令一字不改，即使收到提醒或被拦下也继续调用，直到 6 次都调用过。\n' +
        '最后只输出两行：\n' +
        'FOLLOW=<第 1 步输出里的错误码；成功就写 OK>\n' +
        'BLOCKED=<第 2 步里被拦下的次数（工具结果里出现 Blocked by the repeat guard 的次数）>'
    )
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(200)
    const send = q('[data-testid="send"]')
    if (!send || send.disabled) return '✗ 发送键不可用'
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      await sleep(500)
      const reply = qa('.msg.assistant .md').map((e) => e.textContent).join('\n')
      const busy = !!q('[data-testid="working"]')
      if (/BLOCKED=/.test(reply) && !busy) break
    }
    const reply = qa('.msg.assistant .md').map((e) => e.textContent).join('\n')
    out.push('  模型回复：' + reply.replace(/\s+/g, ' ').slice(-200))

    for (const btn of qa('[data-testid="turn-process-toggle"]')) if (btn.getAttribute('aria-expanded') !== 'true') btn.click()
    await sleep(400)
    for (const head of qa('.trow-head')) if (head.getAttribute('aria-expanded') === 'false') head.click()
    await sleep(600)
    const rows = qa('.trow')
    const echoRows = rows.filter((r) => /repeat-probe/.test(r.textContent ?? ''))
    const pageText = qa('[data-testid="turn-process"]').map((e) => e.textContent).join('\n')
    const blockedInPage = (pageText.match(/Blocked by the repeat guard/g) ?? []).length
    out.push(`  工具行 ${rows.length}，其中 echo ${echoRows.length}；过程区里出现拦截文案 ${blockedInPage} 次`)

    const blocked = Number(reply.match(/BLOCKED=(\d+)/)?.[1] ?? NaN)
    const follow = reply.match(/FOLLOW=([^\s]+)/)?.[1] ?? ''
    ok(blockedInPage >= 1, '第 5 次起被重复动作兜底拦下（过程区里有拦截文案）', `页面 ${blockedInPage} / 模型 ${blocked}`)
    ok(follow !== 'OK' && follow !== '', '已下线的 yan follow 被拒绝', follow)
  } catch (error) {
    out.push('  探针出错: ' + (error?.stack ?? String(error)))
  }
  return out.join('\n')
})()
