;(async () => {
  const out = []
  const ok = (condition, text) => { out.push(`${condition ? '✓' : '✗'} ${text}`); if (!condition) throw new Error(text) }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (selector) => document.querySelector(selector)
  const click = (element) => { if (!element) throw new Error('缺少点击目标'); element.click() }
  const wait = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(60) } throw new Error('等待超时') }
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (value) => String(value).replaceAll('\\', '/').toLowerCase()
  const store = window.__yanStore
  const row = () => q('[data-testid="rail-project-row"][data-drag-id="probe-directory"]')
  const open = async () => {
    click(row()?.querySelector('.proj-rename'))
    await wait(() => q('[data-testid="rail-project-directory"]'))
    click(q('[data-testid="rail-project-directory"]'))
    await wait(() => q('[data-testid="project-directory-input"]'))
    await sleep(200)
  }
  try {
    await wait(() => store?.getState().settings && q('.rail'))
    localStorage.setItem('yan.onboarded', '1')
    store.getState().setRailPinned(true)
    const root = store.getState().settings.cwd.replace(/[\\/]+$/, '')
    const oldCwd = `${root}/probe-projects/p1`, target = `${root}/probe-projects/p2`
    const now = Date.now()
    await store.getState().patchSettings({ projects: [{ id: 'probe-directory', cwd: oldCwd, name: '个人项目 · 目录验证', createdAt: now, updatedAt: now }], projectNames: {}, recentCwds: [oldCwd] })
    store.setState({ sessions: [{ id: 'folder-session', path: `${oldCwd}/synthetic.jsonl`, cwd: oldCwd, projectId: 'probe-directory', title: '原目录里的会话', createdAt: now, updatedAt: now, messageCount: 1 }] })
    await sleep(350)
    if (!row() && q('[data-testid="rail-more-projects"]')) click(q('[data-testid="rail-more-projects"]'))
    await wait(row)
    await open()
    ok(q('[data-testid="project-directory-mask"]').parentElement === document.body, '对话框 Portal 不受左栏裁剪')
    const inputEl = q('[data-testid="project-directory-input"]')
    await wait(() => document.activeElement === inputEl)
    ok(document.activeElement === inputEl, '打开后聚焦新目录输入框')
    ok(q('#project-directory-description').textContent.includes('不搬动文件'), '明确说明不搬文件与旧会话边界')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(() => !q('[data-testid="project-directory-mask"]'))
    ok(key((await window.yan.getSettings()).projects.find((p) => p.id === 'probe-directory').cwd) === key(oldCwd), 'Esc 取消不改目录')
    await open()
    setValue(q('[data-testid="project-directory-input"]'), `${root}/does-not-exist`)
    await sleep(80)
    click(q('[data-testid="project-directory-save"]'))
    await wait(() => q('[data-testid="project-directory-error"]'))
    ok(!q('[data-testid="project-directory-save"]').disabled, '失败留在框内并允许重试')
    setValue(q('[data-testid="project-directory-input"]'), target)
    await sleep(80)
    const sessionBefore = store.getState().session
    const runnerBefore = store.getState().activeRunnerId
    click(q('[data-testid="project-directory-save"]'))
    await wait(() => !q('[data-testid="project-directory-mask"]'))
    const saved = (await window.yan.getSettings()).projects.find((p) => p.id === 'probe-directory')
    ok(key(saved.cwd) === key(target) && saved.name === '个人项目 · 目录验证', '正式 IPC 持久化新目录并保留项目身份名称')
    ok(store.getState().activeRunnerId === runnerBefore && store.getState().session?.cwd === sessionBefore?.cwd, '保存不切换当前会话或运行实例')
    ok(!store.getState().sessions.some((s) => s.id === 'folder-session'), '保存后刷新会话列表，注入的临时快照被权威列表替换')
    ok(!(await window.yan.listSessions()).some((s) => key(s.cwd) === key(target)), '没有任何已有会话被搬到新目录')
    const stillListed = store.getState().settings.projects.find((p) => p.id === 'probe-directory')
    ok(!!stillListed && !stillListed.archived && key(stillListed.cwd) === key(target), '项目仍在列表中、未归档且指向新目录')
    const now2 = Date.now()
    store.setState({ sessions: [{ id: 'folder-session-2', path: `${target}/synthetic.jsonl`, cwd: target, projectId: 'probe-directory', title: '新目录里的会话', createdAt: now2, updatedAt: now2, messageCount: 1 }] })
    await sleep(350)
    if (!row() && q('[data-testid="rail-more-projects"]')) click(q('[data-testid="rail-more-projects"]'))
    await wait(row)
    await open()
    ok(key(q('#project-directory-old').value) === key(target), '再次打开显示已保存的新目录')
  } catch (error) { out.push(`✗ 探针出错: ${error.message ?? String(error)}`) }
  return out.join('\n')
})()
