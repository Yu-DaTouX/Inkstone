/**
 * 诊断：为什么长会话（虚拟化）时一项都不渲染。
 *
 * 只输出尺寸与结构，不做断言 —— 用来定位「卡死/白屏」。
 */
;(async () => {
  const out = []
  const q = (s) => document.querySelector(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  const info = (label) => {
    const c = q('.center')
    const s = q('.stream')
    const cs = c ? getComputedStyle(c) : null
    out.push(`--- ${label} ---`)
    out.push(`  .center h=${c?.clientHeight ?? '-'} rows=${cs?.gridTemplateRows ?? '-'} display=${cs?.display ?? '-'}`)
    out.push(
      `  子元素: ` +
        [...(c?.children ?? [])]
          .map((x) => `${String(x.className).split(' ')[0]}(${Math.round(x.getBoundingClientRect().height)})`)
          .join(' ')
    )
    const r = s?.getBoundingClientRect()
    out.push(`  .stream clientH=${s?.clientHeight} scrollH=${s?.scrollHeight} rect=${r ? Math.round(r.width) + 'x' + Math.round(r.height) : '-'}`)
    out.push(`  .stream 直接子节点=${s?.children.length} 类名=${[...(s?.children ?? [])].map((x) => String(x.className).split(' ')[0]).join('|') || '(空)'}`)
    out.push(`  .stream-row=${document.querySelectorAll('.stream-row').length} .stream .msg=${document.querySelectorAll('.stream .msg').length}`)
    if (s) out.push(`  innerHTML: ${s.innerHTML.replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  try {
    info('普通路径（真实会话）')

    /* 注入 240 条 —— 与 virtual 探针同一份数据形态 */
    const fake = []
    for (let i = 0; i < 240; i++) {
      if (i % 3 === 0) fake.push({ id: 'd' + i, role: 'user', text: '第 ' + i + ' 条用户消息' })
      else if (i % 3 === 1)
        fake.push({
          id: 'd' + i,
          role: 'assistant',
          text: '第 ' + i + ' 条助手回复\n\n- 要点\n\n```bash\necho ' + i + '\n```',
          usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.0001 }
        })
      else
        fake.push({
          id: 'd' + i,
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 'c' + i, name: 'bash', args: { command: 'echo ' + i }, status: 'ok', output: 'x\n' }]
        })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    out.push('')
    out.push(`注入后 store 里 ${store.getState().messages.length} 条`)

    for (const wait of [500, 2000, 5000]) {
      await sleep(wait)
      info(`注入后 +${wait}ms`)
    }

    const turns = store.getState().messages.length
    out.push('')
    out.push(`（store 仍有 ${turns} 条）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
