import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '同一项目里两个会话共用目录同时运行，不再自动搬进工作树；输入框下方的「工作树」开关只记意向，发第一条消息时才把会话开进 Inkstone/ 分支的工作树并提示，改动只落在工作树里；不调用真实模型' }

const WORKTREE_DIR = /Inkstone-\d{8}-\d+/

const VIEW = `(() => {
  const s = window.__yanStore.getState()
  const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
  const toggle = document.querySelector('[data-testid="composer-worktree"]')
  return {
    cwd: s.session?.cwd ?? runner?.cwd ?? '',
    branch: runner?.isolationBranch ?? '',
    running: !!(s.session?.isStreaming || s.session?.isAgentRunning),
    messages: s.messages.length,
    toggle: toggle ? { selected: toggle.hasAttribute('data-selected'), disabled: toggle.hasAttribute('data-disabled') || toggle.disabled === true } : null,
    draft: document.querySelector('[data-testid="composer-input"]')?.textContent ?? '',
    drafts: Object.values(s.sessionRuntimes).filter((entry) => entry.draft?.trim()).length,
    warned: (document.body.innerText.match(/后写的会覆盖先写的/g) ?? []).length,
    created: (document.body.innerText.match(/已创建工作树[^\\n]*/) ?? [''])[0],
    sent: s.messages.map((message) => typeof message.text === 'string' ? message.text : JSON.stringify(message.content ?? '')).join(' '),
    marks: document.querySelectorAll('.t3-worktree-mark').length
  }
})()`

export default async function run({ cdp, box, check, report, waitFor, sleep, shot, log }) {
  const ev = (expr) => cdp.evaluate(expr)
  const flip = () => click('[data-testid="composer-worktree"] .ui-switch__track')
  const click = async (selector) => {
    const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const until = async (label, test, timeout = 30000) => {
    const end = Date.now() + timeout
    for (;;) {
      const view = await ev(VIEW)
      if (test(view)) return view
      if (Date.now() > end) throw new Error(`等待超时：${label} ${JSON.stringify(view)}`)
      await sleep(150)
    }
  }
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', permissionMode: 'all' })`)

  await ev(`window.__yanStore.getState().send('先开第一个会话')`)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning) && s.messages.length >= 2`, 60000, 100)
  const firstFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
  await ev(`window.__yanStore.getState().newSession()`)
  await sleep(1500)
  await ev(`window.__yanStore.getState().send('再开第二个会话')`)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning) && s.messages.length >= 2`, 60000, 100)
  const secondFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
  check('两个会话是不同的文件', !!firstFile && !!secondFile && firstFile !== secondFile)

  await ev(`window.__yanStore.getState().send('MDCODE 让它一直输出')`)
  await waitFor(`s.session?.isStreaming || s.session?.isAgentRunning`, 20000, 50)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(firstFile)})`)
  await sleep(1500)
  const before = await ev(VIEW)
  await ev(`window.__yanStore.getState().send('第一个会话在对方运行时发送')`)
  await sleep(2500)
  const shared = await ev(VIEW)
  const rejected = await ev(`JSON.stringify(document.body.innerText.match(/同一工作目录还有[^\\n]*/g) ?? [])`)
  report.shared = { before, shared, rejected }
  log('shared', report.shared)
  check('对方在跑时发送没有被拒绝', rejected === '[]' && shared.messages > before.messages, { rejected, before: before.messages, after: shared.messages })
  check('两个会话共用项目目录，没有被搬进工作树', !WORKTREE_DIR.test(shared.cwd) && shared.branch === '', shared.cwd)
  check('第一次并发时提示一次会互相覆盖', shared.warned === 1, shared.warned)
  await shot('shared-cwd-running')
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning)`, 60000, 100)

  await ev(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
  const offered = await until('新会话出现工作树开关', (view) => !!view.toggle && view.messages === 0)
  check('新会话的输入框下方有工作树开关，默认关', offered.toggle?.selected === false && !WORKTREE_DIR.test(offered.cwd), offered)
  await ev(`window.__yanStore.getState().insertIntoComposer('草稿跟着走')`)
  await until('草稿进了输入框', (view) => view.draft.includes('草稿跟着走'))
  const worktreesDir = `${box.project}-worktrees`
  await flip()
  const armed = await until('开关记下意向', (view) => view.toggle?.selected === true)
  check('打开开关只记意向，还没有创建工作树', !WORKTREE_DIR.test(armed.cwd) && armed.branch === '' && !existsSync(worktreesDir), armed)
  check('已经打的字留在输入框里', armed.draft.includes('草稿跟着走'), armed.draft)
  await shot('worktree-toggle-on')

  await flip()
  const left = await until('关掉开关', (view) => view.toggle?.selected === false)
  check('关掉开关仍在项目目录，没有留下工作树', !WORKTREE_DIR.test(left.cwd) && left.branch === '' && !existsSync(worktreesDir), left)

  await flip()
  await until('再次打开开关', (view) => view.toggle?.selected === true)
  await ev(`window.__yanStore.getState().insertIntoComposer(' WRITES 在工作树里写文件')`)
  await until('要发的字进了输入框', (view) => view.draft.includes('WRITES'))
  await click('.t3-send')
  const again = await until('发第一条消息时进了工作树', (view) => WORKTREE_DIR.test(view.cwd) && view.branch.startsWith('Inkstone/'), 60000)
  report.entered = again
  log('entered', again)
  check('发第一条消息时会话开进 Inkstone- 工作树，分支以 Inkstone/ 开头', WORKTREE_DIR.test(again.cwd) && again.branch.startsWith('Inkstone/'), again)
  const told = await until('出现创建提示', (view) => view.created || view.messages >= 4, 30000)
  check('创建工作树时有提示，写明分支', told.created.includes('Inkstone/'), told.created)
  await shot('worktree-created-notice')
  await waitFor(`s.session?.isStreaming || s.session?.isAgentRunning`, 20000, 50)
  await waitFor(`!(s.session?.isStreaming || s.session?.isAgentRunning) && s.messages.length >= 2`, 90000, 100)
  const done = await ev(VIEW)
  check('打的字作为第一条消息发进了工作树会话', done.sent.includes('草稿跟着走') && done.drafts <= 1, { sent: done.sent, drafts: done.drafts })
  const inWorktree = existsSync(join(again.cwd, 'notes', 'a.md'))
  const inProject = existsSync(join(box.project, 'notes', 'a.md'))
  report.wrote = { cwd: again.cwd, inWorktree, inProject, done }
  log('wrote', report.wrote)
  check('模型写的文件落在工作树里', inWorktree, again.cwd)
  check('项目目录里没有这些文件', !inProject)
  check('发过消息后开关收起，会话仍在工作树里', done.toggle === null && WORKTREE_DIR.test(done.cwd), done)
  await ev(`window.__yanStore.getState().refreshSessions()`)
  await sleep(800)
  const listed = await ev(`(async () => {
    const id = window.__yanStore.getState().session?.sessionId
    const item = (await window.yan.listSessions()).find((entry) => entry.id === id)
    const mark = document.querySelector('.t3-worktree-mark')?.getBoundingClientRect()
    return { branch: item?.worktreeBranch ?? '', marks: document.querySelectorAll('.t3-worktree-mark').length, markSize: mark ? [Math.round(mark.width), Math.round(mark.height)] : null, drafts: Object.values(window.__yanStore.getState().sessionRuntimes).filter((entry) => entry.draft?.trim()).length }
  })()`)
  report.listed = listed
  log('listed', listed)
  check('会话列表带上工作树分支，侧栏行有工作树标记', listed.branch.startsWith('Inkstone/') && listed.marks >= 1, listed)
  check('来回切换没有留下多余的草稿行', listed.drafts <= 1, listed.drafts)
  await shot('worktree-session-done')

  const opened = await ev(`(() => {
    const s = window.__yanStore.getState()
    const project = s.settings?.projects.find((item) => item.cwd === ${JSON.stringify(box.project)})
    const row = project ? document.querySelector('[data-sidebar-row="folder:' + project.id + '"]') : null
    if (!row) return false
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 10 }))
    return true
  })()`)
  let item = false
  for (let i = 0; opened && i < 40 && !item; i++) {
    await sleep(150)
    item = await ev(`!!document.querySelector('[data-testid="v3-project-new-worktree"]')`)
  }
  check('侧栏项目菜单里有「在工作树中新建会话」', item, { opened })
  if (item) {
    await shot('project-menu-worktree')
    const priorCwd = (await ev(VIEW)).cwd
    await ev(`document.querySelector('[data-testid="v3-project-new-worktree"]').click()`)
    const fromMenu = await until('菜单开出工作树会话', (view) => WORKTREE_DIR.test(view.cwd) && view.cwd !== priorCwd && view.messages === 0 && view.toggle?.selected === true, 60000)
    check('从菜单新建的会话直接开在新的工作树里', fromMenu.branch.startsWith('Inkstone/'), { cwd: fromMenu.cwd, branch: fromMenu.branch })
  }
}
