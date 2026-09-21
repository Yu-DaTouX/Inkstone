/**
 * 后台会话「等待输入」的真实窗口证据（实施-09 S2 第二批，N12）。
 *
 * ── 这一态是什么 ──
 * 左栏那一行的 `?` 状态槽（`rail.waiting`），真源是
 * `RunnerStatus.waiting = agent.getPendingUiCount() > 0`，也就是
 * **这个会话有一个还没回答的提问面板**。它的产生路径是真东西：
 * 内置 `question` 扩展调 `ctx.ui.select` → pi 发 `extension_ui_request`
 * → 主进程记进 `pendingUi` → `runners` 快照里那一行 `waiting=true`。
 *
 * ── 为什么单独一条场景 ──
 * `ask`（cost 1）已经证了提问链路本身，但它全程停在**前台**；
 * N12 缺的是「后台会话在等输入」这个形态：用户已经切走，
 * 而那个会话还挂着问题。所以这里：
 *   打开 A → 发提问提示词 → 等真的出现 ui-request
 *   → 断言 A 行有 `?`（前台）
 *   → 切到 B（不同 cwd）→ 断言 A 行**仍有** `?`（后台，这就是缺的那条证据）
 *
 * 全程不回答问题：问题面板留着，退出时随实例一起消失。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  /** 硬截止：留足时间给测试框架收输出 */
  const deadline = Date.now() + 110000
  /**
   * ⚠️ 谓词可以返回 Promise，所以必须 `await fn()`。
   * 写成 `if (fn())` 的话，对 async 谓词永远是真（Promise 本身是 truthy）——
   * 看起来会立即返回，实际上只试了一次就拿到 null（本探针第一版就这么掉的）。
   */
  const waitFor = async (fn, step = 300) => {
    while (Date.now() < deadline) {
      const v = await fn()
      if (v) return v
      await sleep(step)
    }
    return null
  }
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const rowOf = (path) => qa('[data-session-path]').find((e) => norm(e.dataset.sessionPath) === norm(path))

  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  try {
    /* 引导层：没走完的话左栏不是我们要的样子 */
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(250)
      } else await sleep(120)
    }

    /*
     * 工作模式必须是标准：自主模式下 `question` 工具一开头就返回
     * 「请自行决策」，根本不发 ui-request（这是它的设计，不是故障）。
     */
    await store.getState().setWorkMode('standard')
    await sleep(400)
    ok(store.getState().conn === 'ready', 'pi 已连接', String(store.getState().conn))
    await store.getState().setRailPinned(true)

    /* ── 0. 找到 fixture 的 A / B ───────────────────────── */
    const list = await waitFor(() => {
      const all = store.getState().sessions ?? []
      const a = all.find((s) => String(s.id ?? '').includes('yan-ab-a'))
      const b = all.find((s) => String(s.id ?? '').includes('yan-ab-b'))
      return a && b ? { a, b } : null
    }, 400)
    if (!ok(!!list, '会话列表里有 N12 的 A / B 两条 fixture 会话'))
      return out.join('\n')
    const { a: A, b: B } = list
    out.push(`  A=${A.id}（${A.cwd}）`)
    out.push(`  B=${B.id}（${B.cwd}）`)
    await store.getState().refreshSessions()
    await sleep(300)

    /* ── 1. 打开 A 并发一条要求提问的消息 ────────────────── */
    out.push('')
    out.push('=== 1. 在 A 上触发一次提问 ===')
    const rowA = rowOf(A.path)
    const nameA = rowA?.querySelector('button.srow')
    if (nameA) click(nameA)
    else await store.getState().switchSession(A.path)
    const onA = await waitFor(() => (norm(store.getState().session?.sessionFile) === norm(A.path) ? true : null), 400)
    ok(!!onA, 'A 成为当前会话')

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const prompt =
      '这是一次功能自测。请只做一件事：调用 question 工具询问我「用哪种数据库？」，' +
      '选项给 SQLite 和 PostgreSQL。不要用普通文字提问，不要做其它事，不要执行命令。'
    let sendable = false
    for (let i = 0; i < 20 && Date.now() < deadline; i++) {
      const ta = q('[data-testid="composer"]')
      if (ta && ta.isConnected) {
        setter.call(ta, prompt)
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
    ok(sendable, '输入后发送键可用')
    if (!sendable) return out.join('\n')
    click(q('[data-testid="send"]'))

    /* ── 2. 等真的出现 ui-request（这是 waiting 的真源）── */
    out.push('')
    out.push('=== 2. A 出现未回答的提问 ===')
    const pending = await waitFor(async () => {
      /* waiting 位来自主进程的运行实例快照 —— 必须主动拉一次才新鲜 */
      await store.getState().syncRunners()
      const reqs = store.getState().uiRequests ?? []
      const r = (store.getState().runners ?? []).find((x) => norm(x.sessionFile) === norm(A.path))
      return reqs.length > 0 && r ? { reqs, r } : null
    }, 500)
    ok(!!pending, '主进程收到了 pi 的 UI 请求（pendingUi 非空）', String(pending?.reqs?.length ?? 0))
    if (!pending) {
      out.push('  最近助手文字：' + JSON.stringify(String(store.getState().messages.at(-1)?.text ?? '').slice(0, 200)))
      out.push('  question 工具行：' + qa('.trow').some((r) => r.getAttribute('data-tool') === 'question'))
      return out.join('\n')
    }
    ok(pending.r.waiting === true, 'A 的运行实例被标成 waiting（主进程侧的真源）', JSON.stringify(pending.r.waiting))
    const panel = q('[data-testid="question-panel"]')
    ok(!!panel, '提问面板渲染出来了（非模态，在输入区上方）')
    const waitA = await waitFor(() => qa('[data-testid="rail-waiting"]').some((e) => rowOf(A.path)?.contains(e)), 300)
    ok(!!waitA, '左栏 A 那一行显示「等待输入」状态槽（前台）')
    out.push(`  A 行状态槽 = ${JSON.stringify((rowOf(A.path)?.querySelector('.session-status')?.getAttribute('title')) ?? '')}`)

    /* ── 3. 切到 B：A 变成**后台**等待输入 ──────────────── */
    out.push('')
    out.push('=== 3. 切走之后：后台会话仍在等输入 ===')
    const rowB = rowOf(B.path)
    const nameB = rowB?.querySelector('button.srow')
    ok(!!nameB, '（前提）左栏能找到 B 那一行并点它')
    if (nameB) click(nameB)
    const onB = await waitFor(() => (norm(store.getState().session?.sessionFile) === norm(B.path) ? true : null), 400)
    ok(!!onB, '视图切到了 B（不同 cwd，允许并行）')
    const stillWaiting = await waitFor(async () => {
      await store.getState().syncRunners()
      const slot = qa('[data-testid="rail-waiting"]').find((e) => rowOf(A.path)?.contains(e))
      return slot ? true : null
    }, 400)
    ok(!!stillWaiting, '**切走之后 A 那一行仍然显示「等待输入」**（这就是缺的那条真实窗口证据）')
    const rA = (store.getState().runners ?? []).find((x) => norm(x.sessionFile) === norm(A.path))
    out.push(`  A 实例 = ${JSON.stringify({ running: rA?.running, waiting: rA?.waiting, conn: rA?.conn })}`)
    ok(rA?.waiting === true, '主进程侧 A 仍然是 waiting（不是前端留下的残影）')
    ok(
      !qa('[data-testid="rail-waiting"]').some((e) => rowOf(B.path)?.contains(e)),
      'B 那一行没有 waiting 槽（状态是按会话分开的，不是全局一个）'
    )
    out.push(`  askbackground.A=${A.id}`)
    out.push(`  askbackground.B=${B.id}`)

    /* 收工：问题留着不答 —— 实例与面板随退出一起消失 */
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
