/**
 * 增量推送协议（`textDelta` / `thinkingDelta` / `outputDelta`）的回归用例。
 *
 * 为什么必须有这个用例：
 *   为了让长会话不卡，主进程不再每帧重发整篇累积文本/工具输出，
 *   改成「只发新增的那一段」，由渲染端 append（见 src/shared/ipc.ts 的
 *   MessagePatch、src/main/agent.ts 的 flushNow/flushTools）。
 *   这条路径**只在流式时**才走，而流式需要真实模型 —— 探针里拿不到。
 *   所以这里直接用 store 的 applyPush 按主进程的推送形状灌进去，
 *   验证「拼接结果 == 全量结果」以及兜底路径（全量覆盖 / 未知 id 不伪造）。
 *
 * 判据（任何一条 ✗ 都会让用例失败）：
 *   ① 连续 textDelta 拼出来的文本与全量一致
 *   ② thinkingDelta 同理
 *   ③ outputDelta 追加在**本地已有 output** 之后（这是渲染端最容易写错的地方：
 *      若错信了增量包里那份为空的 call.output，输出会被覆盖成只剩最后一段）
 *   ④ 增量包里不带的全量字段（status 等）仍然生效
 *   ⑤ message_end 式的全量 patch 能覆盖掉累积结果（权威对齐）
 *   ⑥ 未知 id 不凭空造消息
 */
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
    // ① 全量（run 开始）：带完整 call，含第一段输出
    push({
      ch: 'tool',
      payload: {
        msgId: 'dl-tool',
        call: { id: 'tc1', name: 'bash', args: { command: 'x' }, status: 'running', output: '1\n' }
      }
    })
    // ② 增量（高频路径）：call 里**没有** output（主进程置为 undefined）
    push({
      ch: 'tool',
      payload: {
        msgId: 'dl-tool',
        call: { id: 'tc1', name: 'bash', args: { command: 'x' }, status: 'running', output: undefined },
        outputDelta: '2\n'
      }
    })
    // ③ 最后一段 + 状态变化
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
    // message_end 的全量快照要能覆盖累积结果
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
