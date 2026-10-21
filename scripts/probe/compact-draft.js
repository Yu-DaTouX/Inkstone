;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const composer = () => window.__yanComposer.text(q('[data-testid="composer-input"]')) ?? ''
  const clickSend = () => {
    const button = q('[data-testid="composer-send"]')
    if (!button || button.disabled) throw new Error('发送键不可用')
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const idle = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    let since = 0
    while (Date.now() < deadline) {
      const s = store.getState().session
      if (s?.isAgentRunning || s?.isStreaming || s?.compaction) since = 0
      else if (!since) since = Date.now()
      else if (Date.now() - since > 4000) return true
      await sleep(250)
    }
    return false
  }

  const timeline = []
  const started = Date.now()
  const log = (text) => timeline.push(`${String(Date.now() - started).padStart(6)}ms ${text}`)
  try {
    for (let i = 0; i < 60; i++) {
      if (store?.getState().settings && q('[data-testid="composer-input"]')) break
      await sleep(250)
    }
    out.push('=== 手动压缩时的草稿与界面 ===')
    const topics = ['砚台的历史', '四大名砚各自的特点', '如何保养一方砚台']
    let rounds = 0
    for (const topic of topics) {
      window.__yanComposer.set(`不要调用任何工具，直接写一段约 600 字的中文短文，主题是${topic}。`, q('[data-testid="composer-input"]'))
      await sleep(200)
      clickSend()
      await sleep(2000)
      if (await idle(120_000)) rounds += 1
    }
    ok(rounds === topics.length, `前置 ${rounds} 轮结束`)

    const conv = q('.v3-conv')
    const firstTurn = q('.v3-msg.assistant')
    if (conv) conv.__probeMark = 1
    if (firstTurn) firstTurn.__probeMark = 1
    const composerHost = q('[data-testid="composer-input"]')
    if (composerHost) composerHost.__probeMark = 1

    let last = ''
    const unsubscribe = store.subscribe((s, p) => {
      const line = JSON.stringify({ sid: s.session?.sessionId, run: s.activeRunnerId, peek: s.peekedSessionId, msgs: s.messages.length, compaction: !!s.session?.compaction, running: !!s.session?.isAgentRunning })
      if (line !== last) {
        last = line
        log(line)
      }
      if (p.messages !== s.messages) log(`messages 引用变化 ${p.messages.length}→${s.messages.length}`)
    })
    let lastText = null
    const watch = setInterval(() => {
      const text = composer()
      if (text !== lastText) {
        lastText = text
        log(`输入框=${JSON.stringify(text)}`)
      }
      if (!q('[data-testid="composer-input"]')?.__probeMark) log('输入框 DOM 已替换')
    }, 50)

    window.__yanComposer.set('/compact', q('[data-testid="composer-input"]'))
    await sleep(200)
    clickSend()
    let began = false
    for (let i = 0; i < 200 && !began; i++) {
      began = !!store.getState().session?.compaction
      await sleep(50)
    }
    ok(began, '压缩已开始')
    window.__yanComposer.set('草稿保留测试 ABC', q('[data-testid="composer-input"]'))
    log('写入草稿')
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && store.getState().session?.compaction) await sleep(250)
    log('压缩结束')
    await sleep(5000)
    clearInterval(watch)
    unsubscribe()

    ok(composer().trim() === '草稿保留测试 ABC', `压缩结束后输入框草稿保留（${JSON.stringify(composer())}）`)
    ok(q('.v3-conv')?.__probeMark === 1, '对话区容器没有重建')
    ok(q('.v3-msg.assistant')?.__probeMark === 1, '已有回合没有重建')
    ok(q('[data-testid="composer-input"]')?.__probeMark === 1, '输入框没有重建')
    const echo = q('[data-testid="v3-compact-command"]')
    const article = echo?.closest('.v3-msg.assistant')
    const meta = article?.querySelector('[data-testid="v3-turn-meta"]')
    const changes = article?.querySelector('[data-testid="v3-turn-changes"]')
    const after = (a, b) => !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    ok(after(echo, meta), '/compact 气泡排在该回合的信息行之后')
    ok(!changes || after(echo, changes), '/compact 气泡排在该回合的改动卡之后')
    ok(after(q('[data-testid="v3-compaction-marker"]'), echo), '压缩标记紧跟在 /compact 气泡之后')

    const grid = document.createElement('dl')
    grid.className = 'ui-stat-grid'
    grid.style.cssText = 'position:fixed;left:0;top:0;width:340px;z-index:-1;--ui-stat-cols:2'
    grid.innerHTML = '<div class="ui-stat"><dt class="ui-stat__label">总数</dt><dd class="ui-stat__value"><span class="ui-stat__num">≥201.5M</span><span class="ui-stat__unit">tok</span></dd></div><div class="ui-stat"><dt class="ui-stat__label">x</dt><dd class="ui-stat__value"><span class="ui-stat__num">99.0%</span></dd></div>'
    document.body.appendChild(grid)
    const num = grid.querySelector('.ui-stat__num')
    ok(num.scrollWidth <= num.clientWidth, `统计卡片窄宽度下数字完整显示（需要 ${num.scrollWidth}px，可见 ${num.clientWidth}px）`)
    grid.remove()
    out.push(`  lastCompaction=${JSON.stringify(store.getState().session?.lastCompaction ?? null).slice(0, 200)}`)
    out.push('  时间线：')
    for (const line of timeline.slice(0, 80)) out.push('    ' + line)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    for (const line of timeline.slice(0, 80)) out.push('    ' + line)
  }
  return out.join('\n')
})()
