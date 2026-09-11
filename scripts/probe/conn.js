;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  log('=== 连接状态（竞态回归）===')
  log(`  期望：主进程启动 pi 只需几秒，而渲染端订阅可能更晚 ——`)
  log(`  不能因为错过一次 push，界面就永远停在「正在启动 pi」。`)
  log('')

  // 1. 启动后应该已经是 ready（或很快变成 ready）
  let st = store.getState().conn
  log('  初始 conn = ' + JSON.stringify(st))
  for (let i = 0; i < 40 && st !== 'ready'; i++) {
    await sleep(500)
    st = store.getState().conn
  }
  ok(st === 'ready', `最终 conn = ${st}（应为 ready）`)

  // 2. 权威拉取必须能答（这是修复的核心）
  const status = await window.yan.agentStatus()
  log('  agentStatus() = ' + JSON.stringify(status))
  ok(typeof status?.state === 'string', 'agentStatus 返回状态')
  ok(status.state === 'ready', `agentStatus.state = ${status.state}`)

  // 3. ready 时不该显示连接错误条
  ok(!q('.connbar'), '没有显示连接失败条')

  // 4. 输入框可用（conn !== ready 时是 disabled 的）
  const ta = q('[data-testid="composer"]')
  ok(ta && !ta.disabled, '输入框可用（证明 ready 真的生效了，不只是变量对）')

  // 5. 标题栏的连接文字
  const sync = q('.tb-sync')?.textContent ?? ''
  log('  标题栏: ' + JSON.stringify(sync))
  ok(!sync.includes('启动'), '标题栏不显示「启动中」')

  // 6. store 与主进程两边一致
  ok(status.state === store.getState().conn, 'store.conn 与主进程 agentStatus 一致')

  // 7. 真发一句话，确认功能可用（不只状态对）
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '回复两个字：收到')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(200)
  const send = q('[data-testid="send"]')
  ok(!send.disabled, '发送键可用')
  send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  let replied = false
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const txt = [...document.querySelectorAll('.msg.assistant .md')].map((e) => e.textContent).join('')
    if (txt.trim().length > 0 && !store.getState().session?.isStreaming && !q('.cursor')) {
      replied = true
      break
    }
  }
  ok(replied, '实际能收到回复（端到端可用）')
  log('  conn 仍是: ' + store.getState().conn)
  ok(store.getState().conn === 'ready', '对话后 conn 保持 ready')

  return out.join('\n')
})()
