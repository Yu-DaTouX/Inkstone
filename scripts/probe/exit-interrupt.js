;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const store = window.__yanStore

  if (typeof window.yan?.win?.requestExit !== 'function' || typeof window.yan?.win?.lifecycle !== 'function') {
    return '  ✗ bridge 没有 requestExit/lifecycle（请确认 preload 与 build 来自同一版本）'
  }

  try {
    out.push('=== 1. 前置：托盘在、尚未退出 ===')
    const life = await window.yan.win.lifecycle()
    ok(life.tray, '真实应用创建了托盘')
    ok(life.quitting === false, '前置条件：还没进入退出流程')

    if (store) {
      await store.getState().syncRunners()
      const runners = store.getState().runners ?? []
      out.push(`runners=${runners.length}`)
      out.push(`runner-conns=${runners.map((r) => r.conn).join(',') || '(空)'}`)
    } else {
      out.push('runners=(没有 window.__yanStore)')
    }
    out.push('expect-mode=interrupt')
    out.push(`probe-at=${Date.now()}`)

    out.push('')
    out.push('=== 2. 中断退出 ===')
    const first = await window.yan.win.requestExit()
    ok(first.action === 'interrupt-exit', '首次请求走「中断退出」', String(first.action))
    const again = await window.yan.win.requestExit()
    ok(
      again.action === 'already-exiting',
      '重复请求返回 already-exiting（两个分支共用同一条重复请求语义）',
      String(again.action)
    )
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
