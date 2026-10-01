/* README 主页截图场景：在隔离的视觉矩阵渲染端执行。会话、文件与子 Agent 全部为合成数据，不启动模型。 */
;(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const store = window.__yanStore, state = store.getState()
  state.closeSettings()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(80)
  const now = Date.now(), cwd = 'C:/work/bookshop'
  const model = { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'openai-codex', reasoning: true, contextWindow: 400000 }
  const sessions = [
    { id: 'b1', path: 'C:/demo/sessions/b1.jsonl', cwd, title: '独立书店 · 网站改版', named: true, createdAt: now - 3600000, updatedAt: now - 60000, messageCount: 6, model: 'GPT-6 Astra' },
    { id: 'b2', path: 'C:/demo/sessions/b2.jsonl', cwd, title: '本月书单文案', named: true, createdAt: now - 86400000, updatedAt: now - 5400000, messageCount: 12, model: 'GPT-6 Astra' },
    { id: 'b3', path: 'C:/demo/sessions/b3.jsonl', cwd, title: '活动报名表单', named: true, createdAt: now - 172800000, updatedAt: now - 86400000, messageCount: 9, model: 'GPT-6 Astra' },
    { id: 'n1', path: 'C:/demo/sessions/n1.jsonl', cwd: 'C:/work/notes', title: '读书笔记整理', named: true, createdAt: now - 259200000, updatedAt: now - 7200000, messageCount: 15, model: 'GPT-6 Astra' },
    { id: 'n2', path: 'C:/demo/sessions/n2.jsonl', cwd: 'C:/work/notes', title: '跟导师学排版基础', named: true, createdAt: now - 345600000, updatedAt: now - 172800000, messageCount: 22, model: 'GPT-6 Astra' }
  ]
  const messages = [
    { id: 'u1', role: 'user', text: '为独立书店改版首页：介绍书店、展示本月书单，并提供来店信息。先整理页面结构，再让子 Agent 去核对书单数据。', timestamp: now - 240000 },
    {
      id: 'a1', role: 'assistant', model: 'GPT-6 Astra',
      thinking: '先读现有的 brief.md 和 books.json，确认三个区块需要的内容，再把书单核对交给子 Agent 并行处理。',
      thinkingMs: 3200, thinkingLive: false,
      text: '页面结构整理好了，首页围绕三个区块展开：\n\n| 区块 | 内容 |\n| --- | --- |\n| 认识书店 | 一句话介绍、空间照片与书店故事 |\n| 本月书单 | 精选 6 本书、推荐理由与阅读主题 |\n| 来店坐坐 | 地址、营业时间与本周活动 |\n\n结构已写入 `brief.md`；书单核对交给了子 Agent，结果在右侧。下一步可以先定版式，再逐步补充图片。',
      usage: { input: 9400, output: 720, cacheRead: 6100, cacheWrite: 0, totalTokens: 10120, cost: 0.005 },
      toolCalls: [
        { id: 't1', name: 'read', args: { path: 'brief.md' }, status: 'ok', output: '# 书店首页', startedAt: now - 236000, endedAt: now - 235400 },
        { id: 't2', name: 'edit', args: { path: 'brief.md' }, status: 'ok', output: '已应用 2 处改动（+18 −4）', startedAt: now - 234000, endedAt: now - 233000 },
        { id: 't3', name: 'bash', args: { command: 'npm run build' }, status: 'ok', output: '✓ built in 1.8s', startedAt: now - 232000, endedAt: now - 230000 }
      ],
      speed: 44, elapsedMs: 18600, timestamp: now - 228000
    }
  ]
  store.setState({
    conn: 'ready', connDetail: undefined, models: [model], sessions,
    settings: { ...state.settings, cwd, recentCwds: [cwd, 'C:/work/notes'], rightPanelOpen: true, theme: state.settings.theme },
    railPinned: false, filePreviews: {}, filePreview: null,
    session: { ...state.session, sessionId: 'b1', sessionFile: 'C:/demo/sessions/b1.jsonl', conversationId: undefined, conversationFile: undefined, sessionName: '独立书店 · 网站改版', model, cwd, isStreaming: false, isAgentRunning: false, messageCount: messages.length, thinkingLevel: 'medium' },
    stats: { tokens: { input: 9400, output: 720, cacheRead: 6100, cacheWrite: 0, total: 10120 }, cost: 0.005, contextUsage: { tokens: 10120, contextWindow: 400000, percent: 2.5 }, toolCalls: 3, userMessages: 1, assistantMessages: 1 },
    todos: [{ text: '整理首页结构', done: true }, { text: '核对本月书单', done: true }, { text: '确定版式', done: false }],
    notices: [], statuses: {}, widgets: {}
  })
  store.getState().applyPush({ ch: 'sync', payload: messages })
  await wait(300)

  const launcher = async label => {
    window.dispatchEvent(new CustomEvent('inkstone-workspace-open-tool'))
    await wait(80)
    const menu = document.querySelector('[data-testid="right-tool-menu-popover"]')
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === label)
    assert(button, 'Missing tool ' + label); button.click(); await wait(140)
  }
  const byId = id => [...document.querySelectorAll('[data-workspace-pane]')].find(el => el.dataset.workspacePane === id)
  const groupFor = id => {
    const rect = byId(id)?.getBoundingClientRect()
    return [...document.querySelectorAll('.tile-heading')].find(h => { const r = h.getBoundingClientRect(); return rect && Math.abs(r.left - rect.left) < 2 && Math.abs(r.bottom - rect.top) < 2 })
  }
  const select = (el, value) => { const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) }
  const move = async (id, target, edge) => {
    const h = groupFor(id), th = groupFor(target)
    assert(h && th, 'Visible pane needed for move ' + id + ' -> ' + target)
    const grip = h.querySelector('button[aria-label^="移动"]')
    if (grip) grip.click(); else { const r = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right - 40, clientY: r.top + 10 })) }
    await wait(60)
    const menu = document.querySelector('[aria-label="调整工作区"]')
    select(menu.querySelector('select'), th.dataset.dockGroup); await wait(40)
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === edge)
    assert(button && !button.disabled, 'Move option missing ' + edge); button.click(); await wait(120)
  }
  window.dispatchEvent(new CustomEvent('inkstone-workspace-arrange')); await wait(60)
  ;[...document.querySelectorAll('[aria-label="调整工作区"] button')].find(b => b.textContent === '恢复默认排列').click()
  await wait(120)

  await launcher('文件')
  const fkey = 'demo|' + cwd + '|' + cwd + '/brief.md'
  const text = '# 书店首页\n\n## 认识书店\n\n街角的一间小书店，也是一处可以停留的地方。\n\n## 本月书单\n\n- 主题：「慢慢读」\n- 精选 6 本，附推荐理由\n\n## 来店坐坐\n\n- 营业：周二至周日 10:00–21:00\n- 周六晚上有读书会\n'
  const preview = { key: fkey, path: 'brief.md', cwd, loading: false, data: { ok: true, kind: 'text', abs: cwd + '/brief.md', name: 'brief.md', text, bytes: text.length } }
  store.setState({ filePreviews: { [fkey]: preview }, filePreview: preview }); await wait(160)
  const fileId = 'file:' + fkey
  await move(fileId, 'chat', '右侧')

  const runId = 'showcase-books'
  store.setState({ subagents: [{ id: runId, task: '核对本月书单', status: 'done', cwd, parentSessionId: 'b1', isolation: 'controlled-cwd', model: 'GPT-6 Astra', startedAt: now - 200000, endedAt: now - 150000, transcript: [
    { id: 'c-user', role: 'user', text: '核对 books.json 里本月书单的书名、作者与库存。' },
    { id: 'c-work', role: 'assistant', text: '读取书单与库存表。', toolCalls: [{ id: 'c-read', name: 'read', args: { path: 'data/books.json' }, status: 'ok', output: '6 items' }, { id: 'c-read2', name: 'read', args: { path: 'data/stock.csv' }, status: 'ok', output: '42 rows' }] },
    { id: 'c-final', role: 'assistant', text: '## 核对结果\n\n6 本书的书名与作者均已核对，其中 1 本库存不足：\n\n| 书名 | 库存 |\n| --- | --- |\n| 《慢读》 | 2 |\n\n建议在页面上标注「少量现货」。' }
  ] }] })
  window.dispatchEvent(new CustomEvent('inkstone-agent-open', { detail: 'subagent:' + runId })); await wait(260)
  const childId = 'agent:subagent:' + runId
  await move(childId, fileId, '下方')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(120)
  /* 其余工具（文件树、检查器等）收起，只留主会话、文件与子 Agent 三块。 */
  const keep = new Set([groupFor(fileId), groupFor(childId)])
  for (let i = 0; i < 10; i++) {
    const extra = [...document.querySelectorAll('.tile-heading.ui-tile-head')].find(h => !keep.has(h))
    if (!extra) break
    extra.querySelector('[aria-label="收起面板，保留运行"]').click(); await wait(120)
  }
  store.getState().setRailPinned?.(true)
  await wait(300)
  /* 打开左栏会从矩阵桩重新拉会话列表；换回演示会话。 */
  store.setState({ sessions, titles: {}, manualTitles: {} })
  await wait(400)
  assert(byId(fileId) && !byId(fileId).hidden && byId(childId) && !byId(childId).hidden, 'Showcase panes visible')
  return 'ok(readme showcase)'
})()
