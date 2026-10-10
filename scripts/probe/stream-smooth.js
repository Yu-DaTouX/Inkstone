/** Real renderer: long history, incremental code/Chinese/emoji, input and final alignment. */
;(async () => {
  const out = [], store = window.__yanStore
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const frame = () => new Promise(requestAnimationFrame)
  const ok = (value, label) => { out.push(`${value ? '✓' : '✗'} ${label}`); if (!value) throw Error(label) }
  try {
    await sleep(300)
    const history = []
    for (let i = 0; i < 300; i++) history.push(
      { id: `smooth-u${i}`, role: 'user', text: `Question ${i}` },
      { id: `smooth-a${i}`, role: 'assistant', text: `历史回答 ${i}\n\n` + '已经完成的内容不应随当前输出反复重建。'.repeat(20) })
    store.setState({ messages: [...history, { id: 'smooth-user', role: 'user', text: '请输出代码与进展' },
      { id: 'smooth-tool', role: 'assistant', text: '', toolCalls: [{ id: 'smooth-read', name: 'read', args: { path: 'input.txt' }, status: 'running', startedAt: Date.now() }] },
      { id: 'smooth-live', role: 'assistant', text: '' }], peekedPath: null, peekedSessionId: null,
      session: { ...store.getState().session, isAgentRunning: true, isStreaming: true } })
    for (let i = 0; i < 50 && !document.querySelector('[data-msg-id="smooth-tool"]'); i++) await sleep(40)
    ok(!!document.querySelector('[data-msg-id="smooth-tool"]'), '长历史下当前流式回合可见')
    const node = () => document.querySelector('[data-msg-id="smooth-tool"]')
    ok(!!node().querySelector('[data-tool="read"]'), '没有模型文字时真实工具进展仍可见')
    store.getState().applyPush({ ch: 'tool', payload: { msgId: 'smooth-tool', call: { id: 'smooth-read', name: 'read', status: 'done' }, outputDelta: 'File read successfully' } })
    let paints = 0
    const observer = new MutationObserver(() => paints++)
    observer.observe(node(), { childList: true, subtree: true, characterData: true })
    const durations = [], inputLatencies = []
    let text = '正在读取和比较。中文与 emoji 🖋️ 保持完整。\n\n```js\n'
    const push = patch => store.getState().applyPush({ ch: 'msg-update', payload: { id: 'smooth-live', patch } })
    push({ text })
    for (let i = 0; i < 100; i++) {
      const start = performance.now()
      const chunk = `const value${i} = "中文🖋️ ${i}"; // streamed code\n`.repeat(5)
      text += chunk; push({ textDelta: chunk })
      if (i % 20 === 0) {
        const input = document.querySelector('.composer textarea') || document.querySelector('textarea')
        if (input) {
          const began = performance.now()
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, `typing-${i}`)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          await frame()
          inputLatencies.push(performance.now() - began)
        }
      }
      await frame(); durations.push(performance.now() - start)
    }
    ok(paints > 10, `文字增量在过程中持续绘制（${paints}次）`)
    ok(!node().querySelector('code.hljs'), '增长中的代码块不反复高亮')
    text += '```\n\n| 项目 | 结果 |\n| --- | --- |\n| 流式 | 正常 |\n\nFINAL-STREAM-中文🖋️'
    push({ text })
    store.setState({ session: { ...store.getState().session, isAgentRunning: false, isStreaming: false } })
    for (let i = 0; i < 60 && !node()?.textContent.includes('FINAL-STREAM-中文🖋️'); i++) await frame()
    ok(store.getState().messages.at(-1).text === text, '增量与最终权威文本逐字一致')
    ok(node().textContent.includes('FINAL-STREAM-中文🖋️'), '完成后立即显示全文，无逐字播放拖尾')
    ok(!!node().querySelector('code.hljs'), '完成后恢复代码高亮')
    ok(!!node().querySelector('table'), '完成后Markdown表格结构正确')
    observer.disconnect()
    durations.sort((a, b) => a - b); inputLatencies.sort((a, b) => a - b)
    ok(inputLatencies.length === 5 && inputLatencies.at(-1) < 200, `流式期间输入可响应（最慢${inputLatencies.at(-1)?.toFixed(1)}ms）`)
    out.push('METRICS ' + JSON.stringify({ frames: durations.length, p95Ms: durations[95], slowFrames50ms: durations.filter(ms => ms > 50).length,
      maxInputPaintMs: inputLatencies.at(-1), visibleUpdates: paints, chars: text.length, messages: store.getState().messages.length }))
    await sleep(1800) // Allow the harness to capture the completed Markdown state.
    return out.join('\n')
  } catch (error) { out.push('✗ ' + String(error)); return out.join('\n') }
})()
