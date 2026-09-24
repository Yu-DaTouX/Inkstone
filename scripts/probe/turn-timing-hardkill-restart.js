/* H-6b 真强杀读侧：新 Electron 进程按用户标记定位同一会话并验中断页脚。 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const state = () => store.getState()
  const marker = 'YAN_H6B_REAL_HARD_KILL_PROBE_20260924'
  const commandMarker = 'H6B_TURN_TIMING_KILL_TOOL_RAN'

  try {
    for (let i = 0; i < 90; i += 1) {
      if (state().conn === 'ready' && state().settings) break
      await sleep(400)
    }
    ok(state().conn === 'ready', '强杀后重新启动的 Electron 已连上 pi')
    if (state().conn !== 'ready') return out.join('\n')
    localStorage.setItem('yan.onboarded', '1')

    const summaries = await window.yan.listSessions()
    ok(Array.isArray(summaries), `重启后会话列表可读（${summaries?.length ?? 0}）`)
    if (!Array.isArray(summaries)) return out.join('\n')

    let target = null
    let peek = null
    for (const summary of summaries.slice(0, 40)) {
      const candidate = await window.yan.peekSession(summary.path)
      const messages = candidate?.messages ?? []
      if (messages.some((message) => message.role === 'user' && String(message.text ?? '').includes(marker))) {
        target = summary
        peek = candidate
        break
      }
    }
    ok(!!target, '在重启后的历史中定位到这次强杀专用会话')
    if (!target || !peek) return out.join('\n')

    const messages = peek.messages ?? []
    const user = messages.find((message) => message.role === 'user' && String(message.text ?? '').includes(marker))
    const toolCalls = messages.flatMap((message) => message.toolCalls ?? [])
    const toolCall = toolCalls.find(
      (call) => call.name === 'bash' && JSON.stringify(call.args ?? '').includes(commandMarker)
    )
    const timed = messages.filter((message) => message.turnTiming)
    const record = timed[timed.length - 1]?.turnTiming
    out.push(`  turn-timing.interrupted.record=${JSON.stringify(record ?? null)}`)
    ok(!!user, '被强杀的用户消息仍保存在 pi 会话 JSONL')
    ok(!!toolCall, '触发 message_end 的 bash tool call 已保存到 pi 会话 JSONL')
    ok(!!record, `重启读回的历史消息带宿主计时（${timed.length} 条）`)
    ok(record?.terminalReason === 'interrupted', `final:false 被读为 interrupted（${record?.terminalReason ?? '缺失'}）`)
    ok(Number(record?.elapsedMs) > 0, `中断计时保留正用时（${record?.elapsedMs ?? '-'}ms）`)
    ok(record?.logicalTurnId === user?.id, `中断计时锚点仍对应测试用户消息（${record?.logicalTurnId ?? '缺失'} / ${user?.id ?? '缺失'}）`)
    out.push(`  turn-timing.interrupted.sessionFile=${target.path}`)
    out.push(`  turn-timing.interrupted.userMarkerPresent=${Boolean(user)}`)
    out.push(`  turn-timing.interrupted.toolCallPresent=${Boolean(toolCall)}`)
    out.push(`  turn-timing.interrupted.reason=${record?.terminalReason ?? ''}`)

    await state().switchSession(target.path)
    ok(
      state().peekedPath === target.path || state().session?.sessionFile === target.path,
      '切回强杀会话成功'
    )
    const footerReady = await (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (document.querySelector('[data-testid="turn-footer"]')) return true
        await sleep(200)
      }
      return false
    })()
    const footers = [...document.querySelectorAll('[data-testid="turn-footer"]')]
    const footer = (footers[footers.length - 1]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    ok(footerReady && footers.length > 0, '历史回合页脚已渲染')
    ok(/中断/.test(footer), `页脚显示真实中断状态：「${footer}」`)
    out.push(`  turn-timing.interrupted.footer=${JSON.stringify(footer)}`)
  } catch (error) {
    out.push('  探针出错：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
