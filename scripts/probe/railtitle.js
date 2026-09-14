/**
 * 窄侧栏下的会话标题可读性（N13）。
 *
 * 用户反馈：左栏收窄后标题被挤得看不清。这里把左栏拉到**最小宽度**
 * （RAIL_MIN = 210px），造一组长中文/长英文/深层分支/带状态的会话，
 * 量的是真实几何：标题拿到多少像素、缩进是否封顶、状态槽与时间有没有压字。
 *
 * 量 `.srow-name` 的 rect（而不是 `.srow`）—— 后者是外框，padding 吃掉多少
 * 看不出来（rail.css 里也有同样的提醒）。
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
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const box = (el) => (el ? el.getBoundingClientRect() : null)

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.rail') && store.getState().settings) break
      await sleep(250)
    }
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    await sleep(300)

    /* 窄到最小宽度：这是最坏情况 */
    await store.getState().setPanelWidth({ railWidth: 210 })
    store.setState({ refreshSessions: async () => {} })
    await sleep(500)

    const cwd = store.getState().settings.cwd
    const stamp = Date.now()
    const row = (id, title, parentSession) => ({
      id, title, path: `${cwd}/${id}.jsonl`, cwd, parentSession,
      createdAt: stamp, updatedAt: stamp, lastActivityAt: stamp, messageCount: 3
    })
    const root = row('rt-root', '这是一个非常长的中文会话标题，用来量窄栏下的可读性')
    const c1 = row('rt-c1', 'A rather long English session title for measuring truncation', root.path)
    const c2 = row('rt-c2', 'B rather long English session title for measuring truncation', root.path)
    const c3 = row('rt-c3', 'C rather long English session title for measuring truncation', root.path)
    const g1 = row('rt-g1', '孙会话：更深的层级也要能看清标题', c1.path)
    const gg1 = row('rt-gg1', '曾孙会话：第四层应该和第三层一样深', g1.path)
    const s4 = row('rt-s4', '第五层：缩进必须封顶，不再继续右移', gg1.path)

    store.setState({
      sessions: [root, c1, c2, c3, g1, gg1, s4],
      messages: [],
      session: {
        ...(store.getState().session ?? {}),
        sessionId: root.id,
        sessionFile: root.path,
        cwd,
        isAgentRunning: true
      }
    })
    await sleep(700)

    const railBox = box(q('.rail'))
    out.push(`  左栏宽 ${railBox?.width.toFixed(0)}px（RAIL_MIN = 210）`)
    ok(!!railBox && Math.abs(railBox.width - 210) <= 2, `左栏确实是 210px（${railBox?.width.toFixed(0)}）`)

    /* 展开两层分支，让第 3/4 层出现 */
    const upTo = async (path) => {
      for (let i = 0; i < 20; i++) {
        const el = qa('[data-session-path]').find((e) => e.dataset.sessionPath === path)
        const t = el?.querySelector('[data-testid="rail-branch-toggle"]')
        if (t) { click(t); await sleep(220) }
        return
      }
      await sleep(220)
    }
    await upTo(root.path)
    await upTo(c1.path)
    await upTo(g1.path)
    await upTo(gg1.path)
    await sleep(400)
    /*
     * 运行状态现在来自**运行实例注册表**（N12），不是当前会话槽位：
     * 这里直接注入一条「root 会话正在跑」的实例记录。
     */
    store.setState({
      session: { ...(store.getState().session ?? {}), sessionId: root.id, sessionFile: root.path, cwd, isAgentRunning: true },
      runners: [
        {
          id: 'railtitle-r1',
          sessionFile: root.path,
          sessionId: root.id,
          cwd,
          running: true,
          waiting: false,
          failed: false,
          conn: 'ready',
          createdAt: stamp,
          lastActiveAt: stamp,
          isActive: true
        }
      ]
    })
    await sleep(300)

    const info = (path) => {
      const wrap = qa('[data-session-path]').find((e) => e.dataset.sessionPath === path)
      const name = wrap?.querySelector('.srow-name')
      const srow = wrap?.querySelector('.srow')
      const time = wrap?.querySelector('.srow-time')
      const status = wrap?.querySelector('.session-status')
      const bt = wrap?.querySelector('.srow-btoggle')
      const nb = box(name)
      return {
        found: !!wrap,
        depth: wrap?.dataset.depth,
        nameLeft: nb ? +nb.left.toFixed(1) : null,
        nameW: nb ? +nb.width.toFixed(1) : null,
        textW: name?.scrollWidth ?? null,
        clipped: !!name && name.scrollWidth > name.clientWidth + 1,
        title: name?.closest('.srow')?.getAttribute('title') ?? '',
        srowW: srow ? +srow.getBoundingClientRect().width.toFixed(1) : null,
        timeW: time ? +time.getBoundingClientRect().width.toFixed(1) : 0,
        statusW: status ? +status.getBoundingClientRect().width.toFixed(1) : 0,
        btW: bt ? +bt.getBoundingClientRect().width.toFixed(1) : 0,
        nameRight: nb ? +nb.right.toFixed(1) : null,
        timeLeft: time ? +time.getBoundingClientRect().left.toFixed(1) : null,
        srowRight: srow ? +srow.getBoundingClientRect().right.toFixed(1) : null
      }
    }

    const R = info(root.path), C1 = info(c1.path), G1 = info(g1.path), GG1 = info(gg1.path), S4 = info(s4.path)
    for (const [label, x] of [['root', R], ['branch1', C1], ['grandchild', G1], ['great-grandchild', GG1], ['5th', S4]]) {
      out.push(`  ${label}: depth=${x.depth} nameLeft=${x.nameLeft} nameW=${x.nameW} 文本宽=${x.textW} 截断=${x.clipped} time=${x.timeW} status=${x.statusW} btoggle=${x.btW}`)
    }
    out.push('  诊断 isAgentRunning=' + store.getState().session?.isAgentRunning + ' sessionFile匹配=' + (store.getState().session?.sessionFile === root.path))
    /* 重新注入一次：展开分支时的重渲染/推送可能把 runners 冲掉（多场景连跑时更明显） */
    store.setState({
      runners: [
        {
          id: 'railtitle-r1',
          sessionFile: root.path,
          sessionId: root.id,
          cwd,
          running: true,
          waiting: false,
          failed: false,
          conn: 'ready',
          createdAt: stamp,
          lastActiveAt: stamp,
          isActive: true
        }
      ]
    })
    await sleep(300)

    ok(R.found && C1.found && G1.found && GG1.found && S4.found, '五层会话行都渲染出来了')

    /* 1. 标题可用宽度：窄栏下仍要能读出内容 */
    const minW = Math.min(R.nameW ?? 0, C1.nameW ?? 0, G1.nameW ?? 0, GG1.nameW ?? 0, S4.nameW ?? 0)
    out.push(`  标题可用宽度最小 = ${minW}px（最浅行宽 ${R.srowW}px）`)
    ok(minW >= 96, `窄栏下标题至少还有 96px（实际 ${minW}px）`)

    /* 2. 深层缩进封顶：第 5 层不能比第 4 层更靠右 */
    ok(S4.nameLeft === GG1.nameLeft, `第 5 层与第 4 层缩进一致（${GG1.nameLeft} vs ${S4.nameLeft}）`)
    ok(C1.nameLeft > R.nameLeft, '第 1 层比根会话更深（层级仍可辨认）')

    /* 3. 不做「自动缩短标题」：长标题可以省略，但完整名称必须能悬停/键盘看到 */
    ok(R.clipped, '超长标题在窄栏下确实被省略（而不是撑破布局）')
    ok(R.title.includes('这是一个非常长的中文会话标题'), '完整标题在 title 提示里（悬停可见）')

    /* 4. 状态槽 / 时间不能压住标题 */
    const rightEdge = R.timeW > 0 ? R.timeLeft : R.srowRight
    ok(
      R.nameRight !== null && rightEdge !== null && R.nameRight <= rightEdge + 1,
      `标题右缘不越过右侧槽位（${R.nameRight} ≤ ${rightEdge}）`
    )
    const statusEl = q('.session-status')
    ok(!!statusEl, '会话行有状态槽（运行 / 等待 / 未读共用）')
    ok(!!statusEl && statusEl.getBoundingClientRect().width <= 20, '状态槽占用 ≤ 20px（不吃标题宽度）')
    ok(!!q('.session-status.running'), '正在跑的那个会话行显示运行状态（状态槽来自实例注册表）')

    /* 5. 悬停时动作按钮出现，且标题让位而不是被覆盖 */
    const hoverTarget = qa('[data-session-path]').find((e) => e.dataset.sessionPath === c2.path)
    hoverTarget?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    hoverTarget?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await sleep(250)
    const acts = hoverTarget?.querySelector('.srow-acts')
    const actsStyle = acts ? getComputedStyle(acts) : null
    ok(actsStyle?.pointerEvents === 'none' || actsStyle?.opacity === '0', '未悬停时动作按钮不抢点击（隐藏且不接收指针）')

    /* 收尾 */
    await store.getState().setPanelWidth({ railWidth: 0 })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
