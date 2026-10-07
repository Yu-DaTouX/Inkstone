/**
 * 新用户首次使用：没有任何凭证的全新数据目录下，第一屏到第一次配置的路径。
 *
 * 验的是新装设备会碰到的事，不烧 token：
 *   ① 默认工作文件夹是「文档\砚」而不是整个用户主目录；
 *   ② 命令行工具（bash / git）检测接口可用，引导里有这一行，且不再让用户去终端 `pi → /login`；
 *   ③ 日常模式首页默认不出空间 / 资料卡；
 *   ④ 权限选择器在模式菜单里，切到「每次询问」会落盘并在按钮上出徽标；
 *   ⑤ 批准卡片：权限类带「记住」，删除类没有，拒绝能把卡片收起；
 *   ⑥ 自定义服务：模型可不填，「获取模型列表」对连不上的地址给出可读错误而不是崩。
 */
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

    /* ① 默认工作文件夹 */
    const settings = await window.yan.getSettings()
    ok(/[\\/]砚$/.test(settings.cwd || ''), `默认工作文件夹是「…\\砚」（实际 ${settings.cwd}）`)
    ok(settings.permissionMode === undefined || settings.permissionMode === 'danger', '权限默认是危险批准')
    ok(settings.guardOutsideWrites !== true, '写入项目之外的确认默认关')
    ok(settings.showSpaces !== true, '空间与资料库默认收起')

    /* ② 命令行工具检测 */
    const tools = await window.yan.toolchainStatus()
    ok(!!tools && typeof tools.bash?.ok === 'boolean' && typeof tools.git?.ok === 'boolean', 'toolchainStatus 返回 bash / git 状态')
    ok(tools.bash.ok || !!tools.bash.hint, '缺 bash 时带安装说明')
    ok(tools.git.ok || !!tools.git.hint, '缺 git 时带安装说明')

    /* 引导：自动弹出或从「关于」重新打开 */
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

    /* ③ 日常首页 */
    ok(!q('[data-testid="wb-card-space"]') && !q('[data-testid="wb-card-sources"]'), '日常首页没有空间 / 资料卡')

    /* ④ 权限选择器 */
    const modeButton = q('[data-testid="work-mode-button"]')
    ok(!!modeButton, '输入区有模式按钮')
    if (modeButton) {
      click(modeButton)
      ok(await until(() => q('[data-testid="permission-option-danger"]')), '模式菜单里有权限分段')
      ok(!!q('[data-testid="permission-option-all"]') && !q('[data-testid="permission-option-ask"]'), '只有「危险批准」「全部允许」两档')
      ok(q('[data-testid="permission-option-danger"]')?.getAttribute('aria-checked') === 'true', '当前是危险批准')
      click(q('[data-testid="permission-option-all"]'))
      ok(await until(() => store.getState().settings?.permissionMode === 'all'), '选「全部允许」后写进设置')
      ok(await until(() => q('[data-testid="permission-badge"]')), '按钮上出现「全部允许」徽标')
      const saved = await window.yan.getSettings()
      ok(saved.permissionMode === 'all', '设置已落盘')
      /* 还原，别影响别的场景 */
      click(q('[data-testid="work-mode-button"]'))
      if (await until(() => q('[data-testid="permission-option-danger"]'))) click(q('[data-testid="permission-option-danger"]'))
      ok(await until(() => !q('[data-testid="permission-badge"]')), '切回危险批准后徽标消失')
    }

    /* ⑤ 批准卡片（直接往 store 放请求：验渲染与按钮，不依赖模型去触发） */
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

    /* ⑥ 自定义服务：模型可不填；获取失败给可读错误 */
    store.getState().openSettings('auth')
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

    /* ⑦ 缺 Git 的一键安装：通知里有按钮；点开始后显示进度与取消；出错能重试（不真下载：直接摆状态） */
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
