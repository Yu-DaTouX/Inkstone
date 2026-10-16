;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const store = window.__yanStore
  if (!store) {
    out.push('  ✗ 拿不到 window.__yanStore')
    return out.join('\n')
  }
  const push = (m) => store.getState().applyPush(m)
  const msg = (id) => store.getState().messages.find((x) => x.id === id)
  const callOf = (id) => msg(id)?.toolCalls?.[0]

  try {
    out.push('=== 增量推送：文本 ===')
    push({ ch: 'msg-add', payload: { id: 'dl-text', role: 'assistant', text: '', timestamp: Date.now() } })
    for (const chunk of ['你好', '，世界', '！']) {
      push({ ch: 'msg-update', payload: { id: 'dl-text', patch: { textDelta: chunk } } })
    }
    ok(msg('dl-text')?.text === '你好，世界！', `textDelta 拼接正确：${JSON.stringify(msg('dl-text')?.text)}`)

    push({ ch: 'msg-update', payload: { id: 'dl-text', patch: { thinkingDelta: '先' } } })
    push({ ch: 'msg-update', payload: { id: 'dl-text', patch: { thinkingDelta: '想一想' } } })
    ok(msg('dl-text')?.thinking === '先想一想', `thinkingDelta 拼接正确：${JSON.stringify(msg('dl-text')?.thinking)}`)

    out.push('')
    out.push('=== 增量推送：工具输出 ===')
    push({ ch: 'msg-add', payload: { id: 'dl-tool', role: 'assistant', text: '', timestamp: Date.now() } })
    push({
      ch: 'tool',
      payload: {
        msgId: 'dl-tool',
        call: { id: 'tc1', name: 'bash', args: { command: 'x' }, status: 'running', output: '1\n' }
      }
    })
    push({
      ch: 'tool',
      payload: {
        msgId: 'dl-tool',
        call: { id: 'tc1', name: 'bash', args: { command: 'x' }, status: 'running', output: undefined },
        outputDelta: '2\n'
      }
    })
    push({
      ch: 'tool',
      payload: {
        msgId: 'dl-tool',
        call: { id: 'tc1', name: 'bash', args: { command: 'x' }, status: 'ok', output: undefined },
        outputDelta: '3\n'
      }
    })
    const c = callOf('dl-tool')
    ok(c?.output === '1\n2\n3\n', `outputDelta 追加正确：${JSON.stringify(c?.output)}`)
    ok(c?.status === 'ok', `增量包里的状态也生效：${c?.status}`)

    out.push('')
    out.push('=== 兜底路径 ===')
    push({ ch: 'msg-update', payload: { id: 'dl-text', patch: { text: '最终全文', thinkingLive: false } } })
    ok(msg('dl-text')?.text === '最终全文', `全量 patch 覆盖累积结果：${JSON.stringify(msg('dl-text')?.text)}`)

    const before = store.getState().messages.length
    push({ ch: 'msg-update', payload: { id: 'dl-nonexistent', patch: { textDelta: 'x' } } })
    ok(store.getState().messages.length === before, '未知 id 不新增消息')

    out.push('')
    out.push('=== 渲染 ===')
    await sleep(400)
    const rendered = document.body.innerText.includes('最终全文')
    ok(rendered, '拼接后的文本已渲染到界面')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
