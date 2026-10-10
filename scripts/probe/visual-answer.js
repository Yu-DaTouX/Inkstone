/**
 * 可视化回答的真实模型探针（会真的调模型）。
 * 先核对当前模型与思考档位是否为运行器指定的那一个（__MODEL__ / __THINKING__ 由运行器替换），不是就不发送；
 * 发送同一个自带数据的问题，等回答结束，统计画出来的块与格式错误，再逐块滚到视口给截图。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const deadline = Date.now() + 240000
  const waitFor = async (fn, step = 400) => {
    while (Date.now() < deadline) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }
  localStorage.setItem('yan.onboarded', '1')
  await waitFor(() => store.getState().session?.model?.id)
  const s = store.getState().session
  log(`model=${s?.model?.provider}/${s?.model?.id} thinking=${s?.thinkingLevel}`)
  if (s?.model?.id !== '__MODEL__' || ('__THINKING__' !== 'any' && s?.thinkingLevel !== '__THINKING__')) {
    log('FAIL 模型或思考档位与指定不符，未发送')
    return out.join('\n')
  }
  const prompt = [
    '帮我整理一个简短的回答，按下面四点：',
    '1. 推荐三个 Markdown 编辑器：Typora（付费买断，所见即所得，https://typora.io）、Obsidian（免费，管理大量笔记，https://obsidian.md）、MarkText（开源免费，https://github.com/marktext/marktext）。',
    '2. 我自己测的冷启动时间（同一台电脑，2026-10-09）：Typora 1.8 秒、Obsidian 3.2 秒、MarkText 2.4 秒。帮我对比。',
    '3. 画出「用户发消息 → 砚 → pi → 模型 → 回到砚显示」这条调用顺序。',
    '4. 简单讲讲 JavaScript 事件循环的几个阶段，方便我一步步看。'
  ].join('\n')
  const started = Date.now()
  await store.getState().send(prompt)
  await waitFor(() => store.getState().session?.isAgentRunning, 200)
  const done = await waitFor(() => !store.getState().session?.isAgentRunning && !store.getState().session?.isStreaming, 500)
  log(`finished=${!!done} seconds=${((Date.now() - started) / 1000).toFixed(1)}`)
  await sleep(2500)
  const last = [...store.getState().messages].reverse().find((m) => m.role === 'assistant')
  const text = String(last?.text ?? '')
  const tools = store.getState().messages.flatMap((m) => (m.toolCalls ?? []).map((c) => `${c.name}:${JSON.stringify(c.args ?? {}).slice(0, 80)}`))
  log(`tools=${JSON.stringify(tools)}`)
  log(`fences=${JSON.stringify(text.match(/```[\w-]+/g) ?? [])}`)
  const blocks = [...document.querySelectorAll('.vb:not(.vb-pending)')]
  log(`rendered=${JSON.stringify(blocks.map((b) => b.getAttribute('data-testid')))}`)
  log(`invalid=${document.querySelectorAll('.vb-invalid').length} ${[...document.querySelectorAll('.vb-invalid-note')].map((n) => n.textContent).join(' | ')}`)
  log('TEXT-START\n' + text + '\nTEXT-END')
  document.querySelector('.turn:last-of-type')?.scrollIntoView({ block: 'start' })
  await sleep(3500)
  for (const b of blocks) { b.scrollIntoView({ block: 'start' }); await sleep(3500) }
  return out.join('\n')
})()
