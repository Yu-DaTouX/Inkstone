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

    await sleep(1500)
    ok(await until(() => store.getState().conn === 'ready', 60000), 'pi 重启后连接恢复就绪')

    await sleep(4000)
    out.push('  诊断 runners：' + JSON.stringify(store.getState().runners?.map((r) => ({ id: r.id, gen: r.generation, running: r.running })) ?? null) + ' active=' + store.getState().activeRunnerId)
    const ta = q('[data-testid="composer"]')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, '!echo MANAGED_BASH_OK && uname -s')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    ok(!!q('.mode-badge.bash'), '输入框进入 bash 模式')
    click(q('[data-testid="send"]'))
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
