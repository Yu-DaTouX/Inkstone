/*
 * 项目知识的**跨重启**核验（实施-03 S6，第二次启动，cost 0）。
 *
 * 由 `test-live` 的 `restart` 分支拉起：与主探针**同一个 `YAN_DATA_DIR` /
 * `YAN_USER_DATA`**，但应用进程是全新的一次。要证明的是三件事：
 *   ① 知识不是内存态 —— 关掉应用再开，条目还在（从磁盘 manifest 读回）；
 *   ② 身份派生是**确定**的 —— 同一个 cwd 在两次进程里算出的 projectId 相同
 *      （否则重启后用户会看到一个“空知识库”，而盘上其实有）；
 *   ③ 隔离没有被重启破坏 —— 工作树仍然读不到主仓库的条目。
 *
 * 交接靠 localStorage：它在隔离的 `YAN_USER_DATA` 里，进程退出后仍在，
 * 而探针按设计读不到 `YAN_DATA_DIR`（与 S3/S5 同一条分工）。
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
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const idsOf = (view) => (view?.entries ?? []).map((entry) => entry.id)
  const findSession = (title) => until(() => S().sessions.find((s) => String(s.title ?? '').includes(title)) ?? null, 25000)
  const switchTo = async (title) => {
    const session = await findSession(title)
    if (!session) return null
    await S().switchSession(session.path)
    const moved = await until(() => (norm(S().session?.cwd) === norm(session.cwd) ? S().session : null), 30000)
    return moved ? session : null
  }
  const readKnowledge = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await window.yan.knowledge.list()
        if (res && res.ok && res.projectId) return res
      } catch {
        /* 还没就绪 */
      }
      await sleep(250)
    }
    return window.yan.knowledge.list()
  }

  const result = { aHasEntry: false, aSameId: false, bHasEntry: false, wEmpty: false, wSameId: false }

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

    let saved = null
    try {
      saved = JSON.parse(localStorage.getItem('yan.probe.knowledge-iso.v1') ?? 'null')
    } catch {
      saved = null
    }
    ok(!!saved, '拿到了第一次启动留下的观察结果（localStorage 跨进程保留）')

    /* ── 主仓库：条目还在，id 没变 ── */
    const sessA = await switchTo('YAN-ISO-A')
    ok(!!sessA, '重启后仍能切到主仓库的会话')
    const viewA = await readKnowledge()
    result.aHasEntry = idsOf(viewA).includes('kn-iso-a')
    result.aSameId = !!saved?.a?.id && viewA?.projectId === saved.a.id
    ok(result.aHasEntry, '重启后主仓库仍能读到自己的条目（知识在盘上）', idsOf(viewA).join(',') || '（空）')
    ok(result.aSameId, '重启后主仓库的 projectId 与上一次相同', `${viewA?.projectId ?? '（空）'} vs ${saved?.a?.id ?? '（空）'}`)

    /* ── 另一个项目：同样还在 ── */
    S().closeSettings()
    await sleep(200)
    const sessB = await switchTo('YAN-ISO-B')
    ok(!!sessB, '重启后仍能切到另一个项目的会话')
    const viewB = await readKnowledge()
    result.bHasEntry = idsOf(viewB).includes('kn-iso-b')
    ok(result.bHasEntry, '重启后另一个项目仍能读到自己的条目', idsOf(viewB).join(',') || '（空）')
    ok(!idsOf(viewB).includes('kn-iso-a'), '重启后项目之间仍然不串')

    /* ── 工作树：仍然空，且 id 没变 ── */
    S().closeSettings()
    await sleep(200)
    const sessW = await switchTo('YAN-ISO-W')
    ok(!!sessW, '重启后仍能切到工作树会话')
    const viewW = await readKnowledge()
    result.wEmpty = idsOf(viewW).length === 0
    result.wSameId = !!saved?.w?.id && viewW?.projectId === saved.w.id
    ok(result.wEmpty, '重启后工作树仍然读不到任何条目', idsOf(viewW).join(',') || '（空）')
    ok(result.wSameId, '重启后工作树的 projectId 与上一次相同（哈希退路是确定的）', `${viewW?.projectId ?? '（空）'} vs ${saved?.w?.id ?? '（空）'}`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  out.push('')
  out.push(`[knowledgeisolation] restart=${JSON.stringify(result)}`)
  const failed = out.filter((line) => line.includes('✗')).length
  out.push(failed === 0 ? '[knowledgeisolation] 重启核验通过' : `[knowledgeisolation] ${failed} 条失败`)
  return out.join('\n')
})()
