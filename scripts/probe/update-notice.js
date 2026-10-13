/*
 * 启动发现新版本时的提醒：通知出现、不会 20 秒自动消失、「查看更新」打开设置的「关于」页。
 *
 * 测试实例不是安装包（不会真的去 GitHub 检查），所以直接往 store 放一条与启动逻辑同形的通知，
 * 只验证渲染与交互；检查流程本身由主进程 app-update.ts 负责。
 */
;(async () => {
  const out = []
  const ok = (cond, s, detail) => {
    out.push((cond ? '  ✓ ' : '  ✗ ') + s + (cond || !detail ? '' : `（${detail}）`))
    return cond
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  try {
    const status = await window.yan.appUpdate.status()
    out.push(`  当前更新状态：phase=${status.phase} packaged=${status.packaged} automatic=${status.automatic}`)
    ok(status.packaged === false && status.phase !== 'available', '测试实例未打包，启动时不会自己弹出更新通知')
    ok(!q('[data-testid="app-update-notice"]'), '未发现新版本时没有更新通知')

    store.setState({
      notices: [...store.getState().notices, { id: 'app-update', type: 'info', text: '9.9.9', at: Date.now(), action: 'app-update' }]
    })
    await sleep(300)
    const notice = q('[data-testid="app-update-notice"]')
    ok(!!notice, '发现新版本时出现更新通知')
    ok(/9\.9\.9/.test(notice?.textContent ?? ''), '通知里写明新版本号', notice?.textContent ?? '')
    const open = q('[data-testid="app-update-notice-open"]')
    ok(!!open, '通知带「查看更新」按钮')

    await sleep(21_000)
    ok(!!q('[data-testid="app-update-notice"]'), '20 秒后通知仍在（不自动消失）')

    open?.click()
    await sleep(600)
    ok(!q('[data-testid="app-update-notice"]'), '点「查看更新」后通知收起')
    ok(!!q('[data-testid="update-check"]'), '设置打开到含「检查更新」的关于页')
    store.getState().closeSettings?.()
  } catch (error) {
    out.push('  探针出错: ' + (error?.stack ?? String(error)))
  }
  return out.join('\n')
})()
