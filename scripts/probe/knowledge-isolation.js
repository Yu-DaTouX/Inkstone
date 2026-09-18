/*
 * 项目知识的跨会话 / 项目 / 工作树隔离（实施-03 S6，cost 0 —— 不调模型）。
 *
 * 这一态验的是**身份边界**，不是读写功能（那是 S5 的 `knowledgetab`）：
 *   ① 主仓库 A 的会话只能看到 A 的条目；
 *   ② 切到另一个已登记项目 B 的会话，只能看到 B 的（A 的看不到）；
 *   ③ 切到 A 的 **git 工作树**（未登记）的会话，**一条都看不到**。
 *
 * ③ 是这片的核心：旧 `legacyProjectId` 只取路径前 27 字节，而 fixture 根目录很长，
 * 于是工作树的旧算法 id 与主仓库**完全相同**。修复前这里会读到 A 的条目
 * （界面与 `yan knowledge` 一起漏），修复后走整条路径的哈希退路。
 *
 * 探针按设计读不到 `YAN_DATA_DIR`，所以这里只断言「运行时身份与可见条目」，
 * 磁盘上的目录/字节由 afterExit（Node 侧）核验。两侧要能对上，所以这里把
 * 观察到的 projectId 写进 localStorage，交给第二次启动（重启探针）比对。
 */
;(async () => {
  const out = []
  const ok = (condition, text, extra = '') => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + text + (extra ? `  ${extra}` : ''))
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const store = window.__yanStore
  const S = () => store.getState()
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    for (;;) {
      const value = fn()
      if (value) return value
      if (Date.now() - t0 > ms) return null
      await sleep(150)
    }
  }
  /* Windows 上 `/` 与 `\` 混用、大小写不敏感 —— 直接比字符串会假失败 */
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const idsOf = (view) => (view?.entries ?? []).map((entry) => entry.id)

  const findSession = (title) => until(() => S().sessions.find((s) => String(s.title ?? '').includes(title)) ?? null, 25000)
  /**
   * 切到某条 fixture 会话，并等**实例的 cwd 真的跟着换**。
   *
   * 只等 `switchSession` 返回不算：知识身份取的是运行实例的 cwd，
   * 而实例是异步起来的（跨项目还要换一个 pi 进程，见 runners.select）。
   */
  const switchTo = async (title) => {
    const session = await findSession(title)
    if (!session) return null
    await S().switchSession(session.path)
    const moved = await until(() => (norm(S().session?.cwd) === norm(session.cwd) ? S().session : null), 30000)
    return moved ? session : null
  }
  /** 读一次当前会话的知识列表（等主进程把身份解析出来） */
  const readKnowledge = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await window.yan.knowledge.list()
        if (res && res.ok && res.projectId) return res
      } catch {
        /* 主进程还没就绪：继续等 */
      }
      await sleep(250)
    }
    return window.yan.knowledge.list()
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i += 1) {
      const card = q('.ob-card')
      if (!card) break
      const button = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (button) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(200)
      } else await sleep(120)
    }
    S().closeSettings?.()
    await until(() => S().conn === 'ready', 40000)

    /* ── ① 主仓库 A：只看得到自己的 ── */
    out.push('=== 1. 主仓库 A ===')
    const sessA = await switchTo('YAN-ISO-A')
    ok(!!sessA, '切到主仓库的 fixture 会话（YAN-ISO-A）')
    const viewA = await readKnowledge()
    const idA = viewA?.projectId
    ok(!!idA, '主仓库会话解析出了 projectId', idA ?? '（空）')
    ok(idsOf(viewA).includes('kn-iso-a'), '能看到自己的条目 kn-iso-a', idsOf(viewA).join(',') || '（空）')
    ok(!idsOf(viewA).includes('kn-iso-b'), '看不到另一个项目的条目 kn-iso-b')
    S().openSettings('knowledge')
    const cardA = await until(() => q('[data-testid="kn-item-kn-iso-a"]'))
    ok(!!cardA, '设置页用同一份身份渲染（自己的卡片出现）')
    ok(!q('[data-testid="kn-item-kn-iso-b"]'), '设置页里没有另一个项目的卡片')
    ok(
      (q('[data-testid="kn-project"]')?.textContent ?? '').includes(idA ?? '__none__'),
      '页面显示的 projectId 与列表返回的同一个',
      (q('[data-testid="kn-project"]')?.textContent ?? '').trim(),
    )

    /* ── ② 另一个项目 B：只看得到自己的 ── */
    out.push('')
    out.push('=== 2. 另一个已登记项目 B ===')
    S().closeSettings()
    await sleep(200)
    const sessB = await switchTo('YAN-ISO-B')
    ok(!!sessB, '切到另一个项目的 fixture 会话（YAN-ISO-B）')
    const viewB = await readKnowledge()
    const idB = viewB?.projectId
    ok(!!idB && idB !== idA, 'B 的 projectId 与 A 不同', `${idB ?? '（空）'}`)
    ok(idsOf(viewB).includes('kn-iso-b'), 'B 能看到自己的条目', idsOf(viewB).join(',') || '（空）')
    ok(!idsOf(viewB).includes('kn-iso-a'), 'B 看不到 A 的条目（物理隔离）')
    S().openSettings('knowledge')
    ok(!!(await until(() => q('[data-testid="kn-item-kn-iso-b"]'))), '设置页渲染 B 的卡片')
    ok(!q('[data-testid="kn-item-kn-iso-a"]'), '设置页里没有 A 的卡片')

    /* ── ③ 工作树 W（未登记）：一条都看不到 ── */
    out.push('')
    out.push('=== 3. 主仓库的 git 工作树（未登记）===')
    S().closeSettings()
    await sleep(200)
    const sessW = await switchTo('YAN-ISO-W')
    ok(!!sessW, '切到工作树的 fixture 会话（YAN-ISO-W）')
    out.push('  工作树 cwd = ' + (S().session?.cwd ?? '（空）'))
    const viewW = await readKnowledge()
    const idW = viewW?.projectId
    ok(!!idW, '工作树会话也解析出了 projectId', idW ?? '（空）')
    ok(idW !== idA, '工作树的 projectId 与主仓库不同（这就是旧算法会撞的地方）')
    ok(idsOf(viewW).length === 0, '工作树一条知识都看不到', idsOf(viewW).join(',') || '（空）')
    ok(!idsOf(viewW).includes('kn-iso-a'), '工作树**没有**读到主仓库的条目')
    ok((viewW?.counts?.all ?? -1) === 0, '计数也是 0（不是列表被筛选挡住）', String(viewW?.counts?.all))
    S().openSettings('knowledge')
    /*
     * 先等页面**加载完**再断言空状态：`view` 还是 null 时也会渲染 `kn-empty`（还没拿到身份），
     * 不等就断言会把「意外读到了 A 的条目」误判成空 —— 反向验证时这里假绿了一格。
     */
    const projectShown = await until(() => {
      const text = q('[data-testid="kn-project"]')?.textContent ?? ''
      return idW && text.includes(idW) ? text : null
    }, 20000)
    ok(!!projectShown, '设置页加载完成（显示工作树自己的 projectId）', projectShown ?? '（超时）')
    ok(!!q('[data-testid="kn-empty"]'), '设置页显示的是空状态（不是 A 的卡片）')
    ok(!q('[data-testid="kn-item-kn-iso-a"]'), '设置页里也没有主仓库的卡片')

    /* ── 把观察到的身份交给重启探针 ── */
    const stash = {
      a: { id: idA ?? null, hasEntry: idsOf(viewA).includes('kn-iso-a') },
      b: { id: idB ?? null, hasEntry: idsOf(viewB).includes('kn-iso-b') },
      w: { id: idW ?? null, empty: idsOf(viewW).length === 0 }
    }
    localStorage.setItem('yan.probe.knowledge-iso.v1', JSON.stringify(stash))
    out.push('')
    out.push(`[knowledgeisolation] ids=${JSON.stringify({ a: idA ?? null, b: idB ?? null, w: idW ?? null })}`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  out.push('')
  const failed = out.filter((line) => line.includes('✗')).length
  out.push(failed === 0 ? '[knowledgeisolation] 全部通过' : `[knowledgeisolation] ${failed} 条失败`)
  return out.join('\n')
})()
