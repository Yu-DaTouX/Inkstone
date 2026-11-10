;(async () => {
  const out = []
  const check = (condition, label) => {
    out.push(`  ${condition ? '✓' : '✗'} ${label}`)
    return !!condition
  }
  const note = (label) => out.push(`  · ${label}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (predicate, timeout = 4000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      try {
        if (predicate()) return true
      } catch {
      }
      await wait(50)
    }
    return false
  }
  const q = (testId) => document.querySelector(`[data-testid="${testId}"]`)
  const qa = (testId) => [...document.querySelectorAll(`[data-testid="${testId}"]`)]
  const store = window.__yanStore
  const PROJECT_ID = 'probe-project'
  const PROJECT_CWD = 'D:\\projects\\demo'
  const S1_PATH = 'D:\\projects\\demo\\probe-s1.jsonl'
  const S2_PATH = 'D:\\projects\\demo\\probe-s2.jsonl'
  const folderNames = () => qa('sidebar-project-folder').map((el) => el.querySelector('.t3-folder__name')?.textContent?.trim() ?? '')
  const folderOf = (name) => qa('sidebar-project-folder').find((el) => (el.querySelector('.t3-folder__name')?.textContent?.trim() ?? '') === name)
  const rowOf = (path) => [...document.querySelectorAll('[data-session-path]')].find((el) => el.dataset.sessionPath === path)
  const menuLabels = () => [...document.querySelectorAll('[data-testid="v3-project-menu"] [role="menuitem"]')].map((el) => el.textContent?.trim())
  const menuItem = (label) => [...document.querySelectorAll('[data-testid="v3-project-menu"] [role="menuitem"]')].find((el) => (el.textContent ?? '').includes(label))
  const setNativeValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const openMenu = async (name) => {
    folderOf(name)?.querySelector('[data-testid="v3-project-more"]')?.click()
    return until(() => !!q('v3-project-menu'), 3000)
  }
  const closePopovers = async () => {
    if (!q('v3-project-menu') && !q('v3-project-filter-panel')) return
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await until(() => !q('v3-project-menu') && !q('v3-project-filter-panel'), 2000)
  }
  const realSetArchived = store?.getState().setSessionArchived
  const archivedCalls = []
  const realSessions = store?.getState().sessions
  const realProjects = store?.getState().settings?.projects
  const realLayout = store?.getState().settings?.sidebarLayout

  try {
    out.push('=== v3 项目菜单与归档（隔离探针）===')
    check(await until(() => document.documentElement.dataset.ui === 'v3' && q('v3-sidebar'), 8000), 'v3 外壳已挂载')
    if (!store || !q('v3-sidebar')) throw new Error('v3 外壳或隔离探针 store 不可用')
    try {
      localStorage.setItem('yan.onboarded', '1')
    } catch {
    }
    const onboarding = document.querySelector('.v3-ob-overlay')
    if (onboarding) {
      onboarding.querySelector('.ui-dialog__close')?.click()
      await until(() => !document.querySelector('.v3-ob-overlay'), 3000)
    }

    const now = Date.now()
    const base = { named: false, createdAt: now, updatedAt: now, messageCount: 2, model: 'probe', lastActivityAt: now }
    const inProject = { ...base, id: 'probe-s1', path: S1_PATH, cwd: PROJECT_CWD, title: '项目内会话', projectId: PROJECT_ID }
    const archivedAlone = { ...base, id: 'probe-s2', path: S2_PATH, cwd: 'E:\\probe-elsewhere', title: '单独归档的会话', archivedAt: now }
    const record = { id: PROJECT_ID, cwd: PROJECT_CWD, name: 'ProbeDemo', archived: false, createdAt: now, updatedAt: now }
    store.setState({
      sessions: [inProject, archivedAlone],
      setSessionArchived: async (...args) => { archivedCalls.push(args); return true }
    })
    await store.getState().patchSettings({ projects: [...(realProjects ?? []), record], sidebarLayout: 'projects' }).catch(() => undefined)
    store.setState({ sessions: [inProject, archivedAlone] })

    out.push('')
    out.push('--- 1. 项目标题行与菜单 ---')
    check(await until(() => folderNames().includes('ProbeDemo'), 4000), `项目分区显示项目名（实际 ${JSON.stringify(folderNames())}）`)
    check(!!folderOf('ProbeDemo')?.querySelector('[data-testid="v3-project-more"]'), '标题行有「…」按钮')
    check(!!folderOf('ProbeDemo')?.querySelector('button[aria-label]'), '标题行有带可访问名的新建会话按钮')
    check(await openMenu('ProbeDemo'), '点「…」打开项目菜单')
    const labels = menuLabels()
    note(`菜单项：${JSON.stringify(labels)}`)
    check(labels.length >= 8, '菜单包含新建 / 重命名 / 图标 / 文件夹 / 显示 / 复制 / 移除 / 删除')
    check(labels.some((l) => l.includes('命名项目')) && labels.some((l) => l.includes('修改项目文件夹')), '菜单有命名与修改项目文件夹')
    check(labels.some((l) => l.includes('复制路径')) && labels.some((l) => l.includes('移除项目')), '菜单有复制路径与移除项目')

    out.push('')
    out.push('--- 2. 复制路径 ---')
    const written = []
    const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = async (value) => { written.push(value) }
    menuItem('复制路径')?.click()
    check(await until(() => written.length === 1, 2000), '触发了剪贴板写入')
    check(written[0] === PROJECT_CWD, `写入的是项目目录（实际 ${JSON.stringify(written[0])}）`)
    navigator.clipboard.writeText = realWrite
    await closePopovers()

    out.push('')
    out.push('--- 3. 重命名 ---')
    await openMenu('ProbeDemo')
    menuItem('命名项目')?.click()
    check(await until(() => !!q('v3-project-rename'), 3000), '打开重命名对话框')
    const nameInput = q('v3-project-name-input')
    check(nameInput?.value === 'ProbeDemo', '输入框预填当前名称')
    if (nameInput) setNativeValue(nameInput, 'ProbeRenamed')
    await wait(100)
    q('v3-project-rename')?.querySelector('button[type="submit"]')?.click()
    check(await until(() => !q('v3-project-rename'), 4000), '保存后对话框关闭')
    check(await until(() => folderNames().includes('ProbeRenamed'), 4000), `改名后标题行更新（实际 ${JSON.stringify(folderNames())}）`)
    const saved = store.getState().settings
    check(saved?.projectNames?.[PROJECT_CWD] === 'ProbeRenamed', 'projectNames 已写入')
    check(saved?.projects?.find((p) => p.id === PROJECT_ID)?.name === 'ProbeRenamed', '项目记录名已写入')

    out.push('')
    out.push('--- 4. 更改目录（只验证对话框与失败路径）---')
    await openMenu('ProbeRenamed')
    menuItem('修改项目文件夹')?.click()
    check(await until(() => !!q('v3-project-directory'), 3000), '打开更改目录对话框')
    const readonly = [...document.querySelectorAll('[data-testid="v3-project-directory"] input')].find((el) => el.readOnly)
    check(readonly?.value === PROJECT_CWD, '原目录只读且显示当前目录')
    setNativeValue(q('v3-project-directory-input'), 'Z:\\this\\directory\\does\\not\\exist')
    await wait(100)
    q('v3-project-directory-save')?.click()
    check(await until(() => !!q('v3-project-directory-error'), 5000), '指向不存在的目录时在框内报错')
    check(store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.cwd === PROJECT_CWD, '项目目录没有被改动')
    document.querySelector('[data-testid="v3-project-directory"] .ui-dialog__close')?.click()
    check(await until(() => !q('v3-project-directory'), 2000), '关闭对话框')

    out.push('')
    out.push('--- 5. 移除项目 = 归档，会话进入已归档架 ---')
    check(!!rowOf(S2_PATH)?.closest('[data-sidebar-parent="shelf:settled"]') || rowOf(S2_PATH)?.dataset.sidebarParent === 'shelf:settled', '单独归档的会话显示在已归档架')
    await openMenu('ProbeRenamed')
    menuItem('移除项目')?.click()
    check(await until(() => !!q('v3-project-archive'), 3000), '弹出移除确认框')
    q('v3-project-archive-confirm')?.click()
    check(await until(() => store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.archived === true, 5000), '项目记录标记为已归档')
    check(await until(() => !folderNames().includes('ProbeRenamed'), 4000), '项目分区退出主列表')
    check(await until(() => rowOf(S1_PATH)?.dataset.sidebarParent === 'shelf:settled', 4000), '项目内会话进入已归档架')

    out.push('')
    out.push('--- 6. 从项目过滤面板恢复项目 ---')
    q('v3-project-filter')?.click()
    check(await until(() => !!q('v3-project-filter-panel'), 3000), '打开项目过滤面板')
    q('v3-project-filter-archived')?.click()
    check(await until(() => !!q('v3-project-filter-more'), 3000), '展开已归档项目')
    q('v3-project-filter-more')?.click()
    check(await until(() => !!q('v3-project-menu'), 3000), '从过滤面板打开已归档项目菜单')
    const restoreLabel = menuLabels().find((l) => l.includes('恢复项目'))
    check(!!restoreLabel, `已归档项目菜单提供恢复（${JSON.stringify(menuLabels())}）`)
    menuItem('恢复项目')?.click()
    check(await until(() => store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.archived === false, 5000), '项目恢复为未归档')
    check(await until(() => folderNames().includes('ProbeRenamed'), 4000), '恢复后项目分区回到主列表')
    check(await until(() => rowOf(S1_PATH)?.dataset.sidebarParent !== 'shelf:settled', 4000), '项目内会话离开已归档架')
    await closePopovers()

    out.push('')
    out.push('--- 7. 取消归档单个会话 ---')
    const settled = rowOf(S2_PATH)
    check(!!settled, '单独归档的会话仍在侧栏')
    const unarchive = settled ? [...settled.querySelectorAll('button[aria-label]')].find((el) => /取消归档|Unarchive/.test(el.getAttribute('aria-label') ?? '')) : null
    check(!!unarchive, '已归档行有取消归档按钮')
    unarchive?.click()
    check(await until(() => archivedCalls.length === 1, 2000), '取消归档调用 setSessionArchived')
    check(archivedCalls[0]?.[0] === 'probe-s2' && archivedCalls[0]?.[1] === false, `参数为 (会话 id, false)（实际 ${JSON.stringify(archivedCalls[0])}）`)
    note('证据范围：v3 侧栏项目菜单 / 归档架 / 项目过滤面板的真实 DOM 与设置写入；项目与会话为注入数据，会话取消归档为 spy，未调模型、未改真实目录。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  try {
    await closePopovers()
    if (q('v3-project-rename')) q('v3-project-rename')?.querySelector('.ui-dialog__close')?.click()
    if (q('v3-project-archive')) q('v3-project-archive')?.querySelector('.ui-dialog__close')?.click()
    if (store) {
      store.setState({ sessions: realSessions, setSessionArchived: realSetArchived })
      await store.getState().patchSettings({
        projects: (store.getState().settings?.projects ?? []).filter((p) => p.id !== PROJECT_ID),
        projectNames: Object.fromEntries(Object.entries(store.getState().settings?.projectNames ?? {}).filter(([cwd]) => cwd !== PROJECT_CWD)),
        sidebarLayout: realLayout
      }).catch(() => undefined)
    }
  } catch (error) {
    out.push(`  ✗ 清理失败：${error?.message ?? error}`)
  }
  return out.join('\n')
})()
