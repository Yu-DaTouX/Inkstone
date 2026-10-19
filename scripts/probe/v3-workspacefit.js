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
  const PROJECT_ID = 'probe-workspacefit'
  const menuItem = (text) => [...document.querySelectorAll('[data-testid="v3-project-menu"] [role="menuitem"]')].find((el) => el.textContent?.includes(text))
  const setNativeValue = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const toastTexts = () => [...document.querySelectorAll('.ui-toast')].map((el) => el.textContent ?? '')
  const fitToast = () => toastTexts().find((text) => text.includes('检查点只保存小文件'))
  const dismissToasts = async () => {
    for (const btn of document.querySelectorAll('.ui-toast__close')) btn.click()
    await until(() => !document.querySelector('.ui-toast'), 3000)
  }
  const changeDirectory = async (target) => {
    q('v3-project-more')?.click()
    if (!(await until(() => !!q('v3-project-menu'), 3000))) return false
    menuItem('改项目文件夹')?.click()
    if (!(await until(() => !!q('v3-project-directory'), 3000))) return false
    setNativeValue(q('v3-project-directory-input'), target)
    await wait(100)
    q('v3-project-directory-save')?.click()
    return until(() => !q('v3-project-directory'), 6000)
  }

  try {
    out.push('=== 工作目录过大提示（隔离探针）===')
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

    const fixture = store.getState().settings?.cwd
    check(!!fixture, `隔离 fixture 目录可用（${fixture}）`)
    const sep = fixture.includes('\\') ? '\\' : '/'
    const bigDir = `${fixture}${sep}bigdata`
    const smallDir = `${fixture}${sep}smalldata`

    const direct = await window.yan.checkpoints.assess(bigDir)
    check(direct && direct.fits === false && direct.oversizedFiles === 1, `主进程评估：大文件目录判为不合适（${JSON.stringify(direct)}）`)
    const directSmall = await window.yan.checkpoints.assess(smallDir)
    check(directSmall?.fits === true, `主进程评估：小目录判为合适（${JSON.stringify(directSmall)}）`)
    check((await window.yan.checkpoints.assess('relative\\path')) === null, '主进程评估：相对路径被拒绝')

    const now = Date.now()
    const settings = store.getState().settings
    const record = { id: PROJECT_ID, cwd: smallDir, name: 'FitProbe', archived: false, createdAt: now, updatedAt: now }
    const realSessions = store.getState().sessions
    const session = {
      id: 'probe-fit-s1', path: `${smallDir}${sep}probe-fit-s1.jsonl`, cwd: smallDir, title: '目录提示会话', projectId: PROJECT_ID,
      named: false, createdAt: now, updatedAt: now, messageCount: 2, model: 'probe', lastActivityAt: now
    }
    await store.getState().patchSettings({ projects: [...(settings?.projects ?? []), record] }).catch(() => undefined)
    store.setState({ sessions: [session] })
    check(await until(() => !!q('v3-project-more'), 4000), '项目分区出现「…」按钮')
    await dismissToasts()

    out.push('')
    out.push('--- 1. 更换到含 21 MB 文件的目录 ---')
    check(await changeDirectory(bigDir), '更换目录对话框保存并关闭')
    check(await until(() => store.getState().settings?.projects?.find((p) => p.id === PROJECT_ID)?.cwd === bigDir, 4000), '项目目录已改为大目录（只提醒不拦截）')
    check(await until(() => !!fitToast(), 10000), '出现目录过大提示')
    const text = fitToast() ?? ''
    note(`提示文本：${text}`)
    check(text.includes('Paks/game.pak') && text.includes('21 MB'), '提示写明命中的文件与大小')
    check(!!document.querySelector('.ui-toast--warning'), '提示为警告色')
    window.__workspaceFitShot = true
    await wait(1500)

    out.push('')
    out.push('--- 2. 换回小目录 ---')
    await dismissToasts()
    check(await changeDirectory(smallDir), '再次更换目录成功')
    await wait(3000)
    check(!fitToast(), '小目录不出现提示')

    store.setState({ sessions: realSessions })
    await store.getState().patchSettings({
      projects: (store.getState().settings?.projects ?? []).filter((p) => p.id !== PROJECT_ID)
    }).catch(() => undefined)
    out.push('证据范围：隔离数据目录、真实主进程评估与更换目录 IPC、真实提示条 DOM；项目与会话为注入数据，未调模型。')
  } catch (error) {
    out.push(`  ✗ 场景异常：${error?.stack ?? error}`)
  }
  return out.join('\n')
})()
