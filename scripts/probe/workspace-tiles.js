/* Runs inside the isolated visual-matrix renderer. All conversation/Agent data are fixtures. */
;(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const store = window.__yanStore, state = store.getState()
  state.closeSettings()
  // Previous visual states may leave a model menu open; each scene owns its overlays.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(80)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(80)
  store.setState({ settings: { ...state.settings, rightPanelOpen: true }, railPinned: false, filePreviews: {}, filePreview: null, session: { ...state.session, isStreaming: false } })
  const launcher = async label => {
    window.dispatchEvent(new CustomEvent('inkstone-workspace-open-tool'))
    await wait(70)
    const menu = document.querySelector('[data-testid="right-tool-menu-popover"]')
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === label)
    assert(button, 'Missing tool ' + label); button.click(); await wait(120)
  }
  const byId = id => [...document.querySelectorAll('[data-workspace-pane]')].find(el => el.dataset.workspacePane === id)
  const heading = id => {
    const all = [...document.querySelectorAll('.tile-heading')]
    const title = id === 'chat' ? '主会话' : id === 'tools' ? '检查器' : byId(id)?.dataset.testTitle
    return all.find(h => [...h.querySelectorAll('[role="tab"]')].some(b => title ? b.textContent === title : false))
  }
  const groupFor = id => {
    const pane = byId(id), rect = pane?.getBoundingClientRect()
    return [...document.querySelectorAll('.tile-heading')].find(h => { const r = h.getBoundingClientRect(); return rect && Math.abs(r.left - rect.left) < 2 && Math.abs(r.bottom - rect.top) < 2 })
  }
  const select = (el, value) => { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) }
  const move = async (id, target, edge) => {
    const h = groupFor(id), th = groupFor(target)
    assert(h && th, 'Visible pane needed for move ' + id + ' -> ' + target)
    /* Tool tiles open their pane menu on right-click; the main session keeps its grip button. */
    const grip = h.querySelector('button[aria-label^="移动"]')
    if (grip) grip.click(); else { const r = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right - 40, clientY: r.top + 10 })) }
    await wait(50)
    const menu = document.querySelector('[aria-label="调整工作区"]')
    select(menu.querySelector('select'), th.dataset.dockGroup); await wait(40)
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === edge)
    assert(button && !button.disabled, 'Move option missing ' + edge); button.click(); await wait(100)
  }
  // Reset fixture arrangements between window sizes, without destroying resources.
  window.dispatchEvent(new CustomEvent('inkstone-workspace-arrange')); await wait(60)
  ;[...document.querySelectorAll('[aria-label="调整工作区"] button')].find(b => b.textContent === '恢复默认排列').click()
  await wait(100)
  await launcher('文件')
  const fkey = 'fixture|C:/fixture|C:/fixture/README.md'
  const preview = { key: fkey, path: 'README.md', cwd: 'C:/fixture', loading: false, data: { ok: true, kind: 'text', abs: 'C:/fixture/README.md', name: 'README.md', text: '# Inkstone\n\n工作区磁贴布局\n\n- 主会话可移动\n- 工具标签可拆分\n- 隐藏保留资源\n', bytes: 160 } }
  store.setState({ filePreviews: { [fkey]: preview }, filePreview: preview }); await wait(140)
  await move('file:' + fkey, 'chat', '左侧')
  const fileNode = byId('file:' + fkey), chatNode = byId('chat')
  // Real local PTYs, without provider/model calls.
  let terms = store.getState().terminals
  if (terms.length < 2) { await store.getState().startTerminal({ cols: 80, rows: 24 }); await store.getState().startTerminal({ cols: 80, rows: 24 }) }
  terms = store.getState().terminals.slice(0, 2)
  await wait(400)
  const terminalA = 'terminal:' + terms[0].id, terminalB = 'terminal:' + terms[1].id
  // All tools are initially a label group. Activate the specific terminal before splitting.
  await launcher('终端'); await wait(100)
  await move(terminalA, 'chat', '右侧')
  const toolHeading = [...document.querySelectorAll('.tile-heading')].find(h => h !== groupFor(terminalA) && [...h.querySelectorAll('[role="tab"]')].some(b => b.textContent.includes('终端')))
  const secondTab = [...toolHeading.querySelectorAll('[role="tab"]')].filter(b => b.textContent.includes('终端'))[0]
  if (secondTab) secondTab.click()
  await wait(100)
  assert(!byId(terminalB).hidden, 'Second terminal must be visible before split: ' + JSON.stringify([...document.querySelectorAll('.tile-heading')].map(h => h.textContent)) + ' / ' + JSON.stringify(terms.map(t => [t.id, t.title])))
  await move(terminalB, terminalA, '下方')
  const terminalNode = byId(terminalA), textarea = terminalNode.querySelector('.xterm-helper-textarea')
  assert(textarea, 'xterm input is mounted')
  // Write/read markers through real PTY service and validate isolation.
  await window.yan.terminal.write(terms[0].id, 'echo TILE_INPUT_A\r')
  await window.yan.terminal.write(terms[1].id, 'echo TILE_INPUT_B\r')
  await wait(250)
  const a = await window.yan.terminal.attach(terms[0].id), b = await window.yan.terminal.attach(terms[1].id)
  assert(a.buffer.includes('TILE_INPUT_A') && !a.buffer.includes('TILE_INPUT_B'), 'PTY A isolation')
  assert(b.buffer.includes('TILE_INPUT_B') && !b.buffer.includes('TILE_INPUT_A'), 'PTY B isolation')
  // Resize using the keyboard control, and confirm no resource remount.
  const separator = document.querySelector('.tile-separator')
  separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key: separator.getAttribute('aria-orientation') === 'vertical' ? 'ArrowLeft' : 'ArrowUp', bubbles: true }))
  await wait(100)
  assert(byId('chat') === chatNode && byId('file:' + fkey) === fileNode && byId(terminalA) === terminalNode && terminalNode.querySelector('.xterm-helper-textarea') === textarea, 'Pane DOM preserved on move/resize')
  const before = terminalNode.getBoundingClientRect()
  /* Double-clicking the title bar maximizes and restores. */
  groupFor(terminalA).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await wait(80)
  assert(terminalNode.getBoundingClientRect().width > before.width, 'Maximize enlarges pane')
  groupFor(terminalA).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await wait(80)
  assert(Math.abs(terminalNode.getBoundingClientRect().width - before.width) < 2, 'Restore ratios')
  groupFor(terminalA).querySelector('[aria-label="收起面板，保留运行"]').click(); await wait(60)
  assert(terminalNode.hidden, 'Hide pane')
  await launcher('终端')
  assert(byId(terminalA) === terminalNode && terminalNode.querySelector('.xterm-helper-textarea') === textarea, 'Hidden terminal reuses xterm')
  // Native browser surface and overlay exclusion.
  store.setState({ browserState: { ...store.getState().browserState, open: true, url: 'about:blank', title: '本机验证页面', tabs: [], mode: 'embedded' } }); await wait(130)
  await move('browser', terminalB, '左侧')
  byId('browser').scrollIntoView({ block: 'nearest', inline: 'nearest' })
  await wait(350)
  const nativeBefore = (await window.yan.browser.getState()).__metrics
  assert(nativeBefore.visible && nativeBefore.bounds.width > 0, 'Native browser is positioned and visible: ' + JSON.stringify({ nativeBefore, browserVisible:store.getState().browserNativeVisible, hidden:byId('browser').hidden, menus:[...document.querySelectorAll('[role="menu"],[role="dialog"]')].map(el=>el.className) }))
  window.dispatchEvent(new CustomEvent('inkstone-workspace-open-tool')); await wait(90)
  assert(!(await window.yan.browser.getState()).__metrics.visible, 'Menu blocks native browser')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(100)
  assert((await window.yan.browser.getState()).__metrics.visible, 'Native browser restored after menu')
  await launcher('任务'); await wait(180)
  await move('tasks', terminalA, '右侧')
  await launcher('日志'); await wait(100)
  await move('logs', 'tasks', '下方')
  // Child message renderer fixture, with own cwd and no main composer/fork.
  const now = Date.now(), runId = 'workspace-child-one'
  store.setState({ subagents: [{ id: runId, task: '核对工作区布局', status: 'done', cwd: 'C:/fixture/child', parentSessionId: store.getState().session.sessionId, isolation: 'controlled-cwd', model: 'fixture/pi', startedAt: now - 7000, endedAt: now, transcript: [{ id: 'child-user', role: 'user', text: '核对工作区布局' }, { id: 'child-process', role: 'assistant', text: '查看两处布局配置。', toolCalls: [{ id: 'child-read', name: 'read', args: { path: 'src/layout.ts' }, status: 'ok', output: 'layout' }] }, { id: 'child-final', role: 'assistant', text: '## 检查结果\n\n布局引用保持唯一。\n\n查看 [布局文件](src/layout.ts:12)。' }] }] })
  window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: 'subagent:' + runId })); await wait(250)
  const childId = 'agent:subagent:' + runId
  await move(childId, 'file:' + fkey, '下方')
  const child = byId(childId)
  assert(child.querySelector('.turn-response h2') && child.querySelector('[data-testid="tool-group-toggle"]'), 'Shared Markdown and tool renderer')
  assert(!child.querySelector('.composer-wrap') && !child.querySelector('.msg-act'), 'Child has no main-session actions')
  const previewFile = store.getState().previewFile
  let previewRequest
  store.setState({ previewFile: (...args) => { previewRequest = args; return Promise.resolve() } }); await wait(60)
  child.querySelector('a[data-link-kind="file"]').click(); await wait(30)
  assert(previewRequest?.[2] === 'C:/fixture/child', 'Child link uses child cwd: ' + JSON.stringify(previewRequest ?? null))
  store.setState({ previewFile })
  // Pointer dragging cancellation and docking use the same transition as menus.
  const h = groupFor('browser'), hr = h.getBoundingClientRect(), target = groupFor('chat').getBoundingClientRect()
  const saved = localStorage.getItem('inkstone.workspace.tiles.v1')
  h.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: hr.left + 100, clientY: hr.top + 16, bubbles: true }))
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: target.left + 10, clientY: target.top + 150, bubbles: true })); await wait(40)
  assert(document.querySelector('.tile-drop-preview'), 'Visible pointer drop preview')
  await wait(260)
  const live = byId('browser').getBoundingClientRect()
  assert(Math.abs(live.left - hr.left) > 20 || Math.abs(live.top - hr.bottom) > 20, 'Tiles reflow live while dragging')
  assert(localStorage.getItem('inkstone.workspace.tiles.v1') === saved, 'Live preview is not saved before release')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(320)
  assert(localStorage.getItem('inkstone.workspace.tiles.v1') === saved, 'Escape preserves original layout')
  assert(Math.abs(byId('browser').getBoundingClientRect().left - hr.left) < 3, 'Escape returns tiles to their places')
  assert(!document.querySelector('.tile-drag-layer'), 'Drag overlay released')
  groupFor('browser').dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: hr.left + 100, clientY: hr.top + 16, bubbles: true }))
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: target.left + 10, clientY: target.top + 150, bubbles: true }))
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await wait(320)
  assert(localStorage.getItem('inkstone.workspace.tiles.v1') !== saved, 'Pointer drop commits layout')
  assert(byId('chat') === chatNode && byId(terminalA) === terminalNode, 'Pointer drop keeps component identity')
  // Session switch must not carry old agent pane identities into a new layout.
  const originalSession = store.getState().session
  const originalLayoutMap = JSON.parse(localStorage.getItem('inkstone.workspace.tiles.v1'))
  store.setState({ session: { ...originalSession, sessionId: 'fixture-workspace-b', conversationId: undefined, sessionFile: 'C:/fixture/workspace-b.jsonl', conversationFile: undefined } }); await wait(180)
  const otherLayout = JSON.parse(localStorage.getItem('inkstone.workspace.tiles.v1'))['C:/fixture/workspace-b.jsonl']
  assert(otherLayout && !JSON.stringify(otherLayout).includes(childId), 'Session B cannot acquire session A child panes')
  store.setState({ session: originalSession }); await wait(220)
  assert(byId('chat') === chatNode, 'Session switch retains main content mount')
  const restoredLayoutMap = JSON.parse(localStorage.getItem('inkstone.workspace.tiles.v1'))
  const originalKey = originalSession.conversationFile || originalSession.sessionFile || originalSession.conversationId || originalSession.sessionId
  assert(JSON.stringify(restoredLayoutMap[originalKey].root) === JSON.stringify(originalLayoutMap[originalKey].root), 'Session A layout restored')
  // Keep overview readable in narrow windows by focusing chat; saved multicolumn layout remains.
  if (innerWidth < 1100) { groupFor('chat').querySelector('button[aria-label^="移动"]').click(); await wait(50); [...document.querySelectorAll('[aria-label="调整工作区"] button')].find(b => b.textContent === '放大面板').click() }
  await wait(130)
  return 'ok(workspace move/split/hide/maximize/cancel; stable panes; 2 real PTYs; native WebContentsView; shared child messages)'
})()
