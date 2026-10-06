/**
 * 没有 Git 的新设备（PATH 里没有 git / bash，Program Files 也被指到不存在的目录）：
 * 启动后给出带「一键安装 Git」按钮的通知，引导里同样有入口，状态接口如实报告缺失；
 * pi 仍然能起来、连接就绪（bash 工具退到 PowerShell，不是整个应用起不来）。
 * 不真的下载：下载与校验流程由 scripts/test-git-runtime.mjs 覆盖。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 8000) => {
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
    await sleep(1000)

    const tools = await window.yan.toolchainStatus()
    ok(tools.git.ok === false && !!tools.git.hint, `状态接口如实报告没有 git（${JSON.stringify(tools.git)}）`)
    ok(tools.bash.ok === false && !!tools.bash.hint, `状态接口如实报告没有 bash（${JSON.stringify(tools.bash)}）`)
    ok(/一键安装/.test(tools.git.hint), '说明里写了可以一键安装')

    const runtime = await window.yan.gitRuntimeStatus()
    ok(runtime.supported === true && runtime.systemGit === false && runtime.systemBash === false, '受管 Git 状态：Windows 支持、系统无 git / bash')
    ok(runtime.managedInstalled === false && runtime.installing === false, '还没装受管 Git，也不在安装中')
    ok(runtime.downloadSize > 50_000_000 && runtime.downloadSize < 100_000_000, `下载大小提示合理（${runtime.downloadSize}）`)

    ok(await until(() => q('[data-testid="git-install-notice"]')), '启动后出现缺 Git 的通知')
    ok(!!q('[data-testid="git-install-start"]'), '通知里有「一键安装 Git」按钮')
    ok(!q('[data-testid="git-install-progress"]'), '没点之前不会自己开始下载')

    ok(await until(() => store.getState().conn === 'ready', 20000), '没有 Git 也能连上 pi（命令行工具退到 PowerShell）')

    /* 引导里也有入口 */
    if (!q('.ob-card')) {
      store.getState().openSettings('about')
      if (await until(() => q('[data-testid="ob-reopen"]'))) q('[data-testid="ob-reopen"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    if (await until(() => q('.ob-card'))) {
      ok(q('[data-testid="ob-tools"]')?.getAttribute('data-ok') === '0', '引导里命令行工具一行标为待办')
      ok(!!q('[data-testid="ob-tools"] [data-testid="git-install-start"]'), '引导那一行也有一键安装')
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
