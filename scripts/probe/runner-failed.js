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
      return picker && /未就绪|未选模型|not ready/i.test(picker.textContent ?? '') ? picker : null
    }, 400)
    ok(!!post, '输入区的模型选择器显示「未选模型」（pi 起不来时用户看到的就是它）')
    if (post) out.push('  选择器文字 = ' + JSON.stringify((post.textContent ?? '').trim()))

    await store.getState().refreshSessions()
    await sleep(400)
    const target = norm(failed.sessionFile)
    const listed = (store.getState().sessions ?? []).some((s) => norm(s.path) === target)
    out.push('  实例会话在左栏列表里 = ' + listed + '（空会话不进列表 —— 见上面那段说明）')
    const notices = (store.getState().notices ?? []).filter((n) => n.type === 'error')
    out.push('  错误提示 = ' + JSON.stringify(notices.map((n) => String(n.text).slice(0, 90))))
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
    const refused = sentResult === false || (sentResult && sentResult.ok === false)
    ok(
      !!errNotice || refused,
      '发消息时给出了明确反馈（错误提示，或 send 直接返回 ok:false）'
    )
    if (errNotice) out.push('  提示 = ' + JSON.stringify(String(errNotice.text ?? '').slice(0, 160)))
    if (!errNotice && refused) out.push('  send 的错误 = ' + JSON.stringify(String(sentResult.error ?? '')))

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
