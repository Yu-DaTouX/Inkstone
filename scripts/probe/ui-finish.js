/* Isolated matrix fixture: verify the follow-up UI without model calls or user data. */
;(async () => {
  const store = window.__yanStore
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const find = id => document.querySelector(`[data-testid="${id}"]`)
  store.getState().closeSettings()
  const state = store.getState()
  state.setRailPinned(true)
  store.setState({
    messages: [
      { id: 'finish-user', role: 'user', text: '收尾这些界面问题。', timestamp: Date.now() - 12000 },
      { id: 'finish-tools', role: 'assistant', text: '检查界面与文件布局。', toolCalls: Array.from({ length: 14 }, (_, i) => ({ id: `finish-tool-${i}`, name: 'read', args: { path: `src/example-${i}.ts` }, status: 'ok' })), timestamp: Date.now() - 8000 },
      { id: 'finish-reply', role: 'assistant', text: '已经完成界面收尾。\n\n复制按钮位于回复时间旁，文件面板使用全部高度。', timestamp: Date.now() - 1000 }
    ],
    session: { ...state.session, isStreaming: false, isAgentRunning: false, isCompacting: false },
    runners: state.runners.map(r => ({ ...r, running: false, waiting: false }))
  })
  await sleep(200)
  const project = find('rail-project')
  check(!!project, 'Project folder is visible')
  const wasOpen = project.getAttribute('aria-expanded')
  project.click()
  await sleep(150)
  check(project.getAttribute('aria-expanded') !== wasOpen, 'Clicking project name toggles its session list')
  project.click()
  await sleep(150)
  check(project.getAttribute('aria-expanded') === wasOpen, 'Second click restores project expansion')
  check(!!find('turn-copy'), 'Each rendered reply has a footer copy action')
  const copy = find('turn-copy')
  check(copy.closest('.turn-footer') !== null, 'Reply copy sits next to the reply timestamp')
  // Intercept only this isolated fixture clipboard, never the user's clipboard.
  let copied = ''
  const original = navigator.clipboard.writeText
  navigator.clipboard.writeText = async text => { copied = text }
  try { copy.click(); await sleep(80) } finally { navigator.clipboard.writeText = original }
  check(copied === '已经完成界面收尾。\n\n复制按钮位于回复时间旁，文件面板使用全部高度。', 'Reply copy transfers the selected reply text exactly')
  find('session-menu')?.click()
  await sleep(100)
  check(!find('act-copy'), 'Header menu no longer duplicates the reply copy action')
  document.querySelector('.tile-menu-backdrop')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'files' }))
  await sleep(300)
  const tree = find('fs-tree')
  check(!!tree, 'File tree opens inside its tile')
  check(getComputedStyle(tree).maxHeight === 'none', 'File tree no longer has the old 280px cap')
  const body = tree.closest('.tile-pane')
  check(tree.getBoundingClientRect().height > body.getBoundingClientRect().height - 150, 'File tree fills the tile height')
  const group = find('tool-group')
  if (group && find('tool-group-toggle')) {
    find('tool-group-toggle').click()
    await sleep(120)
    const fold = find('tool-group-collapse')
    check(!!fold, 'Expanded tool history has a collapse action')
    check(fold.getBoundingClientRect().top < group.querySelector('[data-testid="tool-row"]').getBoundingClientRect().top, 'Tool expand and collapse actions stay above the rows')
    fold.click()
  }
  const st = store.getState()
  const originalThinking = st.setThinking
  store.setState({ setThinking: async level => store.setState({ session: { ...store.getState().session, thinkingLevel: level } }), thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], session: { ...st.session, thinkingLevel: 'medium', model: { ...st.session.model, reasoning: true }, availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } })
  await sleep(200)
  find('model-picker')?.click()
  await sleep(150)
  const slider = document.querySelector('.ui-step-slider')
  check(!!slider, 'Thinking slider is visible in model menu')
  check(getComputedStyle(slider.querySelector('.ui-step-dots')).maskImage.includes('radial-gradient'), 'Thinking track uses one aligned dot matrix')
  const wave = slider.querySelector('.ui-step-wave')
  const beforeWave = getComputedStyle(wave).backgroundPosition
  await sleep(180)
  check(getComputedStyle(wave).animationName === 'ui-step-wave' && getComputedStyle(wave).backgroundPosition !== beforeWave, 'Thinking highlight actually travels while the menu stays open')
  try {
    const thumb = slider.querySelector('[role="slider"]')
    thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    await sleep(120)
    check(store.getState().session.thinkingLevel === 'max', 'Keyboard End selects the highest thinking level')
    const track = slider.querySelector('.ui-step-track')
    const rect = track.getBoundingClientRect()
    const options = { bubbles: true, pointerId: 41, button: 0, clientX: rect.left + rect.width / 2 }
    track.dispatchEvent(new PointerEvent('pointerdown', options))
    track.dispatchEvent(new PointerEvent('pointerup', options))
    await sleep(300)
    check(store.getState().session.thinkingLevel === 'medium', 'Pointer selection commits the nearest thinking level')
  } finally { store.setState({ setThinking: originalThinking }) }
  return 'ok · project fold, reply copy, menu, full-height files, top tool controls, dot matrix'
})()
