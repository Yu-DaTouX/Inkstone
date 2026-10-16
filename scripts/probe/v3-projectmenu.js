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
  const store = window.__yanStore
  const PROJECT_ID = 'probe-project'
  const PROJECT_CWD = 'E:\\pi-desktop-worktrees'
  const labelOf = () => document.querySelector('.v3-group .v3-grp-label')?.textContent?.trim()
  const menuItem = (text) => [...document.querySelectorAll('[data-testid="v3-project-menu"] [role="menuitem"]')].find((el) => el.textContent?.includes(text))
  const setNativeValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const openMenu = async () => {
    q('v3-project-more')?.click()
    return until(() => !!q('v3-project-menu'), 3000)
  }

  try {
    out.push('=== v3 项目菜单与归档视图（隔离探针）===')
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
    const base = {
      named: false, createdAt: now, updatedAt: now, messageCount: 2, model: 'probe', lastActivityAt: now
    }
    const inProject = { ...base, id: 'probe-s1', path: 'E:\\pi-desktop-worktrees\\probe-s1.jsonl', cwd: PROJECT_CWD, title: '项目内会话', projectId: PROJECT_ID }
    const archivedAlone = { ...base, id: 'probe-s2', path: 'E:\\pi-desktop-worktrees\\probe-s2.jsonl', cwd: 'E:\\probe-elsewhere', title: '单独归档的会话', archivedAt: now }
    const record = { id: PROJECT_ID, cwd: PROJECT_CWD, name: 'ProbeDemo', archived: false, createdAt: now, updatedAt: now }
    const settings = store.getState().settings
    const realSessions = store.getState().sessions
    const realSetArchived = store.getState().setSessionArchived
    const archivedCalls = []
    store.setState({
      sessions: [inProject, archivedAlone],
      settings: { ...settings, projects: [...(settings?.projects ?? []), record] },
      setSessionArchived: async (...args) => { archivedCalls.push(args); return true }
    })
    await store.getState().patchSettings({ projects: [...(settings?.projects ?? []), record] }).catch(() => undefined)
    store.setState({ sessions: [inProject, archivedAlone] })

    out.push('')
    out.push('--- 1. 项目标题行与菜单 ---')
    check(await until(() => labelOf() === 'ProbeDemo', 4000), `项目分区显示项目名（实际 ${JSON.stringify(labelOf())}）`)
    check(!!q('v3-project-more'), '标题行有「…」按钮')
    check(await openMenu(), '点「…」打开项目菜单')
    const labels = [...document.querySelectorAll('[data-testid="v3-project-menu"] [role="menuitem"]')].map((el) => el.textContent?.trim())
    note(`菜单项：${JSON.stringify(labels)}`)
    check(labels.length === 6, '菜单有 6 个动作（新建 / 命名 / 更改文件夹 / 显示 / 复制路径 / 移除）')

    out.push('')
    out.push('--- 2. 复制路径 ---')
    const written = []
    const realWrite = navigator.clipboard.writeText.bind(navigator.clipboard)
    navigator.clipboard.writeText = async (value) => { written.push(value) }
    menuItem('复制路径')?.click()
    check(await until(() => written.length === 1, 2000), '触发了剪贴板写入')
    check(written[0] === PROJECT_CWD, `写入的是项目目录（实际 ${JSON.stringify(written[0])}）`)
    navigator.clipboard.writeText = realWrite
    await until(() => !q('v3-project-menu'), 2000)

    out.push('')
    out.push('--- 3. 就地改名 ---')
    await openMenu()
    menuItem('命名项目')?.click()
    check(await until(() => !!q('v3-project-rename'), 2000), '出现就地改名输入框')
    const input = q('v3-project-rename')
    check(input?.value === 'ProbeDemo', '输入框预填当前名称')
    setNativeValue(input, 'ProbeRenamed')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    check(await until(() => labelOf() === 'ProbeRenamed', 4000), `改名后标题行更新（实际 ${JSON.stringify(labelOf())}）`)
    const saved = store.getState().settings
    check(saved?.projectNames?.[PROJECT_CWD] === 'ProbeRenamed', 'projectNames 已写入')
    check(saved?.projects?.find((p) => p.id === PROJECT_ID)?.name === 'ProbeRenamed', '项目记录名已写入')

    out.push('')
    out.push('--- 4. 更改目录（只验证对话框与失败路径，不真的改目录）---')
    await openMenu()
    menuItem('更改项目文件夹')?.click()
    check(await until(() => !!q('v3-project-directory'), 3000), '打开更改目录对话框')
    const dirInputs = [...document.querySelectorAll('[data-testid="v3-project-directory"] input')]
    check(dirInputs[0]?.readOnly === true && dirInputs[0]?.value === PROJECT_CWD, '原目录只读且显示当前目录')
    setNativeValue(q('v3-project-directory-input'), 'Z:\\this\\directory\\does\\not\\exist')
    await wait(100)
    q('v3-project-directory-save')?.click()
    check(await until(() => !!q('v3-project-directory-error'), 5000), '指向不存在的目录时在框内报错')
    check(store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.cwd === PROJECT_CWD, '项目目录没有被改动')
    document.querySelector('[data-testid="v3-project-directory"] .ui-dialog__close')?.click()
    check(await until(() => !q('v3-project-directory'), 2000), '关闭对话框')

    out.push('')
    out.push('--- 5. 移除项目 = 归档，并出现在归档视图 ---')
    check(!!q('v3-archive-toggle'), '已有归档内容时侧栏有「已归档」入口')
    await openMenu()
    menuItem('移除项目')?.click()
    check(await until(() => !!q('v3-project-archive'), 3000), '弹出确认框')
    q('v3-project-archive-confirm')?.click()
    check(await until(() => store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.archived === true, 5000), '项目记录标记为已归档')
    check(await until(() => !labelOf() || labelOf() !== 'ProbeRenamed', 3000), '项目及其会话退出主列表')
    q('v3-archive-toggle')?.click()
    check(await until(() => !!q('v3-archived-view'), 2000), '点入口进入归档视图')
    check((q('v3-archived-view')?.querySelectorAll('[data-testid="v3-archived-project"]').length ?? 0) >= 1, '归档视图列出已归档项目')
    check((q('v3-archived-view')?.querySelectorAll('[data-testid="v3-archived-session"]').length ?? 0) === 1, '归档视图列出单独归档的会话')

    out.push('')
    out.push('--- 6. 取消归档会话与恢复项目 ---')
    q('v3-restore-session')?.click()
    check(await until(() => archivedCalls.length === 1, 2000), '取消归档调用 setSessionArchived')
    check(archivedCalls[0]?.[0] === 'probe-s2' && archivedCalls[0]?.[1] === false, `参数为 (会话 id, false)（实际 ${JSON.stringify(archivedCalls[0])}）`)
    q('v3-restore-project')?.click()
    check(await until(() => store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.archived === false, 5000), '项目恢复为未归档')
    q('v3-archive-toggle')?.click()
    check(await until(() => !q('v3-archived-view'), 2000), '回到会话列表')
    check(await until(() => labelOf() === 'ProbeRenamed', 3000), '恢复后项目和会话回到主列表')

    store.setState({ sessions: realSessions, setSessionArchived: realSetArchived })
    await store.getState().patchSettings({
      projects: (store.getState().settings?.projects ?? []).filter((p) => p.id !== PROJECT_ID),
      projectNames: Object.fromEntries(Object.entries(store.getState().settings?.projectNames ?? {}).filter(([cwd]) => cwd !== PROJECT_CWD))
    }).catch(() => undefined)
    out.push('证据范围：v3 侧栏项目菜单 / 归档视图的 DOM 与真实设置写入路径；项目与会话为注入数据，取消归档为 spy，未调模型、未改真实目录。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
