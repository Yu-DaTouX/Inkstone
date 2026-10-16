;(async () => {
  const out = [], store = window.__yanStore, q = s => document.querySelector(s)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const ok = (v, label) => out.push(`  ${v ? '✓' : '✗'} ${label}`)
  const before = { messages: store.getState().messages, subagents: store.getState().subagents, session: store.getState().session }
  try {
    const parentSessionId = before.session?.sessionId || 'brief-fixture'
    const parentMessageId = 'brief-assistant'
    const base = { cwd: 'C:/synthetic-subagent', parentSessionId, parentMessageId, isolation: 'controlled-cwd', model: 'fixture/model', startedAt: Date.now() - 10000, transcript: [], review: 'none' }
    store.getState().closeSettings()
    store.setState({ session: { ...before.session, sessionId: parentSessionId }, messages: [{ id: 'brief-user', role: 'user', text: '分工夹具' }, { id: parentMessageId, role: 'assistant', text: '安排三个子任务' }], subagents: [
      { ...base, id: 'brief-done', task: '顺利完成', status: 'done', endedAt: Date.now() },
      { ...base, id: 'brief-review', task: '待审阅修改', status: 'done', endedAt: Date.now(), review: 'pending', diff: { files: 1, additions: 1, deletions: 0, paths: ['fixture.ts'] }, transcript: [{ id: 'm0', role: 'assistant', text: '已把错误处理改为向上抛。' }] },
      { ...base, id: 'brief-live', task: '运行任务', status: 'running', latestActivity: '正在读文件' }
    ] })
    await sleep(500)
    ok(!!q('[data-testid="subagent-group"]'), '子任务挂在所属助手回合下')
    ok(!q('[data-testid="subagent-note-brief-done"]') && !!q('[data-testid="subagent-group-toggle"]'), '无待处理事项的完成项默认收进组汇总')
    q('[data-testid="subagent-group-toggle"]')?.click(); await sleep(150)
    ok(!!q('[data-testid="subagent-note-brief-done"]'), '展开汇总可找回完成项')
    ok(!q('[data-testid="subagent-detail-brief-review"]'), '待审阅项默认不铺过程正文')
    ok(!!q('[data-testid="subagent-note-merge-brief-review"]') && !!q('[data-testid="subagent-note-discard-brief-review"]'), '待审阅项保留合并和放弃入口')
    q('[data-testid="subagent-note-brief-review"] .sg-main button[aria-expanded]')?.click(); await sleep(150)
    ok(q('[data-testid="subagent-detail-brief-review"]')?.textContent.includes('向上抛'), '详情能查看真实转录产出')
    ok(q('[data-testid="subagent-note-activity-brief-live"]')?.textContent === '正在读文件' && !q('[data-testid="subagent-detail-brief-live"]'), '运行项给当前动作，不制造已完成结论')
  } catch (error) { ok(false, String(error)) }
  finally { store.setState(before) }
  return out.join('\n')
})()
