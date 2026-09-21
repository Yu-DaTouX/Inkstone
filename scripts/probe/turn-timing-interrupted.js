/*
 * 中途被拿掉的回合读回后报「已中断」（实施-11 H-6b-2，重启后的第二个探针）。
 *
 * 这条路要两段才能拼出来：
 *   ① 第一次启动跑一个真实回合，写下计时记录；
 *   ② 重启前由测试进程**往同一个 `logicalTurnId` 追加一条 `final: false`** 的
 *      中途快照 —— 这正是「应用在飞行中被拿掉、只剩最后那次快照」在盘上的样子。
 * 这个探针做第 ③ 段：切进那条会话，看界面写的是不是「已中断」。
 *
 * 为什么不直接强杀进程：SIGKILL 之后连“最后一条快照有没有落盘”都不确定，
 * 测出来的是调度运气而不是代码行为；追加快照验的是同一段读侧逻辑。
 */
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

    /* 取最近的一条（上一次运行写的那个真实会话） */
    const target = list[0]
    out.push(`  turn-timing.interrupted.session=${target?.path ?? ''}`)

    const peek = await window.yan.peekSession(target.path)
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

    /* 真实界面：切进那条会话，页脚必须写出来 —— 数据层对了但没接进 UI 不算完 */
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
