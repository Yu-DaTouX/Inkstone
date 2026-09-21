/**
 * N12：真实 A/B 会话的后台生命周期。
 *
 * 三个合成会话（由 test-live 的 writeAbSessions 造好，cwd 指向 fixture 项目）：
 *   A  cwd=fixture/repo   发一个长任务，让它真的跑起来
 *   B  cwd=fixture/other  不同工作目录 —— 切过去必须被允许
 *   C  cwd=fixture/repo   与 A 同工作目录 —— 切过去必须被明确拒绝
 *
 * 要验的不是“界面切过去了”，而是**运行实例的身份**：
 *   · 切走之后 A 有没有被顺手停掉（切走不停）；
 *   · 切回来时看到的是不是 A 自己的内容（切回不串）；
 *   · 同 cwd 的第二个实例有没有被拒绝，且拒绝之后 A 还在跑；
 *   · 单独停 A 之后界面是否回到可输入态。
 *
 * 会话切换统一走 store 的 switchSession（和点左栏行是同一个入口），
 * 这样不受左栏分组、滚动位置和搜索态的影响。
 */
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
      /* 没开就不用关 */
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

    /*
     * 运行实例的判定：按会话文件找 runner，看它的 running 位。
     *
     * ⚠️ 必须主动 `syncRunners()` 拉一次：主进程只在实例增删/切换时推 `runners`
     * 快照，`running` 这种随模型状态变的位会滞后 —— 直接读 store 里的旧快照，
     * 会出现“前端 session.isAgentRunning=true 而 runners 里 running=false”的矛盾。
     */
    const runnersNow = () => store.getState().runners ?? []
    const refresh = async () => {
      try {
        await store.getState().syncRunners?.()
      } catch {
        /* 拉取失败就用现有快照 */
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
    const errorNotices = () => (store.getState().notices ?? []).filter((n) => n.type === 'error')

    /* ---- 1. 打开 A 并发一个长任务 ---- */
    out.push('')
    out.push('=== 1. A 跑起来 ===')
    await store.getState().switchSession(A.path)
    const openedA = await until(() => store.getState().session?.sessionFile === A.path, 20000)
    ok(openedA, 'A 成为当前会话')
    if (!openedA) return out.join('\n')

    /*
     * 输入必须走原生 setter（React 受控组件），而且要在**会话真正挂载完**之后做：
     * 切会话会让 Composer 重新挂载，先前取到的 textarea 会脱离文档，
     * 对它派发 input 没有任何效果 —— 表现为“发送键仍然是灰的”。
     * 所以这里重取 DOM 直到发送键真的可用。
     */
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    /*
     * 任务设计成“真的跑一个耗时命令”，而不是“生成一段长文本”：
     * 模型写长文本只用几秒（实测 4s 就数完了），根本来不及验“切走之后还在跑”；
     * 而一个 `sleep` 工具调用能让它真地忙碌起来，而且 running 位是确定的。
     */
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
    /* 诊断：发送后如果真的没跑起来，得看出是连接、报错还是事件没到 */
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

    /* ---- 2. 切到 B（不同 cwd）---- */
    out.push('')
    out.push('=== 2. 切到 B：允许，且 A 不能被停掉 ===')
    const beforeNotices = errorNotices().length
    await store.getState().switchSession(B.path)
    const openedB = await until(() => store.getState().session?.sessionFile === B.path, 20000)
    ok(openedB, 'B 被打开（不同 cwd 允许并行）')
    ok(await runningOf(A.path), '**切走之后 A 仍在运行**（后台会话没被停掉）')
    ok(errorNotices().length === beforeNotices, '切到 B 没有产生错误提示')
    const streamText = q('.stream')?.textContent ?? ''
    ok(streamText.includes('YAN-AB-B-REPLY'), 'B 的视图里是 B 自己的消息')
    ok(!streamText.includes('YAN-AB-LONG'), 'B 的视图里没有 A 的输入文本')
    ok(!/^1\n2\n3/m.test(streamText), 'B 的视图里没有 A 的“数数”输出')

    /* ---- 3. 切到 C（同 cwd）→ 明确拒绝 ---- */
    out.push('')
    out.push('=== 3. 同 cwd 的另一个会话：明确拒绝 ===')
    const stillB = store.getState().session?.sessionFile
    await store.getState().switchSession(C.path)
    const refused = await until(
      () => errorNotices().some((n) => /同一工作目录/.test(String(n.text))),
      15000
    )
    ok(refused, '给出「同一工作目录已有运行中的会话」错误提示')
    out.push('  错误提示 = ' + JSON.stringify(errorNotices().map((n) => n.text)))
    ok(store.getState().session?.sessionFile === stillB, '视图没有被切到 C（拒绝是彻底的）')
    ok(!!q('.notices .notice.error'), '提示渲染到了界面上（不只是进了 store）')
    ok(await runningOf(A.path), '被拒之后 A 还在跑')

    /*
     * ---- 3.5 未读（N12 的第三种后台状态，真实窗口）----
     *
     * 规则（`Rail.tsx` 的 `runnersSeen`）：某个实例从 running 变 not running，
     * 且窗口不在前台 → 把那行标未读。这里故意**在 B 上停掉 A**：
     * 此刻当前会话是 B、窗口是隐藏的（test-live 默认 `YAN_PROBE_HIDDEN=1`），
     * 于是 A 应该被标未读 —— 这正是「后台会话干完了活，用户还不知道」的形态。
     * 放在第 3 节**之后**：那里有一条「被拒之后 A 还在跑」，提前停会把它变成假红。
     */
    out.push('')
    out.push('=== 3.5 未读：后台会话完成 ===')
    const unreadRow = () => qa('[data-session-path]').find((e) => e.dataset.sessionPath === A.path)
    out.push(`  窗口有焦点 = ${document.hasFocus()}（未读只在“不在前台”时标）`)
    ok(!!unreadRow(), '（前提）左栏找得到 A 那一行')
    /*
     * 必须是**自然跑完**，不能 `stopRunner`。
     *
     * 未读的判据是「上一次快照 `running=true` → 这次 `running=false`」（Rail 的
     * `runnersSeen`）—— 而 `stopRunner` 会把这个实例从注册表里**删掉**，
     * 下一次快照里根本没有它，循环也就不会去比较。第一版就是这么写的，
     * 结果标记永远不出现（而且“切回后未读清掉”那条还会假绿）。
     */
    const t0fin = Date.now()
    let finished = false
    /* 本地 llama.cpp 的工具回合可能在 90s 后才收到最终 assistant 事件；
     * 这条断言验证的是“后台自然结束”，不应把本地模型速度当成并发回归。 */
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

    /* ---- 4. 切回 A：内容还在、不串 ---- */
    out.push('')
    out.push('=== 4. 切回 A：内容不丢、不串 ===')
    await store.getState().switchSession(A.path)
    /*
     * 切回去要**点左栏那一行**，不能用 `store.switchSession`。
     * 清除未读就在 `select()` 里（点了才算看过）—— 直接调 action 会绕过它，
     * 于是「切回后未读消掉」这条断言会假红（第一版就是这样）。
     */
    const rowA = qa('[data-session-path]').find((e) => e.dataset.sessionPath === A.path)
    const nameBtn = rowA?.querySelector('button.srow')
    ok(!!nameBtn, '（前提）左栏那一行有可点的会话按钮')
    if (nameBtn) nameBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const backA = await until(() => store.getState().session?.sessionFile === A.path, 15000)
    ok(backA, '切回 A')
    /* 打开就清未读：用户已经看到那条结果了（未读标记的语义就是“还没看”） */
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

    /* ---- 5. 单独停 A ---- */
    out.push('')
    out.push('=== 5. 单独停止 A ===')
    const runningBeforeStop = await runningOf(A.path)
    out.push(`  停止前 A.running = ${runningBeforeStop}`)
    if (runningBeforeStop) {
      /*
       * 用左栏行的「停止运行」：这是**后台会话也能用**的入口。
       *
       * 为什么不用输入框那个按钮：`busy` 取的是 `session.isStreaming`，
       * 而它只在“有一条 assistant 消息在流”时为真 —— 工具执行期间是 false
       * （见 `agent.ts` 的 markStreaming 注释），那时按钮显示“发送”。
       * 所以“正在跑工具的任务”要在左栏菜单里停。
       */
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
