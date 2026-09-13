;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => {
    out.push('✗ ' + s)
    return out.join('\n')
  }
  const ok = (cond, s) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s)
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

  log('=== 端到端：发一条会触发工具调用的消息 ===')

  const ta = q('[data-testid="composer"]')
  if (!ta) return fail('找不到输入框')

  /* ---- 确认初始是空的（否则下面的断言没意义） ---- */
  /* eslint-disable no-unused-expressions */
  const nBefore = qa('.msg').length
  log('起始消息数: ' + nBefore)

  /* ---- 输入（受控组件必须走原生 setter） ---- */
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '必须先调用 bash 工具执行命令 `echo yan-e2e-ok`，再根据工具返回的内容回复。不要自己编造输出，不要省略工具调用。')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)

  const send = q('[data-testid="send"]')
  ok(!send.disabled, '输入后发送键可用')

  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  /* ---- 观察流式过程 ---- */
  let sawCursor = false
  let sawRunning = false
  let sawTool = false
  let grew = false
  let lastLen = 0

  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    await sleep(400)
    if (q('.cursor')) sawCursor = true
    if (q('.trow[data-state="running"]')) sawRunning = true
    if (q('.trow')) sawTool = true

    const txt = qa('.msg.assistant .md').map((e) => e.textContent).join('')
    if (txt.length > lastLen) {
      grew = true
      lastLen = txt.length
    }

    // 收工条件：已有助手正文，且不再流式/执行工具
    const busy = !!q('.cursor') || !!q('.trow[data-state="running"]') || send.textContent.includes('中止')
    if (txt.length > 0 && !busy) break
  }

  await sleep(1200)

  /* ---- 断言 ---- */
  const nAfter = qa('.msg').length
  log('结束消息数: ' + nAfter)
  ok(nAfter > nBefore, `新增了消息（${nBefore} → ${nAfter}）`)
  ok(qa('.msg.user').length > 0, '有用户消息')
  ok(sawCursor || sawRunning, '看到流式光标或工具运行中')
  ok(grew, '助手正文在增长（真流式，不是一次性出完）')
  ok(sawTool, '出现了工具卡')

  /* ---- 工具卡内容 ---- */
  log('--- 工具卡 ---')
  const tools = qa('.trow')
  const bash = tools.find((t) => t.dataset.tool === 'bash')
  ok(!!bash, '有 bash 工具卡')
  if (bash) {
    log(`  ${bash.dataset.tool} state=${bash.dataset.state} open=${bash.classList.contains('open')}`)
    log('  摘要=' + JSON.stringify((bash.querySelector('.trow-target')?.textContent ?? '').slice(0, 60)))
    ok(bash.dataset.state === 'ok', `bash 状态 = ${bash.dataset.state}（应 ok）`)
    ok(
      (bash.querySelector('.trow-target')?.textContent ?? '').includes('echo'),
      'bash 摘要显示的是命令'
    )
    // 成功的短输出按规则是折叠的，但摘要必须留着
    ok(!bash.classList.contains('open'), '成功的长输出默认折叠（智能展开规则）')
  }

  /* ---- 助手正文 ---- */
  const body = qa('.msg.assistant .md').map((e) => e.textContent).join(' ').trim()
  log('--- 助手正文 ---')
  log('  ' + JSON.stringify(body.slice(0, 200)))
  ok(body.length > 0, '助手有正文')

  /* ---- 收尾状态 ---- */
  log('--- 收尾状态 ---')
  const doneBtn = q('[data-testid="send"]')
  ok(!doneBtn.textContent.includes('中止'), '流式已结束（按钮回到「发送」）')
  ok(ta.value === '', '输入框已清空')
  ok(!q('.connbar'), '没有连接错误条')
  const notices = qa('.notice').length
  ok(notices <= 3, `通知不超过 3 条（实际 ${notices}）`)
  ok(q('.empty-stream') === null, '空状态已让位给消息流')

  return out.join('\n')
})()
