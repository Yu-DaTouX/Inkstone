;(async () => {
  const store = window.__yanStore
  const q = selector => document.querySelector(selector)
  const qa = selector => [...document.querySelectorAll(selector)]
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const out = []
  const ok = (condition, label) => out.push(`${condition ? '✓' : '✗'} ${label}`)
  const scrolls = el => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1
  const snapshot = { exists: true, size: 100 }
  const diff = { path: 'src/example.ts', before: snapshot, after: snapshot, added: 2, removed: 1, status: 'modified', patch: '  unchanged\n- const old = 1\n+ const next = 2\n+ export { next }' }
  const longOutput = Array.from({ length: 100 }, (_, index) => `${index + 1}: 这是已记录的工具结果，不应被参数 JSON 挡住。`).join('\n') + '\nRESULT_END'
  const calls = [
    { id: 'layout-read', name: 'read', args: { path: 'C:/long/project/src/renderer/components/example.ts', offset: 1, limit: 200 }, output: longOutput, status: 'ok' },
    { id: 'layout-edit', name: 'edit', args: { path: 'src/example.ts', edits: [{ oldText: 'const old = 1', newText: 'const next = 2\nexport { next }' }] }, output: 'Edited successfully', status: 'ok', details: { fileDiff: diff } },
    { id: 'layout-bash', name: 'bash', args: { command: 'rg --line-number "very-long-search-pattern-for-command-layout" src/renderer/src/components/example.ts; npm run typecheck; npm run test:unit' }, output: longOutput, status: 'ok' },
    { id: 'layout-write', name: 'write', args: { path: 'unknown-baseline.txt', content: 'This might overwrite a file.' }, output: 'Written', status: 'ok' },
    { id: 'layout-error', name: 'bash', args: { command: 'fixture command only' }, output: 'Permission denied (synthetic)', status: 'error' }
  ]
  const row = name => q(`.trow[data-tool="${name}"]`)
  const expand = async el => {
    if (!el) throw Error('expand: 工具行不在 DOM 里 —— 先确认过程入口已展开')
    if (!el.classList.contains('open')) { el.querySelector('.trow-head').click(); await sleep(120) }
  }
  try {
    for (let n = 0; n < 60 && store.getState().conn !== 'ready'; n++) await sleep(100)
    store.getState().closeSettings()
    store.getState().setRailPinned(false)
    const state = store.getState()
    store.setState({ rightPanelOpen: false, approvals: [], subagents: [],
      session: { ...state.session, isAgentRunning: false, isStreaming: false },
      messages: [{ id: 'layout-user', role: 'user', text: '查看命令调用与文件修改' },
        { id: 'layout-assistant', role: 'assistant', text: '文件修改与命令输出使用同一套详情；并列栏可宽幅查看。', toolCalls: calls }],
      settings: { ...state.settings, processLayout: 'inline', toolDetail: false } })
    await sleep(500)
    for (const layout of ['inline', 'side', 'left']) {
      store.setState({ settings: { ...store.getState().settings, processLayout: layout } })
      await sleep(350)
      const toggle = q('[data-testid="turn-process-toggle"]')
      if (toggle?.getAttribute('aria-expanded') === 'false') { toggle.click(); await sleep(150) }
      if (!row('read')) throw Error('Missing read tool')
      ok(!q('.tgroup > [data-testid="tool-group-toggle"]'), `${layout}: short groups need no second expansion`)
      const head = row('edit').querySelector('.trow-head')
      ok(head.textContent.includes('+2') && head.textContent.includes('−1'), `${layout}: true change counts visible in collapsed row`)
      ok(!row('write').querySelector('.trow-head .fd-stat'), `${layout}: missing snapshot does not invent counts`)
      ok(!row('read').querySelector('.fd-stat'), `${layout}: read has no change count`)
      const proc = q('.tproc'), stream = q('.stream')
      const isSide = layout !== 'inline' && stream.clientWidth >= 1240
      if (innerWidth >= 1600 && layout !== 'inline') ok(isSide, `${layout}: wide-window fixture must exercise a real side column`)
      ok((getComputedStyle(proc).position === 'sticky') === isSide, `${layout}: responsive side/inline placement (${stream.clientWidth}px)`)
      for (const node of document.querySelectorAll('.tproc-tree, .tgroup, .trow-expand-inner')) {
        ok(!scrolls(node), `${layout}: ${node.className} is not an extra scrolling container`)
      }
      await expand(row('read'))
      const readContent = row('read').querySelector('.tool-view-content')
      ok(readContent.innerText.includes('RESULT_END'), `${layout}: last recorded output line retained`)
      ok(!row('read').querySelector('.tool-args').open, `${layout}: raw arguments collapsed by default`)
      ok(row('read').querySelector('.tool-view-target').textContent === calls[0].args.path, `${layout}: full path available in detail`)
      readContent.scrollTop = readContent.scrollHeight
      await sleep(180)
      const remaining = readContent.scrollHeight - readContent.clientHeight - readContent.scrollTop
      ok(readContent.scrollTop > 0 && remaining <= 2, `${layout}: single result region reaches end (top=${readContent.scrollTop}, client=${readContent.clientHeight}, scroll=${readContent.scrollHeight}, remaining=${remaining})`)
      const button = row('read').querySelector('[data-testid="tool-detail-wide"]')
      button.focus(); button.click(); await sleep(220)
      const dialog = q('.tool-detail-dialog')
      const rect = dialog.getBoundingClientRect()
      ok(rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1, `${layout}: wide view stays inside viewport`)
      ok(dialog.getAttribute('aria-modal') === 'true' && dialog.contains(document.activeElement), `${layout}: modal focus is inside wide view`)
      const focusables = [...dialog.querySelectorAll('button, [tabindex="0"]')].filter(el => el.getClientRects().length)
      focusables.at(-1).focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      ok(document.activeElement === focusables[0], `${layout}: Tab remains inside dialog`)
      ok(dialog.querySelector('.tool-view-content').textContent.includes('RESULT_END'), `${layout}: wide view retains complete recorded result`)
      ok(dialog.querySelectorAll('.tool-view-target').length === 1, `${layout}: wide view states the path once`)
      ok(!dialog.querySelector('.fd-head'), `${layout}: wide view does not repeat the file header for a plain result`)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(150)
      ok(!q('.tool-detail-dialog') && document.activeElement === button, `${layout}: Escape closes and restores triggering focus`)
      ok(row('read').classList.contains('open'), `${layout}: closing wide view preserves expansion`)
      row('read').querySelector('.trow-head').click(); await sleep(80)
      await expand(row('edit'))
      ok(row('edit').querySelectorAll('.ui-diff-line[data-kind="add"]').length === 2 && row('edit').querySelectorAll('.ui-diff-line[data-kind="del"]').length === 1, `${layout}: patch lines marked added/deleted`)
      row('edit').querySelector('.trow-head').click(); await sleep(80)
      await expand(row('bash'))
      const term = row('bash').querySelector('.term')
      ok(term.clientHeight > innerHeight * 0.25, `${layout}: command is not clipped by old 25vh wrapper`)
      ok(!scrolls(row('bash').querySelector('.trow-expand-inner')), `${layout}: only terminal owns command scrolling`)
      ok(getComputedStyle(term.querySelector('.term-prompt-text')).whiteSpace === 'pre', `${layout}: long command preserves source line structure`)
      const commandWide = row('bash').querySelector('[data-testid="tool-detail-wide"]')
      commandWide.focus(); commandWide.click(); await sleep(200)
      const commandContent = q('.tool-detail-dialog .tool-view-content')
      ok(!q('.tool-detail-dialog .term').style.height && !scrolls(q('.tool-detail-dialog .term-body')), `${layout}: wide command does not nest a fixed-height terminal`)
      commandContent.scrollTop = commandContent.scrollHeight
      await sleep(160)
      ok(commandContent.scrollTop + commandContent.clientHeight >= commandContent.scrollHeight - 2, `${layout}: wide command scrolls to output end`)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(100)
      row('bash').querySelector('.trow-head').click(); await sleep(80)
    }
    await expand(row('edit'))
    const patch = row('edit').querySelector('.fd-patch')
    ok(getComputedStyle(patch).whiteSpace === 'pre-wrap' && getComputedStyle(patch).overflowWrap === 'anywhere', 'Long patch lines wrap rather than clip inside file container')
    row('edit').querySelector('.trow-head').click(); await sleep(80)
    await expand(row('write'))
    ok(!row('write').querySelector('.write-body').classList.contains('add') && !!row('write').querySelector('.fd-note'), 'Unknown write baseline displays a notice, not a fabricated added-file diff')
    row('write').querySelector('.trow-head').click(); await sleep(80)
    const many = [
      { id: 'l1', name: 'bash', args: { command: 'echo m1' }, status: 'error', output: 'm1 failed' },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `l${index + 2}`, name: 'bash', args: { command: `echo m${index + 2}` }, status: 'ok', output: 'ok' }))
    ]
    store.setState({ messages: [{ id: 'layout-user2', role: 'user', text: '七步长组' },
      { id: 'layout-assistant2', role: 'assistant', text: '', toolCalls: many }] })
    await sleep(450)
    const groupToggle = q('[data-testid="turn-process-toggle"]')
    if (groupToggle?.getAttribute('aria-expanded') === 'false') { groupToggle.click(); await sleep(200) }
    const fold = q('[data-testid="tool-group-toggle"]')
    ok(!!fold && fold.getAttribute('aria-expanded') === 'false', 'seven steps: earlier steps still fold by default')
    ok(qa('.tgroup .trow').length === 1, 'seven steps: only the unsettled step shows first')
    fold?.click(); await sleep(300)
    ok(qa('.tgroup .trow').length === 7, 'seven steps: expanding reveals every row')
    q('[data-testid="tool-group-collapse"]')?.click(); await sleep(300)
    ok(qa('.tgroup .trow').length === 1, 'seven steps: collapsing keeps the unsettled step')
    store.setState({ messages: [{ id: 'layout-user', role: 'user', text: '查看命令调用与文件修改' },
      { id: 'layout-assistant', role: 'assistant', text: '文件修改与命令输出使用同一套详情；并列栏可宽幅查看。', toolCalls: calls }] })
    await sleep(400)
    const shotToggle = q('[data-testid="turn-process-toggle"]')
    if (shotToggle?.getAttribute('aria-expanded') === 'false') { shotToggle.click(); await sleep(250) }
    for (let n = 0; n < 20 && !row('edit'); n++) await sleep(200)
    await expand(row('edit'))
    row('edit').scrollIntoView({ block: 'center' })
    await sleep(1600)
    row('edit').querySelector('[data-testid="tool-detail-wide"]').click()
    await sleep(1600)
    return out.join('\n')
  } catch (error) { out.push('✗ ' + (error.stack || String(error))); return out.join('\n') }
})()
