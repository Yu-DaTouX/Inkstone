/**
 * N12「退出变体」· 中断退出（实施-09 S2 第五批）。
 *
 * 与 `exit-save.js` 同一套前置，只差场景给的 `YAN_EXIT_CHOICE=interrupt`：
 * 这一个分支不保留「下次启动可以继续」的意图（`exit-snapshot.json` 的
 * `mode` 写 `interrupt`），并且必须把正在跑的 pi 子进程收掉 ——
 * 后者在 Node 侧由 test-live 的全局孤儿进程检查兜住（每个场景退出后都查）。
 *
 * 两个分支的差别若只在探针里断言，很容易写成「自说自话」；真正的判据是
 * 落盘快照的 `mode` 与进程表，分别由 `afterExit` 和全局检查负责。
 */
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
