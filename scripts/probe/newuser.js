;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(800)

    const settings = await window.yan.getSettings()
    ok(/[\\/]砚$/.test(settings.cwd || ''), `默认工作文件夹是「…\\砚」（实际 ${settings.cwd}）`)
    ok(settings.permissionMode === undefined || settings.permissionMode === 'danger', '权限默认是危险批准')
    ok(settings.guardOutsideWrites !== true, '写入项目之外的确认默认关')
    ok(settings.showSpaces !== true, '空间与资料库默认收起')

    const tools = await window.yan.toolchainStatus()
    ok(!!tools && typeof tools.bash?.ok === 'boolean' && typeof tools.git?.ok === 'boolean', 'toolchainStatus 返回 bash / git 状态')
    ok(tools.bash.ok || !!tools.bash.hint, '缺 bash 时带安装说明')
    ok(tools.git.ok || !!tools.git.hint, '缺 git 时带安装说明')

    if (!q('.ob-card')) {
      store.getState().openSettings('about')
      if (await until(() => q('[data-testid="ob-reopen"]'))) click(q('[data-testid="ob-reopen"]'))
    }
    ok(await until(() => q('.ob-card')), '引导层能打开')
    await sleep(500)
    ok(!!q('[data-testid="ob-tools"]'), '引导里有「命令行工具」一行')
    const authText = q('[data-testid="ob-auth"] .ob-row-desc')?.textContent ?? ''
    ok(!/\/login/.test(authText), `模型接入一行不再让用户去终端 pi /login（实际：${authText.trim()}）`)
    ok(q('[data-testid="ob-auth"]')?.getAttribute('data-ok') === '0', '没有凭证时模型接入一行标为待办')
    const done = q('[data-testid="ob-done"]') ?? q('[data-testid="ob-close"]')
    if (done) click(done)
    await sleep(400)
    ok(!q('.ob-card'), '引导能关闭')
    if (store.getState().settingsOpen) store.getState().closeSettings()

    ok(!q('[data-testid="wb-card-space"]') && !q('[data-testid="wb-card-sources"]'), '日常首页没有空间 / 资料卡')

    const picker = q('[data-testid="permission-picker"]')
    const option = (value) => q(`.ui-choice-menu [role="menuitemradio"][data-value="${value}"]`)
    ok(!!picker, '输入区有权限选择器')
    if (picker) {
      const dangerLabel = picker.querySelector('.ui-choice-text')?.textContent ?? ''
      click(picker)
      ok(await until(() => option('danger')), '权限菜单能打开')
      ok(document.querySelectorAll('.ui-choice-menu [role="menuitemradio"]').length === 2 && !!option('all'), '只有「自动批准」「不受限制」两档')
      ok(option('danger')?.getAttribute('aria-checked') === 'true', '当前是自动批准（危险操作需确认）')
      click(option('all'))
      ok(await until(() => store.getState().settings?.permissionMode === 'all'), '选「不受限制」后写进设置')
      ok(await until(() => (q('[data-testid="permission-picker"] .ui-choice-text')?.textContent ?? '') !== dangerLabel), '按钮文字切到新档位')
      const saved = await window.yan.getSettings()
      ok(saved.permissionMode === 'all', '设置已落盘')
      click(q('[data-testid="permission-picker"]'))
      if (await until(() => option('danger'))) click(option('danger'))
      ok(await until(() => store.getState().settings?.permissionMode === 'danger' && q('[data-testid="permission-picker"] .ui-choice-text')?.textContent === dangerLabel), '切回自动批准后按钮文字复原')
    }

    const base = { tool: 'bash', title: '测试', detail: 'rm old.xlsx', reasons: ['原因'], cwd: 'C:/x', createdAt: Date.now() }
    store.setState({ approvals: [{ ...base, id: 'o1', kind: 'outside', canRemember: true, rememberDirs: ['D:/other'] }] })
    ok(await until(() => q('[data-testid="approval-card"]')), '批准卡片渲染在输入框上方')
    ok(!!q('[data-testid="approval-remember"]'), '项目外写入带「允许并记住目录」')
    ok(!!q('[data-testid="approval-once"]') && !!q('[data-testid="approval-deny"]'), '有「允许这一次」与「拒绝」')
    store.setState({ approvals: [{ ...base, id: 'd1', kind: 'delete', canRemember: false }] })
    await sleep(300)
    ok(q('[data-testid="approval-card"]')?.classList.contains('risky') === true, '删除类用警示色')
    ok(!q('[data-testid="approval-remember"]'), '删除类没有「记住」')
    click(q('[data-testid="approval-deny"]'))
    ok(await until(() => !q('[data-testid="approval-card"]')), '点拒绝后卡片收起')

    store.getState().openSettings('auth')
    if (await until(() => q('[data-testid="settings-section-custom-api"]'), 8000)) click(q('[data-testid="settings-section-custom-api"]'))
    if (await until(() => q('[data-testid="custom-api-add"]'), 8000)) {
      click(q('[data-testid="custom-api-add"]'))
      ok(await until(() => q('[data-testid="custom-api-fetch-models"]')), '表单里有「获取模型列表」')
      const input = q('[data-testid="custom-api-base-url"]')
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'http://127.0.0.1:9/v1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
        click(q('[data-testid="custom-api-fetch-models"]'))
        ok(await until(() => q('[data-testid="custom-api-msg"]'), 15000), '连不上的地址有提示，不崩')
        out.push('  提示：' + (q('[data-testid="custom-api-msg"]')?.textContent ?? ''))
      }
    } else {
      ok(false, '设置 → 接入 里找不到自定义服务入口')
    }

    store.setState({
      gitInstall: { phase: 'idle' },
      notices: [{ id: 'git-install', type: 'warning', text: '这台设备没有找到 git（测试）', at: Date.now(), action: 'git-install' }]
    })
    ok(await until(() => q('[data-testid="git-install-notice"]')), '缺 Git 的通知出现')
    ok(!!q('[data-testid="git-install-start"]'), '通知里有「一键安装 Git」按钮')
    store.setState({ gitInstall: { phase: 'downloading', received: 30_000_000, total: 60_000_000 } })
    ok(await until(() => q('[data-testid="git-install-progress"]')), '下载中显示进度')
    ok(/50%/.test(q('[data-testid="git-install-progress"]')?.textContent ?? ''), '进度按字节算出 50%')
    ok(!!q('[data-testid="git-install-cancel"]'), '下载中有取消按钮')
    store.setState({ gitInstall: { phase: 'error', message: '下载失败（测试）' } })
    ok(await until(() => q('[data-testid="git-install-error"]')), '出错时显示原因')
    ok(!!q('[data-testid="git-install-start"]'), '出错后可以重试')
    store.setState({ gitInstall: { phase: 'idle' }, notices: [] })
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
