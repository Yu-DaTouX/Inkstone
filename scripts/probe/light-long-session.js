;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const fail = (s) => { out.push('✗ ' + s); return out.join('\n') }
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  log('=== 长会话虚拟化（注入 240 条消息）===')

  const N = 240
  const fake = []
  for (let i = 0; i < N; i++) {
    if (i % 3 === 0) {
      fake.push({ id: 'f' + i, role: 'user', text: '第 ' + i + ' 条用户消息：' + 'x'.repeat(30) })
    } else if (i % 3 === 1) {
      fake.push({
        id: 'f' + i,
        role: 'assistant',
        text: '第 ' + i + ' 条助手回复。\n\n- 要点一\n- 要点二\n\n```bash\necho ' + i + '\n```',
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.0001 }
      })
    } else {
      fake.push({
        id: 'f' + i,
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'c' + i,
            name: 'bash',
            args: { command: 'echo line-' + i },
            status: 'ok',
            output: 'line-' + i + '\n'
          }
        ]
      })
    }
  }

  store.getState().applyPush({ ch: 'sync', payload: fake })
  await sleep(1200)

  const loaded = store.getState().messages.length
  ok(loaded === N, `store 里有 ${loaded} 条`)

  const t0 = performance.now()
  let waited = 0
  let injected = 1
  const painted = () => qa('.stream-row').length > 0 || qa('.stream .msg').length > 0
  while (waited < 20000) {
    if (painted()) break
    await sleep(50)
    waited += 50
    if (waited > 0 && waited % 4000 === 0) {
      store.getState().applyPush({ ch: 'sync', payload: fake })
      injected++
    }
  }
  const rowItems = qa('.stream-row').length
  const plainItems = qa('.stream-inner > .msg').length
  const domMsgs = qa('.stream .msg').length
  const paintMs = Math.round(performance.now() - t0)

  log('  .stream-row=' + rowItems + '  .stream-inner>.msg=' + plainItems + '  DOM 里 .msg 总数=' + domMsgs)
  log('  渲染耗时约 ' + paintMs + 'ms（注入 ' + injected + ' 次，store 里 ' + store.getState().messages.length + ' 条）')

  ok(rowItems > 0, '超过阈值后走虚拟化路径（.stream-row）')
  ok(plainItems === 0, '没有同时走普通路径')
  ok(domMsgs > 0, `DOM 里确实渲染了消息（${domMsgs} 条）`)
  ok(domMsgs < N, `只渲染了 ${domMsgs}/${N} 条（窗口化生效，省了 ${N - domMsgs} 条）`)

  const sc = q('.stream')
  ok(!!sc, '.stream 是滚动容器')
  const firstIds = qa('.stream-row .msg').map((e) => e.closest('.stream-row')?.getAttribute('data-index') ?? '')
  log('  初始可见文本前 40 字: ' + JSON.stringify(qa('.stream .msg')[0]?.textContent?.slice(0, 40)))

  sc.scrollTop = sc.scrollHeight
  for (let i = 0; i < 60 && qa('.stream .msg').length === 0; i++) await sleep(50)
  const afterScroll = qa('.stream .msg').length
  log('  滚到底后 DOM 里 %d 条'.replace('%d', afterScroll))
  ok(afterScroll > 0, '滚到底后仍有内容渲染')
  for (let i = 0; i < 8; i++) {
    const before = sc.scrollHeight
    sc.scrollTop = sc.scrollHeight
    await sleep(150)
    if (sc.scrollHeight === before && (qa('.stream .msg').slice(-1)[0]?.textContent ?? '').includes('239')) break
  }
  const lastText = qa('.stream .msg').slice(-1)[0]?.textContent ?? ''
  log('  最后一条: ' + JSON.stringify(lastText.slice(0, 40)))
  ok(lastText.includes('line-239') || lastText.includes('239') || lastText.includes('第 238 条'), '滚到底能看到最后一个回合（含折叠的第 239 项）')

  sc.scrollTop = sc.scrollHeight / 2
  for (let i = 0; i < 60 && qa('.stream .msg').length === 0; i++) await sleep(50)
  ok(qa('.stream .msg').length > 0, '滚到中间仍有内容')

  sc.scrollTop = Math.round(sc.scrollHeight * 0.4)
  await sleep(300)
  const beforeTop = sc.scrollTop
  const beforeH = sc.scrollHeight
  store.getState().applyPush({
    ch: 'msg-add',
    payload: { id: 'f-follow-probe', role: 'user', text: '新消息：用来验证向上阅读时不会被拽到底部' }
  })
  await sleep(500)
  const afterTop = sc.scrollTop
  log(
    `  向上翻后追加内容：scrollTop ${Math.round(beforeTop)} → ${Math.round(afterTop)}` +
      `（内容 ${beforeH} → ${sc.scrollHeight}）`
  )
  ok(Math.abs(afterTop - beforeTop) < 60, '向上阅读时没有被拉回底部')
  ok(
    sc.scrollHeight - sc.scrollTop - sc.clientHeight > 40,
    '确实不在底部（否则上面那条断言没有意义）'
  )

  const over = sc.scrollWidth - sc.clientWidth
  ok(over <= 0, `.stream 无横向溢出（差 ${over}）`)

  log('--- 恢复真实数据 ---')
  const authoritative = await window.yan.getMessages()
  store.getState().applyPush({ ch: 'sync', payload: authoritative })
  await sleep(500)

  const restored = store.getState().messages.length
  const fakeGone = !restored || !store.getState().messages.some((m) => /^f\d+$/.test(m.id))
  ok(fakeGone, `注入的假数据已被替换（现在 ${restored} 条）`)
  ok(restored !== N || !fakeGone, '恢复的是真实会话数据')

  const shouldVirtual = restored >= 80
  const isVirtual = qa('.stream-row').length > 0
  ok(
    isVirtual === shouldVirtual,
    `渲染路径与条数一致（${restored} 条 → ${isVirtual ? '虚拟化' : '普通'}）`
  )

  return out.join('\n')
})()
