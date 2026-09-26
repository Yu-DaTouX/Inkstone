/**
 * 运行实例「失败」态的真实窗口证据（实施-09 S2 第四批，N12 的最后一态）。
 *
 * ── 这一态是什么 ──
 * 左栏那一行的失败槽（`rail-failed`，`alert-circle`），真源是
 * `RunnerStatus.failed = conn === 'error' || conn === 'exited'`
 *（`src/main/runners.ts`）—— 也就是这个会话的 pi 进程根本没起来 / 已经退出。
 *
 * ── 怎么造的（这是真实故障，不是 mock 内部状态）──
 * 场景把 `YAN_PI_BIN` 指向一个**存在但立即 `process.exit(3)`** 的文件，
 * 模拟「内置运行时损坏 / 版本不匹配」。为什么必须真写文件：`resolvePi` 对
 * `YAN_PI_BIN` 只做 `existsSync`，路径不存在会被静默忽略并回落到内置 pi
 *（那是刻意的降级：坏设置不该让应用打不开）。所以假路径测不出这一态。
 *
 * 应用启动时主进程总会 `runners.startPrimary(...)` 建主实例，因此这里
 * **不需要**主动开新会话 —— 只要等那个实例暴露出 failed。
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
  const deadline = Date.now() + 90000
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
    await store.getState().setRailPinned(true)
    await sleep(400)

    /* ── 1. 主进程侧：pi 进程起不来 ───────────────────────── */
    out.push('=== 1. 坏 pi 入口 → 实例进失败态 ===')
    const failed = await waitFor(async () => {
      await store.getState().syncRunners()
      const list = store.getState().runners ?? []
      return list.find((r) => r.failed === true) ?? null
    }, 400)
    ok(!!failed, '运行实例进入失败态（failed=true）')
    if (!failed) {
      out.push('  runners = ' + JSON.stringify((store.getState().runners ?? []).map((r) => ({ c: r.conn, f: r.failed }))))
      out.push('  conn = ' + String(store.getState().conn))
      return out.join('\n')
    }
    out.push(`  实例 = ${JSON.stringify({ conn: failed.conn, failed: failed.failed, sessionFile: failed.sessionFile })}`)
    ok(failed.conn === 'exited' || failed.conn === 'error', '连接态是 exited / error（真源判据）', String(failed.conn))

    /*
     * ── 2. 渲染端拿到了这个状态 ─────────────────────────────
     *
     * ⚠️ 实测发现（2026-09-19）：启动时主进程把主实例建在一条**空会话**上
     *（`doStartAgent` 不带 restore），而空会话不会出现在 `listSessions` 里
     * —— 所以这个形态下**左栏根本没有那一行**，失败槽无处可画。
     * 用户能看到的是「模型未就绪」那一档提示。这不是本场景没测好，
     * 而是这条路径的真实样子；要在左栏看到失败槽，得是「已经存在的会话
     * 在运行中崩掉」，那需要能杀掉 pi 子进程（渲染端拿不到 pid）。
     */
    out.push('')
    out.push('=== 2. 渲染端收到了失败 ===')
    const rt = await waitFor(
      () =>
        store.getState().conn === 'exited' || store.getState().conn === 'error'
          ? store.getState().conn
          : null,
      400
    )
    ok(!!rt, '渲染端的连接态也落到 exited / error（状态真的推到了界面）', String(rt))

    const post = await waitFor(() => {
      const picker = q('[data-testid="model-picker"]')
      return picker && /未就绪|not ready/i.test(picker.textContent ?? '') ? picker : null
    }, 400)
    ok(!!post, '输入区的模型选择器显示「未就绪」（pi 起不来时用户看到的就是它）')
    if (post) out.push('  选择器文字 = ' + JSON.stringify((post.textContent ?? '').trim()))

    await store.getState().refreshSessions()
    await sleep(400)
    const target = norm(failed.sessionFile)
    const listed = (store.getState().sessions ?? []).some((s) => norm(s.path) === target)
    out.push('  实例会话在左栏列表里 = ' + listed + '（空会话不进列表 —— 见上面那段说明）')
    const notices = (store.getState().notices ?? []).filter((n) => n.type === 'error')
    out.push('  错误提示 = ' + JSON.stringify(notices.map((n) => String(n.text).slice(0, 90))))
    /*
     * 条件断言：若实例会话确实在列表里（将来主实例改成接回上次会话时就会），
     * 失败槽必须在。现在没有那一行，跳过而不是假绿/假红。
     */
    if (listed) {
      const slot = await waitFor(() => {
        const row = rowOf(String(failed.sessionFile))
        return row?.querySelector('[data-testid="rail-failed"]') ?? null
      }, 300)
      ok(!!slot, '左栏那一行显示了失败状态槽')
      if (slot) out.push('  失败槽 title = ' + JSON.stringify(slot.getAttribute('title')))
    } else {
      out.push('  （跳过左栏失败槽：这条路径下没有可画的会话行）')
    }

    /*
     * ── 3. 用户真的动手时得到什么反馈 ────────────────────
     *
     * 「起不来」本身不可怕，可怕的是静默 —— 用户敲了消息、界面没反应。
     * 这里真调一次 send（不走 UI 的发送键：pi 未就绪时它可能是灰的），
     * 看有没有一条看得懂的失败信息。
     */
    out.push('')
    out.push('=== 3. 操作时得到的反馈 ===')
    let sentResult
    try {
      sentResult = await store.getState().send('YAN-RUNNERFAILED 探针消息')
    } catch (error) {
      sentResult = { threw: String(error?.message ?? error) }
    }
    out.push('  send 返回 = ' + JSON.stringify(sentResult))
    const errNotice = await waitFor(
      () => (store.getState().notices ?? []).find((n) => n.type === 'error') ?? null,
      500
    )
    /* send 在未就绪时会直接返回 false（不是 {ok:false}）—— 两种都算拒绝 */
    const refused = sentResult === false || (sentResult && sentResult.ok === false)
    ok(
      !!errNotice || refused,
      '发消息时给出了明确反馈（错误提示，或 send 直接返回 ok:false）'
    )
    if (errNotice) out.push('  提示 = ' + JSON.stringify(String(errNotice.text ?? '').slice(0, 160)))
    if (!errNotice && refused) out.push('  send 的错误 = ' + JSON.stringify(String(sentResult.error ?? '')))

    /*
     * ── 4. 同一条坏入口下的子代理（L03）───────────────
     *
     * 主实例起不来时子代理走的是同一个 `resolvePi` —— 它也必须**如实失败并
     * 收口**，不能留在「运行中」占着名额（那会让用户看到一个永远不会动的任务）。
     * 这一节同时是 L03「启动 / 超时失败恢复」在真实链路上的取证：
     * 不拿 mock 状态顶替，走的还是那个 `exit(3)` 的文件。
     */
    out.push('')
    out.push('=== 4. 坏 pi 入口下的子代理 ===')
    ok(!q('[data-testid="subagent-new"]'), '专用子代理入口已撤下（U4）')
    const subTask = 'YAN-SUBAGENT-BOOT 探针任务'
    await store.getState().startSubagent(subTask)
    const subRun = await waitFor(() => {
      const r = (store.getState().subagents ?? []).find((x) => x.task === subTask)
      return r && ['error', 'cancelled', 'done'].includes(r.status) ? r : null
    }, 400)
    ok(!!subRun, '子代理跑到了终态（没卡在「运行中」）', String(subRun?.status))
    if (subRun) {
      out.push(`  status=${subRun.status} error=${JSON.stringify(subRun.error ?? null)}`)
      ok(subRun.status === 'error', '子代理终态是 error（与主实例同一故障）', String(subRun.status))
      ok(/超时|提前退出|失败/.test(subRun.error ?? ''), '错误文本可读（不是空）', JSON.stringify(subRun.error))
      /* finalize 在终态之后跑：等 diff 出现再判收口 */
      const closedRun = await waitFor(() => {
        const r = (store.getState().subagents ?? []).find((x) => x.task === subTask)
        return r?.diff !== undefined ? r : null
      }, 500)
      out.push(`  review=${closedRun?.review} diffFiles=${closedRun?.diff?.files}`)
      ok(
        closedRun?.review === 'none' || closedRun?.review === 'pending' || closedRun?.review === 'conflict',
        '隔离工作区已定态（不留在半途）',
        String(closedRun?.review)
      )
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
