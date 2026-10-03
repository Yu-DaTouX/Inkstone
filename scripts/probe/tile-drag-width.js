/* Runs inside the isolated visual-matrix renderer. Dragging a tile must keep the size it was lifted with. */
;(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const store = window.__yanStore, state = store.getState()
  /* The window runs hidden, where CSS transitions stall; geometry must be read at its final value. */
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.tile-workspace *, .tile-workspace { transition: none !important }' }))
  state.closeSettings()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(80)
  store.setState({ settings: { ...state.settings, rightPanelOpen: true }, railPinned: false, filePreviews: {}, filePreview: null, session: { ...state.session, isStreaming: false } })
  const launcher = async label => {
    window.dispatchEvent(new CustomEvent('inkstone-workspace-open-tool'))
    await wait(70)
    const menu = document.querySelector('[data-testid="right-tool-menu-popover"]')
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === label)
    assert(button, 'Missing tool ' + label); button.click(); await wait(160)
  }
  await launcher('任务'); await launcher('日志')
  const headings = () => [...document.querySelectorAll('.tile-heading')]
  const tool = headings().find(h => !h.classList.contains('tile-grip-zone'))
  assert(tool, 'A tool tile heading is needed')
  const hr = tool.getBoundingClientRect(), pane = document.querySelector('.tile-workspace-canvas').getBoundingClientRect()
  const before = Math.round(hr.width)
  tool.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: hr.left + 40, clientY: hr.top + 12, bubbles: true }))
  const samples = []
  const stops = [[.5, .5], [.8, .5], [.95, .5], [1.02, .5], [1.1, .6], [.9, 1.0], [.9, 1.08], [.5, .5], [-.05, .5], [.5, -.05]]
  for (const [fx, fy] of stops) {
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: pane.left + pane.width * fx, clientY: pane.top + pane.height * fy, bubbles: true }))
    await wait(320)
    const float = document.querySelector('.tile-float')?.getBoundingClientRect()
    samples.push({ at: [fx, fy], floatLeft: float ? Math.round(float.left) : null, pointerX: Math.round(pane.left + pane.width * fx), floatW: float ? Math.round(float.width) : null, floatH: float ? Math.round(float.height) : null, dragging: !!document.querySelector('.tile-workspace.dragging'), panes: [...document.querySelectorAll('.tile-pane')].map(p => p.dataset.workspacePane + ':' + Math.round(p.getBoundingClientRect().width)).join(','), scrollW: document.querySelector('.tile-workspace-scroll').clientWidth, scrollH: document.querySelector('.tile-workspace-scroll').clientHeight, overW: document.querySelector('.tile-workspace-scroll').scrollWidth, overH: document.querySelector('.tile-workspace-scroll').scrollHeight })
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(320)
  const widths = samples.filter(s => s.dragging).map(s => s.floatW)
  const scroll = samples.filter(s => s.dragging)
  assert(scroll.every(s => s.scrollW === scroll[0].scrollW && s.scrollH === scroll[0].scrollH), 'Scroll viewport changed during drag: ' + JSON.stringify(scroll.map(s => [s.scrollW, s.scrollH, s.overW, s.overH])))
  const outside = scroll.filter(s => s.at[0] >= 1.02)
  assert(outside.length && outside.every(s => Math.abs(s.floatLeft - (s.pointerX - 40)) <= 3), 'Lifted tile stopped following the pointer outside the canvas: ' + JSON.stringify(outside.map(s => [s.floatLeft, s.pointerX])))
  assert(widths.every(w => w === before), 'Lifted tile width drifted: before=' + before + ' samples=' + JSON.stringify(samples))
  /* Above or below a tile the others stay put and a border marks the half it would take; beside it they reflow live. */
  {
    const h0 = headings().find(h => !h.classList.contains('tile-grip-zone')), r0 = h0.getBoundingClientRect()
    const chatPane = () => document.querySelector('[data-workspace-pane="chat"]').getBoundingClientRect()
    await wait(100)
    const rest = chatPane()
    const frames = () => [...document.querySelectorAll('.tile-frame')].map(f => (f.classList.contains('drop-slot') ? 'S' : 'F') + Math.round(f.getBoundingClientRect().left) + '+' + Math.round(f.getBoundingClientRect().width)).join(',')
    const restFrames = frames()
    h0.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: r0.left + 40, clientY: r0.top + 12, bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: rest.left + rest.width / 2, clientY: rest.top + 20, bubbles: true })); await wait(320)
    const edge = document.querySelector('[data-testid="tile-drop-edge"]')
    assert(edge, 'Top drop shows a border')
    const edgeBox = edge.getBoundingClientRect(), now = chatPane()
    assert(Math.abs(now.left - rest.left) <= 2 && Math.abs(now.width - rest.width) <= 2, 'Tiles stay put for a top drop: ' + JSON.stringify([rest.left, rest.width, now.left, now.width, [...document.querySelectorAll('.tile-pane')].map(p => p.dataset.workspacePane + ':' + Math.round(p.getBoundingClientRect().left) + '+' + Math.round(p.getBoundingClientRect().width)).join(','), [...document.querySelectorAll('.tile-heading')].map(h => h.dataset.dockGroup + ':' + Math.round(h.getBoundingClientRect().left) + '+' + Math.round(h.getBoundingClientRect().width)).join(',')]))
    assert(edgeBox.height < now.height + 80 && Math.abs(edgeBox.top - (now.top - 30)) < 40, 'Border sits on the top half of the target: ' + JSON.stringify([edgeBox.top, now.top]))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: rest.left + 10, clientY: rest.top + rest.height / 2, bubbles: true })); await wait(320)
    assert(!document.querySelector('[data-testid="tile-drop-edge"]'), 'No border for a side drop')
    assert(Math.abs(chatPane().width - rest.width) > 2, 'Tiles reflow live for a side drop: ' + JSON.stringify([restFrames, frames(), [...document.querySelectorAll('.tile-workspace')].map(w => w.className).join(), rest.left, rest.width, chatPane().left, chatPane().width, [...document.querySelectorAll('.tile-pane')].map(p => p.dataset.workspacePane + ':' + Math.round(p.getBoundingClientRect().left) + '+' + Math.round(p.getBoundingClientRect().width)).join(',')]))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(320)
  }
  /* Dropping beside another tile keeps the width the tile had, e.g. one the user dragged to size. */
  const label = tool.querySelector('[role="tab"]').textContent
  const headingOf = () => headings().find(h => [...h.querySelectorAll('[role="tab"]')].some(b => b.textContent === label))
  const from = headingOf().getBoundingClientRect(), chat = document.querySelector('[data-workspace-pane="chat"]').getBoundingClientRect()
  const width = Math.round(from.width)
  headingOf().dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: from.left + 40, clientY: from.top + 12, bubbles: true }))
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: chat.left + 10, clientY: chat.top + chat.height / 2, bubbles: true })); await wait(120)
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); await wait(450)
  const dropped = Math.round(headingOf().getBoundingClientRect().width)
  assert(Math.abs(dropped - width) <= 2, 'Dropped tile changed width: before=' + width + ' after=' + dropped)
  return 'ok(lifted tile keeps ' + before + 'px; ' + JSON.stringify(samples) + '; dropped ' + width + ' -> ' + dropped + ')'
})()
