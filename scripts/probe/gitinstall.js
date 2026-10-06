/**
 * 真实的一键安装 Git（会联网下载约 57MB，只在 YAN_REAL_GIT_DOWNLOAD=1 时由 test-live 跑）。
 *
 * 没有 Git 的环境（PATH 与 Program Files 里都没有）里走完整条用户路径：
 *   点「一键安装 Git」→ 下载 → SHA-256 校验 → 自解压 → 通知收起 → pi 重启后连接恢复 →
 *   直执行 bash 命令命中受管的那份（pi 真的找到了 bash，不是退到了别处）。
 * 数据目录是隔离的临时目录，测试结束整个删除。
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
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(200)
    }
    await sleep(1000)

    ok(await until(() => q('[data-testid="git-install-start"]')), '缺 Git 的通知里有安装按钮')
    const before = await window.yan.toolchainStatus()
    ok(before.git.ok === false && before.bash.ok === false, '安装前：没有 git，也没有 bash')

    const phases = new Set()
    const watcher = setInterval(() => phases.add(store.getState().gitInstall.phase), 100)
    click(q('[data-testid="git-install-start"]'))
    ok(await until(() => store.getState().gitInstall.phase !== 'idle', 5000), '点击后立刻进入安装状态')
    ok(await until(() => store.getState().gitInstall.phase === 'done' || store.getState().gitInstall.phase === 'error', 240000), '安装在 4 分钟内结束')
    clearInterval(watcher)
    const finalState = store.getState().gitInstall
    ok(finalState.phase === 'done', `安装成功（${finalState.phase}：${finalState.message ?? ''}）`)
    ok(phases.has('downloading'), '经历了下载阶段')

    ok(await until(() => !q('[data-testid="git-install-notice"]'), 5000), '装好后「缺 Git」通知收起')

    const after = await window.yan.toolchainStatus()
    ok(after.git.ok === true && after.git.managed === true, `安装后 git 可用且来自受管目录（${after.git.path}）`)
    ok(after.bash.ok === true && after.bash.managed === true, `安装后 bash 可用且来自受管目录（${after.bash.path}）`)
    const runtime = await window.yan.gitRuntimeStatus()
    ok(runtime.managedInstalled === true && !runtime.installing, '受管 Git 状态：已安装、不在安装中')

    /* 装好后主进程会重启 pi（让它的 PATH 带上新装的 bash）：等它重新就绪 */
    await sleep(1500)
    ok(await until(() => store.getState().conn === 'ready', 60000), 'pi 重启后连接恢复就绪')

    /* 直执行 bash（不经模型）：输出里带 MSYS 的 uname，说明 pi 用的就是受管的 Git Bash */
    /* 重启后渲染端要先对齐新的运行实例身份，太早发会被当作旧实例的消息丢掉 */
    await sleep(4000)
    out.push('  诊断 runners：' + JSON.stringify(store.getState().runners?.map((r) => ({ id: r.id, gen: r.generation, running: r.running })) ?? null) + ' active=' + store.getState().activeRunnerId)
    /* 走界面同一条路径：输入框里 ! 开头 + 发送（与 features 探针一致） */
    const ta = q('[data-testid="composer"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '!echo MANAGED_BASH_OK && uname -s')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    ok(!!q('.mode-badge.bash'), '输入框进入 bash 模式')
    click(q('[data-testid="send"]'))
    /* 输出在 .msg.bash 的工具行里：已完成的步骤默认折叠，等它出现后展开再读 */
    let text = ''
    const sawOutput = await until(() => {
      const fold = q('.msg.bash [data-testid="tool-group-toggle"]')
      if (fold && fold.getAttribute('aria-expanded') === 'false') click(fold)
      const row = q('.msg.bash .trow')
      const head = row?.querySelector('.trow-head')
      if (row && head && !row.classList.contains('open') && row.dataset.state !== 'running' && row.dataset.state !== 'pending') click(head)
      text = q('.msg.bash')?.textContent ?? ''
      return /MINGW|MSYS/.test(text)
    }, 40000)
    out.push('  输出片段：' + JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 120)))
    if (!sawOutput) {
      out.push('  诊断 对话区：' + JSON.stringify((q('.stream')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400)))
      out.push('  诊断 通知：' + JSON.stringify(store.getState().notices.map((n) => n.text)))
      out.push('  诊断 conn：' + store.getState().conn + ' ' + (store.getState().connDetail ?? ''))
    }
    ok(sawOutput, '直执行 bash 的输出出现在对话里（pi 找到了 bash）')
    ok(/MINGW|MSYS/.test(text), '输出里带 MINGW / MSYS：确实是 Git Bash')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
