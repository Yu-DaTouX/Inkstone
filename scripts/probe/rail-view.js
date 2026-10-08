/*
 * 左栏视图探针（视觉矩阵 `YAN_MATRIX_ONLY=railview`，合成数据）。
 *
 * 塞几条不同状态、不同日期的合成会话，再点「视图」按钮：
 *   · __MODE__ = menu：打开视图菜单，检查两组共 7 个选项且「按项目」「最近活动」被选中；
 *   · __MODE__ = state：切到「按状态」，检查分区顺序为 等你回答 → 运行中 → 其余；
 *   · __MODE__ = date：切到「按日期」+「名称」排序，检查分区含 今天 / 更早。
 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const st = store.getState()
  st.closeSettings?.()
  st.setRailPinned?.(true)
  const day = 86_400_000
  const now = Date.now()
  const cwd = st.session?.cwd || 'C:/fixture/demo'
  const mk = (id, title, ago, created = ago) => ({ id, path: `C:/fixture/rv/${id}.jsonl`, cwd, title, named: true, scope: 'global', createdAt: now - created, updatedAt: now - ago, lastActivityAt: now - ago, messageCount: 4 })
  const fixtures = [
    mk('rv-wait', '确认要不要删掉旧迁移', 5 * 60_000),
    mk('rv-run', '重构设置页的存储层', 20 * 60_000),
    mk('rv-fail', '同步手机端配对记录', 2 * 3600_000),
    mk('rv-idle1', '整理发布说明', day + 3600_000),
    mk('rv-idle2', 'Alpha 额度查看工具', 9 * day, 12 * day),
    mk('rv-idle3', '笔记本测试连接', 20 * day, 30 * day),
    { ...mk('rv-arch1', '旧的发布排查', 40 * day), archivedAt: now - 2 * day },
    { ...mk('rv-arch2', '手机端首版试验', 60 * day), archivedAt: now - 5 * day }
  ]
  const runner = (f, extra) => ({ id: `rv-${f.id}`, runId: `rv-${f.id}`, sessionFile: f.path, sessionId: f.id, generation: 1, cwd, running: false, waiting: false, failed: false, conn: 'ready', createdAt: now, lastActiveAt: now, isActive: false, ...extra })
  store.setState({
    sessions: [...st.sessions.filter((s) => !s.id.startsWith('rv-')), ...fixtures],
    runners: [...(st.runners ?? []).filter((r) => !String(r.id).startsWith('rv-')), runner(fixtures[0], { waiting: true }), runner(fixtures[1], { running: true }), runner(fixtures[2], { failed: true, conn: 'error' })]
  })
  await sleep(500)
  const click = async (testid) => {
    const el = document.querySelector(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`railview: 找不到 ${testid}`)
    el.click()
    await sleep(250)
  }
  const mode = '__MODE__'
  /* 上一个场景可能留着打开的菜单和非默认视图：先关菜单，再复位到「按项目 · 最近活动」 */
  const closeMenu = async () => { if (document.querySelector('[data-testid="rail-view-menu"]')) { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(200) } }
  await closeMenu()
  await click('rail-view'); await click('rail-view-group-project')
  await click('rail-view'); await click('rail-view-sort-recent')
  await click('rail-view'); await click('rail-view-show-active')
  const keys = () => [...document.querySelectorAll('[data-testid^="rail-section-"]')].map((e) => e.dataset.testid.slice('rail-section-'.length)).join(',')
  if (mode === 'archive') {
    await click('rail-view')
    await click('rail-view-group-none')
    await click('rail-view')
    await click('rail-view-show-archived')
    const rows = [...document.querySelectorAll('[data-testid="rail-session"]')].map((e) => e.textContent).join('|')
    if (!rows.includes('旧的发布排查') || !rows.includes('手机端首版试验') || rows.includes('整理发布说明')) throw new Error(`railview: 归档视图的会话不对 ${rows}`)
    document.querySelector('[data-session-path$="rv-arch1.jsonl"] .srow-acts button')?.click()
    await sleep(300)
    if (!document.querySelector('[data-testid="rail-archive"]')) throw new Error('railview: 会话菜单里没有归档项')
    return 'ok(archive)'
  }
  await click('rail-view')
  if (mode === 'menu') {
    const items = document.querySelectorAll('[data-testid="rail-view-menu"] [role="menuitem"]')
    if (items.length !== 9) throw new Error(`railview: 菜单应有 9 项，实际 ${items.length}`)
    const on = [...items].filter((i) => i.getAttribute('aria-current') === 'true').map((i) => i.dataset.testid).join(',')
    if (on !== 'rail-view-group-project,rail-view-sort-recent,rail-view-show-active') throw new Error(`railview: 默认选中项不对 ${on}`)
    return 'ok(menu)'
  }
  if (mode === 'state') {
    await click('rail-view-group-state')
    if (keys() !== 'waiting,failed,running,idle') throw new Error(`railview: 状态分区顺序不对 ${keys()}`)
    return `ok(${keys()})`
  }
  await click('rail-view-group-date')
  await click('rail-view')
  await click('rail-view-sort-name')
  if (!/older/.test(keys()) || !/today/.test(keys())) throw new Error(`railview: 日期分区不对 ${keys()}`)
  return `ok(${keys()})`
})()
