;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore
  const until = async (fn, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }

  try {
    for (let i = 0; i < 60; i++) {
      if (store.getState().conn === 'ready' && store.getState().sessions.length) break
      await sleep(500)
    }
    out.push(`  （共就绪：启动到现在 ${Math.round(performance.now() / 1000)}s，conn=${store.getState().conn}）`)
    try {
      store.getState().closeSettings?.()
    } catch {
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const sessions = store.getState().sessions
    const findAb = (tag) => sessions.find((s) => String(s.path).includes(`yan-ab-${tag}-`))
    const A = findAb('a')
    const B = findAb('b')
    const C = findAb('c')
    out.push('=== 0. 前置 ===')
    ok(!!A && !!B && !!C, `三个会话都在索引里（A=${!!A} B=${!!B} C=${!!C}）`)
    if (!A || !B || !C) return out.join('\n')
    out.push(`  A.cwd = ${A.cwd}`)
    out.push(`  B.cwd = ${B.cwd}`)
    ok(A.cwd !== B.cwd, 'A 与 B 的 cwd 不同（“能切走”的前提）')
    ok(A.cwd === C.cwd, 'A 与 C 的 cwd 相同（“同 cwd 拒绝”的前提）')

    const runnersNow = () => store.getState().runners ?? []
    const refresh = async () => {
      try {
        await store.getState().syncRunners?.()
      } catch {
      }
    }
    const runningOf = async (path) => {
      await refresh()
      return !!runnersNow().find((r) => r.sessionFile === path)?.running
    }
    const waitRunning = async (path, ms) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (await runningOf(path)) return true
        await sleep(500)
      }
      return false
    }
    const waitNotRunning = async (path, ms) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        if (!(await runningOf(path))) return true
        await sleep(500)
      }
      return false
    }
    const conflictNotices = () =>
      (store.getState().notices ?? []).filter((n) => /只读打开|同一工作目录/.test(String(n.text)))

    out.push('')
    out.push('=== 1. A 跑起来 ===')
    await store.getState().switchSession(A.path)
    const openedA = await until(() => store.getState().session?.sessionFile === A.path, 20000)
    ok(openedA, 'A 成为当前会话')
    if (!openedA) return out.join('\n')

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const LONG_TASK =
      'YAN-AB-LONG 请先用 bash 工具执行命令 sleep 30（必须真的调用工具执行，不要假装、不要省略工具调用），' +
      '等它返回后再回复一句“完成”。'
    let ta = null
    let sendable = false
    for (let i = 0; i < 20; i++) {
      ta = q('[data-testid="composer"]')
      if (ta && ta.isConnected) {
        setter.call(ta, LONG_TASK)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(400)
        const btn = q('[data-testid="send"]')
        if (btn && !btn.disabled) {
          sendable = true
          break
        }
      }
      await sleep(500)
    }
    out.push(`  composer 就绪=${!!ta?.isConnected} conn=${store.getState().conn}`)
    ok(sendable, '输入后发送键可用')
    if (!sendable) return out.join('\n')

    const send = q('[data-testid="send"]')
    const t0 = Date.now()
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(4000)
    out.push(
      `  诊断(发送后 4s，用时 ${Math.round((Date.now() - t0) / 1000)}s)：conn=${store.getState().conn}` +
        ` isAgentRunning=${store.getState().session?.isAgentRunning}` +
        ` activeRunnerId=${store.getState().activeRunnerId}`
    )
    out.push(
      '  诊断 notices = ' +
        JSON.stringify((store.getState().notices ?? []).map((n) => n.type + ':' + String(n.text).slice(0, 40)))
    )
    out.push(
      '  诊断 messages = ' +
        store
          .getState()
          .messages.slice(-3)
          .map((m) => m.role + ':' + String(m.text ?? '').slice(0, 28))
          .join(' | ')
    )

    const started = await waitRunning(A.path, 30000)
    out.push(`  runners = ${JSON.stringify(runnersNow().map((r) => ({ id: r.id, f: String(r.sessionFile).split(/[\\/]/).pop()?.slice(-16), run: r.running, cwd: String(r.cwd).split(/[\\/]/).pop() })))}`)
    ok(started, 'A 进入运行中（真的起了运行实例）')
    if (!started) {
      out.push('  （A 没跑起来，后面的后台断言没有意义，提前收工）')
      return out.join('\n')
    }

    out.push('')
    out.push('=== 2. 切到 B：允许，且 A 不能被停掉 ===')
    await store.getState().switchSession(B.path)
    const openedB = await until(() => store.getState().session?.sessionFile === B.path, 20000)
    ok(openedB, 'B 被打开（不同 cwd 允许并行）')
    ok(await runningOf(A.path), '**切走之后 A 仍在运行**（后台会话没被停掉）')
    ok(!conflictNotices().length, '切到不同 cwd 的 B 没有冲突提示')
    const streamText = q('.stream')?.textContent ?? ''
    ok(streamText.includes('YAN-AB-B-REPLY'), 'B 的视图里是 B 自己的消息')
    ok(!streamText.includes('YAN-AB-LONG'), 'B 的视图里没有 A 的输入文本')
    ok(!/^1\n2\n3/m.test(streamText), 'B 的视图里没有 A 的“数数”输出')

    out.push('')
    out.push('=== 3. 同 cwd 的另一个会话：明确拒绝 ===')
    const stillB = store.getState().session?.sessionFile
    await store.getState().switchSession(C.path)
    const deferred = await until(
      () => conflictNotices().some((n) => /只读打开/.test(String(n.text))),
      15000
    )
    ok(deferred, '给出「同目录会话先只读打开，发送前安全切换」提示')
    out.push('  冲突提示 = ' + JSON.stringify(conflictNotices().map((n) => n.text)))
    const activeRunner = runnersNow().find((r) => r.id === store.getState().activeRunnerId)
    ok(
      !!store.getState().pendingActivation && activeRunner?.sessionFile === stillB,
      'C 只读打开（记下待激活），活动运行订阅仍留在 B'
    )
    ok(!!q('.notices .notice.info'), '提示渲染到了界面上（不只是进了 store）')
    ok(await runningOf(A.path), '被拒之后 A 还在跑')

    out.push('')
    out.push('=== 3.5 未读：后台会话完成 ===')
    const unreadRow = () => qa('[data-session-path]').find((e) => e.dataset.sessionPath === A.path)
    out.push(`  窗口有焦点 = ${document.hasFocus()}（未读只在“不在前台”时标）`)
    ok(!!unreadRow(), '（前提）左栏找得到 A 那一行')
    const t0fin = Date.now()
    let finished = false
    while (Date.now() - t0fin < 180000) {
      await store.getState().syncRunners()
      const r = runnersNow().find((x) => x.sessionFile === A.path)
      if (r && r.running === false) {
        finished = true
        break
      }
      await sleep(1000)
    }
    ok(finished, 'A 在后台**自然**跑完（实例还在，只是不再 running）', `${Math.round((Date.now() - t0fin) / 1000)}s`)
    const dot = await until(() => !!unreadRow()?.querySelector('[data-testid="rail-unread"]'), 12000)
    ok(!!dot, '后台会话跑完之后，左栏那一行出现未读标记')

    out.push('')
    out.push('=== 4. 切回 A：内容不丢、不串 ===')
    await store.getState().switchSession(A.path)
    const rowA = qa('[data-session-path]').find((e) => e.dataset.sessionPath === A.path)
    const nameBtn = rowA?.querySelector('button.srow')
    ok(!!nameBtn, '（前提）左栏那一行有可点的会话按钮')
    if (nameBtn) nameBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const backA = await until(() => store.getState().session?.sessionFile === A.path, 15000)
    ok(backA, '切回 A')
    const cleared = await until(() => !unreadRow()?.querySelector('[data-testid="rail-unread"]'), 8000)
    ok(!!cleared, '切回之后 A 的未读标记消掉了')
    if (backA) {
      const msgs = store.getState().messages
      ok(
        msgs.some((m) => m.role === 'user' && String(m.text ?? '').includes('YAN-AB-LONG')),
        'A 的用户消息还在'
      )
      ok(!(q('.stream')?.textContent ?? '').includes('YAN-AB-B-REPLY'), 'A 的视图里没有 B 的消息')
      const aText = qa('.msg.assistant .md').map((e) => e.textContent).join('')
      out.push(`  A 助手正文长度 = ${aText.length}`)
      ok(aText.length > 0, 'A 的回复内容在视图里（切回来不是空的）')
    }

    out.push('')
    out.push('=== 5. 单独停止 A ===')
    const runningBeforeStop = await runningOf(A.path)
    out.push(`  停止前 A.running = ${runningBeforeStop}`)
    if (runningBeforeStop) {
      const row = qa('[data-session-path]').find((e) => e.dataset.sessionPath === A.path)
      ok(!!row, '左栏能找到 A 这一行')
      const actBtn = row?.querySelector('.srow-acts button')
      ok(!!actBtn, 'A 行有动作按钮')
      if (actBtn) {
        actBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(500)
      }
      const stopBtn = q('[data-testid="rail-stop-runner"]')
      out.push(`  send 按钮文本 = ${JSON.stringify((q('[data-testid="send"]')?.textContent ?? '').trim())}`)
      ok(!!stopBtn, '菜单里有「停止运行」')
      if (stopBtn) {
        stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        const stopped = await waitNotRunning(A.path, 45000)
        ok(stopped, '停止运行之后 A 确实停了')
      }
    } else {
      out.push('  （A 已在 3.5 节自然跑完，这里跳过停止断言）')
    }
    const settled = await until(() => !q('.cursor'), 15000)
    ok(settled, '停止后没有残留的流式光标')

    await sleep(300)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
