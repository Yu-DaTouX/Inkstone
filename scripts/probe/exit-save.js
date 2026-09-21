/**
 * N12「退出变体」· 保存并退出（实施-09 S2 第五批）。
 *
 * ── 这一维在测什么 ──
 * 托盘退出有四个分支（`requestExit`）：取消 / 保存并退出 / 中断退出 / 重复请求。
 * 「取消」已在 `tray` 场景覆盖（两次取消都留在托盘）；这里覆盖**保存并退出**与
 * **退出进行中重复请求**。
 *
 * ── 为什么场景要给 `YAN_EXIT_CHOICE=save` ──
 * 真实用户在有运行会话时会看到三按钮原生对话框，探针点不了那个框。
 * `probeExitChoice()` 就是为此存在的 probe 替身（只在 `YAN_PROBE` 下生效），
 * 它跳过的**只是选择这一步**，写快照 / 回收实例 / 退出的那条链路完全相同。
 *
 * ── 断言分两段 ──
 * 渲染端这一段（本文件）只看「返回值 + quitting 状态」；
 * 快照文件本身在 Node 侧看（`afterExit: exitSnapshot`）—— 探针按设计读不到
 * `YAN_DATA_DIR`，硬要看就是破坏测试边界。
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

    /*
     * 快照里记的是主进程注册表的实例。渲染端 `runners` 就是那份的投影
     *（`runners` 推送 → store），所以这里打印的条数是 Node 侧可对照的量。
     */
    if (store) {
      await store.getState().syncRunners()
      const runners = store.getState().runners ?? []
      out.push(`runners=${runners.length}`)
      out.push(`runner-conns=${runners.map((r) => r.conn).join(',') || '(空)'}`)
    } else {
      out.push('runners=(没有 window.__yanStore)')
    }
    out.push('expect-mode=save')
    /* 与快照 `at` 对照：证明写下的就是**这次**退出，不是上一轮的残留 */
    out.push(`probe-at=${Date.now()}`)

    out.push('')
    out.push('=== 2. 保存并退出 ===')
    const first = await window.yan.win.requestExit()
    ok(first.action === 'save-and-exit', '首次请求走「保存并退出」', String(first.action))

    out.push('')
    out.push('=== 3. 退出进行中重复请求 ===')
    const again = await window.yan.win.requestExit()
    ok(
      again.action === 'already-exiting',
      '重复请求返回 already-exiting（不重复走一遍保存 / 不重复写快照）',
      String(again.action)
    )
    const after = await window.yan.win.lifecycle()
    ok(after.quitting === true, 'lifecycle 里 quitting 已经是 true')
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
