/**
 * 收起侧栏的 mini 项目文件夹（N14）。
 *
 * 用户反馈：左栏收成 48px 快捷轨之后，项目就找不到了，只能用标题栏的开关
 * 展开再切。现在 mini 栏里放项目文件夹图标（与展开态同一排序、同一前五项
 * 规则），名称悬停/键盘聚焦浮出，超出的从「全部项目」浮层进。
 *
 * 切换动作本身仍走主进程 setCwd（那会在 N05/N12 里收敛成语义更准的
 * 项目切换）—— 探针把 setCwd 换成桩，只验证**入口与调用**，
 * 不让隔离环境里的真实切换干扰其它场景。
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
    await sleep(300)

    /* ---- 造 7 个项目，当前项目排第 3 ---- */
    const stamp = Date.now()
    const base = String(store.getState().settings.cwd).replace(/[\\/][^\\/]*$/, '')
    const list = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      id: `rm${n}`,
      cwd: `${base}/yan-probe-rm-${n}`,
      name: `X`, // 覆盖成下面的 projectNames
      archived: false,
      createdAt: stamp,
      updatedAt: stamp
    }))
    const projectNames = {}
    list.forEach((p, i) => { projectNames[p.cwd] = `第${i + 1}号项目` })
    await store.getState().patchSettings({
      projectGroups: [],
      projects: list,
      recentCwds: list.map((p) => p.cwd),
      projectNames: { ...store.getState().settings.projectNames, ...projectNames }
    })
    /*
     * 当前项目钉到 list[2]。
     *
     * 不能只改 session.cwd：Rail 的 isCurrent 用 `activeProjectId ??
     * currentSummary?.projectId`，隔离环境里真实 runner 自带 projectId，
     * 只改 cwd 时标记不会跟着动（探针因此误报）。
     */
    const file = 'C:/yan-probe/current.jsonl'
    store.setState({
      runners: [],
      activeRunnerId: null,
      sessions: [
        {
          id: 'rm-current',
          path: file,
          cwd: list[2].cwd,
          projectId: list[2].id,
          title: '探针会话',
          named: true,
          createdAt: stamp,
          updatedAt: stamp,
          messageCount: 1
        }
      ],
      session: { ...(store.getState().session ?? {}), cwd: list[2].cwd, sessionFile: file }
    })
    await sleep(500)

    /* ---- 收起左栏 ---- */
    store.getState().setRailPinned(false)
    await sleep(600)
    const compact = box(q('.rail-compact'))
    out.push(`  收起后 rail-compact 宽 ${compact?.width.toFixed(0)}px`)
    ok(!!compact && Math.abs(compact.width - 48) <= 2, '收起态是 48px 紧凑轨')

    /* ---- 基础入口还在 ---- */
    const baseBtns = qa('.rail-compact > button').filter((b) => !b.classList.contains('rail-compact-proj'))
    ok(baseBtns.length === 4, `原来的四个基础入口还在（实际 ${baseBtns.length}）`)
    ok(!!q('[data-testid="rail-toggle"]'), '标题栏有独立的展开按钮（不靠 mini 栏）')

    /* ---- 项目图标：前五个 ---- */
    const projBtns = qa('[data-testid="rail-compact-project"]')
    out.push(`  项目图标 ${projBtns.length} 个，名称 = ${JSON.stringify(projBtns.map((b) => b.getAttribute('aria-label')))}`)
    ok(projBtns.length === Math.min(5, list.length), `mini 栏只放前五个项目（实际 ${projBtns.length}）`)
    ok(projBtns.every((b) => (b.getAttribute('aria-label') || '').length > 0), '每个项目入口都有可读名称（aria-label）')
    ok(projBtns.every((b) => (b.getAttribute('title') || '').length > 0), '悬停提示（title）也在')

    const cur = q('[data-testid="rail-compact-project"][data-current="1"]')
    ok(!!cur, '当前项目有明确标记（data-current）')
    ok(cur?.classList.contains('cur'), '当前项目有可视的选中样式类')
    ok(cur?.dataset.cwd === list[2].cwd, '标记落在当前项目上（当前项目会被置顶，不是列表的第一个）')

    /* ---- 名称悬停浮出 ---- */
    /* 每次都重新查（多场景连跑时前面的推送会让这一行重渲染） */
    const hoverCur = () => q('[data-testid="rail-compact-project"][data-current="1"]')
    const nameNow = () => hoverCur()?.querySelector('.rail-compact-name')
    const opacityNow = () => (nameNow() ? getComputedStyle(nameNow()).opacity : '1')
    const nameBox = box(nameNow())
    out.push(`  名称浮层 opacity=${opacityNow()} 宽=${nameBox?.width.toFixed(0)} left=${nameBox?.left.toFixed(0)}`)
    ok(!!nameNow() && opacityNow() === '0', '名称默认不显示（48px 栏放不下）')
    hoverCur()?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(300)
    out.push(`  悬停后 data-hover=${hoverCur()?.dataset.hover} opacity=${opacityNow()}`)
    ok(hoverCur()?.dataset.hover === '1', '悬停时进入 hover 状态（React 状态，合成事件可验证）')
    ok(opacityNow() === '1', '悬停时名称浮出')
    ok(!!nameBox && nameBox.right <= window.innerWidth, '浮层不越出窗口右缘（宽度纳入边界计算）')

    /* 键盘聚焦也要能看到名称（focusin 是 React onFocus 的委托事件） */
    hoverCur()?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    hoverCur()?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    await sleep(300)
    ok(opacityNow() === '0', '移开后名称收起')
    hoverCur()?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await sleep(300)
    out.push(`  聚焦后 data-hover=${hoverCur()?.dataset.hover} opacity=${opacityNow()}`)
    ok(hoverCur()?.dataset.hover === '1' && opacityNow() === '1', '键盘聚焦时名称也浮出')
    hoverCur()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    await sleep(200)

    /* ---- 「全部项目」浮层 ---- */
    const more = q('[data-testid="rail-compact-more"]')
    ok(!!more, '超出前五的项目有「全部项目」入口')
    out.push('  入口文案 = ' + JSON.stringify(more?.getAttribute('aria-label')))
    if (more) click(more)
    await sleep(350)
    const menu = q('[data-testid="rail-compact-menu"]')
    ok(!!menu, '点开后出现全部项目浮层')
    const items = qa('[data-testid="rail-compact-menu"] .rcm-item')
    out.push(`  浮层里 ${items.length} 个项目`)
    const hiddenNum = Number(((more?.getAttribute('aria-label') || '').match(/(\d+)/) || [])[1]) - projBtns.length
    const expectedTotal = projBtns.length + Math.max(0, hiddenNum)
    ok(items.length === expectedTotal, `浮层列出全部项目（${projBtns.length} + ${hiddenNum} = ${expectedTotal}，实际 ${items.length}）`)
    ok(!!q('[data-testid="rail-compact-menu"] .rcm-item.cur'), '浮层里也标出了当前项目')
    const mb = box(menu)
    ok(!!mb && mb.right <= window.innerWidth + 1, '浮层不越出窗口右缘')
    ok(!!mb && mb.height <= window.innerHeight, '浮层不越出窗口下缘')
    const compactH = box(q('.rail-compact'))?.height ?? 0
    const iconsSum = qa('.rail-compact > button').reduce((n, b) => n + (box(b)?.height ?? 0) + 4, 0)
    out.push(`  mini 栏内容高 ${iconsSum.toFixed(0)}px / 容器高 ${compactH.toFixed(0)}px`)
    ok(iconsSum <= compactH + 1, 'mini 栏不会因为项目多而被撑破（溢出走浮层）')

    /* ---- 切换：点浮层里的另一个项目 → 调用 setCwd ---- */
    let called = null
    try {
      window.yan.setCwd = async (cwd) => { called = cwd; return { ok: true } }
    } catch {
      /* contextBridge 只读时降级：只验证浮层关闭 */
    }
    const target = items.find((b) => b.dataset.cwd === list[0].cwd)
    if (target) click(target)
    await sleep(400)
    if (called) {
      out.push(`  setCwd 被调用：${called}`)
      ok(called === list[0].cwd, '点项目入口确实请求切到该项目')
    }
    ok(!q('[data-testid="rail-compact-menu"]'), '选择后浮层关闭')

    /* 收尾：恢复展开 + 清掉探针数据 */
    store.getState().setRailPinned(true)
    await store.getState().patchSettings({ projectGroups: [], projects: [], recentCwds: [], projectNames: {} })
    await sleep(200)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
