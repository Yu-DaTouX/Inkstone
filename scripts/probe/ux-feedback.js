;(async () => {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const q = selector => document.querySelector(selector)
  const store = window.__yanStore
  const out = []
  const ok = (condition, label) => out.push(`  ${condition ? '✓' : '✗'} ${label}`)
  const waitFor = async selector => {
    for (let n = 0; n < 60 && !q(selector); n++) await sleep(100)
    if (!q(selector)) throw Error(`Missing ${selector}`)
    return q(selector)
  }
  const input = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const choose = (el, value) => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) }
  try {
    for (let i = 0; i < 60 && store.getState().conn !== 'ready'; i++) await sleep(100)
    localStorage.setItem('yan.onboarded', '1')
    await store.getState().refreshSessions()
    await sleep(500)
    const permission = await waitFor('[data-testid="permission-picker"]')
    ok(permission.options.length === 2 && !q('[data-testid="work-mode-button"]'), 'Only two permission choices; legacy work modes absent')
    ok(permission.querySelector('optgroup')?.label.includes('所有会话'), 'Permission scope is explicit')
    choose(permission, 'all'); await sleep(500)
    ok(store.getState().settings.permissionMode === 'all', 'Native mode persists through real IPC')
    choose(permission, 'danger'); await sleep(500)
    ok(store.getState().settings.permissionMode === 'danger', 'Danger mode persists through real IPC')

    const model = { id: 'parent', provider: 'fixture', name: 'UX 主模型', contextWindow: 200000, reasoning: false }
    const source = store.getState().sessions.find(s => s.title.includes('fixture B'))
    if (!source) throw Error('Missing B fixture')
    const originalAbort = store.getState().abort
    const originalSwitch = store.getState().switchSession
    let stopped = 0, opened = ''
    store.setState({ abort: async () => { stopped++ }, switchSession: async path => { opened = path },
      models: [model, { ...model, id: 'haiku', provider: 'claude-bridge', name: 'CC fixture' }],
      session: { ...store.getState().session, sessionId: 'ux-main', model, cwd: 'C:/UX/a-very-long-folder-name/subfolder/project', isAgentRunning: true, isStreaming: false }, activeRunnerId: 'ux-main-run',
      runners: [{ id: 'ux-main-run', runId: 'ux-main-run', generation: 1, running: true, cwd: 'C:/UX', conn: 'ready' },
        { id: 'ux-other-run', runId: 'ux-other-run', sessionId: source.id, sessionFile: source.path, generation: 1, running: true, cwd: source.cwd, conn: 'ready' }],
      messages: [{ id: 'u', role: 'user', text: 'UX fixture' }, { id: 'a', role: 'assistant', text: '正在检查文件。', toolCalls: [{ id: 't', name: 'bash', args: { command: 'synthetic only' }, status: 'running', output: '' }] }] })
    await sleep(400)
    ok(!!q('[data-testid="composer-stop"]') && !q('[data-testid="composer-stop"]').disabled, 'Stop remains enabled during tool execution')
    q('[data-testid="composer-stop"]').click(); await sleep(100)
    ok(stopped === 1, 'Visible stop reaches current abort action (stub, no real tool)')
    input(q('[data-testid="composer"]'), '接下来的要求'); await sleep(120)
    ok(!q('[data-testid="send"]').disabled && !!q('[data-testid="composer-stop"]'), 'Send and stop coexist while a draft is present')
    input(q('[data-testid="composer"]'), '')
    store.setState({ session: { ...store.getState().session, isStreaming: true } }); await sleep(120)
    ok(!!q('[data-testid="composer-stop"]'), 'Stop remains available during text streaming')
    store.setState({ session: { ...store.getState().session, isStreaming: false },
      subagents: [{ id: 'ux-child', parentSessionId: source.id, parentRunId: 'ux-other-run', model: 'fixture/child', cwd: source.cwd, task: '来源验证', status: 'running', isolation: 'shared-cwd', transcript: [], startedAt: Date.now() }],
      approvals: [{ id: 'ux-approval', sessionId: source.id, runId: 'ux-child-run', subagentId: 'ux-child', kind: 'danger', tool: 'bash', title: '危险操作夹具', detail: 'Synthetic only: no execution', reasons: ['UX verification'], cwd: source.cwd, canRemember: false, createdAt: Date.now() }] })
    await sleep(400)
    ok(q('[data-testid="approval-source"]')?.innerText.includes(source.title) && q('[data-testid="approval-source"]').innerText.includes('fixture/child'), 'Background approval identifies conversation and child model')
    ok(q('.sb-mode-label.on')?.innerText === 'WAIT', 'Pending approval is visible in status')
    const composer = q('.composer-wrap')
    ok(composer.scrollWidth <= composer.clientWidth + 1, 'Permission, model, stop and send fit the available composer width')
    await sleep(1600)
    q('[data-testid="approval-view-source"]').click(); await sleep(120)
    ok(opened === source.path, 'View source targets the captured parent session (stub)')
    store.setState({ approvals: [{ ...store.getState().approvals[0], sessionId: 'unknown', runId: 'missing', subagentId: undefined }] }); await sleep(120)
    ok(q('[data-testid="approval-source"]').innerText.includes('未识别') && !q('[data-testid="approval-view-source"]'), 'Unknown source is not guessed from focused conversation')
    await sleep(1500)
    store.setState({ approvals: [], abort: originalAbort, session: { ...store.getState().session, isAgentRunning: false, isStreaming: false }, runners: [] })
    store.getState().openSettings('auth')
    await waitFor('[data-testid="cc-install-bridge"]'); await sleep(500)
    const auth = q('#settings-tabpanel').innerText
    ok(auth.indexOf('Claude Code 订阅') < auth.indexOf('API Key') && auth.includes('Anthropic 按量接入'), 'CC subscription entry precedes API keys; metered Anthropic is explicit')
    ok(!!q('[data-testid="cc-plugin-state"]'), 'CC plugin installation state and next step are visible')
    await sleep(1600)
    q('#settings-tab-market').focus()
    q('#settings-tab-market').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await sleep(300)
    ok(document.activeElement.id === 'settings-tab-devices' && q('#settings-tab-devices').getAttribute('aria-selected') === 'true', 'ArrowDown moves from focused market to devices')
    ok(document.querySelectorAll('[role="tab"][tabindex="0"]').length === 1, 'Settings has one keyboard tab entry')
    store.getState().openSettings('market'); await waitFor('[data-testid="plugin-market"]')
    const piTab = [...document.querySelectorAll('[role="tab"],button')].find(el => el.innerText === 'pi 插件')
    piTab.click(); await waitFor('[data-testid="set-attach-clean"]'); await sleep(500)
    q('[data-testid="set-attach-clean"]').click()
    for (let n = 0; n < 40 && !q('[data-testid="set-attach-note"]')?.innerText.includes('失败'); n++) await sleep(100)
    ok(q('[data-testid="set-attach-note"]')?.innerText.includes('历史不完整') && q('[data-testid="set-attach-note"]').innerText.includes('重试'), 'Real IPC cleanup failure preserves actionable reason (invalid fixture history)')
    ok(!q('[data-testid="set-attach-note"]')?.innerText.includes('yan:attachments:'), 'Cleanup failure hides internal IPC identifiers')
    q('[data-testid="set-attach-note"]').scrollIntoView({ block: 'center' })
    await sleep(1000)
    store.getState().closeSettings()
    window.dispatchEvent(new CustomEvent('inkstone-workspace-launch', { detail: 'agents' }))
    await waitFor('[data-testid="delegate-model"]'); await sleep(250)
    ok(q('[data-testid="delegate-target"]').innerText.includes('UX 主模型') && q('[data-testid="delegate-target"]').innerText.includes('subfolder/project'), 'Delegation resolves model and full folder')
    choose(q('[data-testid="delegate-scope"]'), 'controlled-cwd')
    input(q('[data-testid="delegate-task"]'), '仅做审查')
    q('[data-testid="delegate-model"]').click(); await sleep(150)
    choose(q('[data-testid="models-provider"]'), 'claude-bridge'); await sleep(150)
    q('[data-testid="model-option"][data-model-id="haiku"]').click(); await sleep(200)
    ok(q('[data-testid="delegate-scope"] option[value="controlled-cwd"]').disabled && q('[data-testid="subagent-panel"] button[type="submit"]').disabled, 'Changing a selected read-only task to CC prevents submission')
    q('[data-testid="delegate-model"]').click(); await sleep(150)
    q('[data-testid="delegate-follow"]').click(); await sleep(150)
    store.setState({ session: { ...store.getState().session, model: { ...model, provider: 'claude-bridge', id: 'haiku' } } }); await sleep(150)
    ok(!!q('[data-testid="delegate-readonly-hint"]') && q('[data-testid="subagent-panel"] button[type="submit"]').disabled, 'Following CC has the same restriction')
    store.setState({ session: { ...store.getState().session, model } }); await sleep(150)
    ok(!q('[data-testid="delegate-scope"] option[value="controlled-cwd"]').disabled && !q('[data-testid="subagent-panel"] button[type="submit"]').disabled, 'Compatible model restores read-only submission without starting a task')
    const panel = q('[data-testid="subagent-panel"]')
    ok(panel.scrollWidth <= panel.clientWidth + 1, 'Delegation long path does not overflow narrow panel')
    await sleep(1400)
    const titles = Object.fromEntries(store.getState().sessions.map((s,i) => [s.id, `UX History ${i}`]))
    store.setState({ manualTitles: titles })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    await waitFor('[data-testid="switcher-input"]')
    input(q('[data-testid="switcher-input"]'), 'Browser fixture A'); await sleep(700)
    ok(document.querySelectorAll('[data-testid="switcher-row"]').length > 0, 'Fixture body search produces matches')
    input(q('[data-testid="switcher-input"]'), 'NO_MATCH_UX_20261009'); await sleep(30)
    ok(document.querySelectorAll('[data-testid="switcher-row"]').length === 0, 'New query immediately excludes old body hits')
    opened = ''
    q('[data-testid="switcher-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(100)
    ok(opened === '', 'Immediate Enter cannot open old query result')
    input(q('[data-testid="switcher-input"]'), 'UX History'); await sleep(30)
    ok(document.querySelectorAll('[data-testid="switcher-row"]').length > 0, 'Current title matches remain immediately usable')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(100)
    store.setState({ switchSession: originalSwitch })
    store.setState({ session: { ...store.getState().session, isAgentRunning: true, isStreaming: false },
      approvals: [{ id: 'ux-final-approval', sessionId: source.id, runId: 'ux-other-run', kind: 'danger', tool: 'bash', title: '危险操作夹具', detail: 'Synthetic only: no execution', reasons: ['UX verification'], cwd: source.cwd, canRemember: false, createdAt: Date.now() }],
      runners: [{ id: 'ux-other-run', runId: 'ux-other-run', sessionId: source.id, sessionFile: source.path, generation: 1, running: true, cwd: source.cwd, conn: 'ready' }] })
    await sleep(250)
    const narrowComposer = q('.composer-wrap')
    ok(narrowComposer.scrollWidth <= narrowComposer.clientWidth + 1 && !!q('[data-testid="composer-stop"]'), 'Delegation panel and running composer controls coexist without overflow')
    await sleep(2200)
  } catch (error) { out.push('  ✗ UX probe: ' + String(error)) }
  return out.join('\n')
})()
