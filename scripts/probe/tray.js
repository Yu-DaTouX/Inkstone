/**
 * 窗口生命周期：关闭按钮隐藏到托盘；取消退出后仍可重复请求退出。
 * YAN_EXIT_CHOICE=cancel 让这条探针不关闭测试应用，最后由 test-live 清理。
 */
;(async () => {
  const out = []
  const ok = (condition, text) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    if (typeof window.yan?.win?.lifecycle !== 'function' || typeof window.yan?.win?.requestExit !== 'function') {
      return '  ✗ bridge 没有窗口 lifecycle/requestExit（请确认 preload 与 build 来自同一版本）'
    }

    out.push('=== 1. 启动状态 ===')
    const initial = await window.yan.win.lifecycle()
    ok(initial.tray, '真实应用创建了托盘')
    ok(initial.visible && !initial.quitting, '窗口可见且尚未进入退出状态')

    out.push('')
    out.push('=== 2. 关闭按钮 ===')
    window.yan.win.close()
    await sleep(300)
    const hidden = await window.yan.win.lifecycle()
    ok(!hidden.visible, '关闭按钮只隐藏窗口')
    ok(hidden.tray && !hidden.quitting, '隐藏后托盘仍在且应用未退出')

    out.push('')
    out.push('=== 3. 取消退出可重复 ===')
    const first = await window.yan.win.requestExit()
    ok(first.action === 'cancelled', '第一次退出请求可取消')
    const afterCancel = await window.yan.win.lifecycle()
    ok(afterCancel.tray && !afterCancel.quitting, '取消后仍留在托盘')
    const second = await window.yan.win.requestExit()
    ok(second.action === 'cancelled', '第二次退出请求仍可重复取消')
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
