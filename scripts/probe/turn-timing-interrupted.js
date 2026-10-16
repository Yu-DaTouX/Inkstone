;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const list = await window.yan.listSessions()
    ok(Array.isArray(list) && list.length >= 1, `重启后仍能看到上次的会话（${list?.length ?? 0} 条）`)
    if (!list?.length) return out.join('\n')

    const target = list[0]
    out.push(`  turn-timing.interrupted.session=${target?.path ?? ''}`)

    const peek = await window.yan.peekSession(target.path)
    out.push(
      '  turn-timing.interrupted.messages=' +
        JSON.stringify(
          (peek?.messages ?? [])
            .slice(-8)
            .map((m) => ({ id: String(m.id ?? ''), role: m.role, t: m.turnTiming ? 1 : 0 }))
        )
    )
    const timed = (peek?.messages ?? []).filter((m) => m.turnTiming)
    const record = timed[timed.length - 1]?.turnTiming
    ok(!!record, `peek 回来的历史带计时记录（${timed.length} 条）`)
    ok(
      record?.terminalReason === 'interrupted',
      `中途快照被读成「中断」（实际 ${record?.terminalReason}）`
    )
    ok(Number(record?.elapsedMs) > 0, `中断回合仍有用时（${record?.elapsedMs ?? '-'}ms，冻结在最后一次快照）`)
    out.push(`  turn-timing.interrupted.reason=${record?.terminalReason ?? ''}`)
    out.push(`  turn-timing.interrupted.ms=${record?.elapsedMs ?? 0}`)

    await store.getState().switchSession(target.path)
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('[data-testid="turn-footer"]')) break
      await sleep(250)
    }
    const footers = [...document.querySelectorAll('[data-testid="turn-footer"]')]
    const text = (footers[footers.length - 1]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    out.push(`  turn-timing.interrupted.footer=${JSON.stringify(text)}`)
    ok(footers.length >= 1, '切进会话后有回合页脚')
    ok(/中断/.test(text), `页脚写出「已中断」：「${text}」`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
