import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { createSplitHeaderSelector, createSplitPeerComposerSelector } = await compile('src/renderer/src/app/SideBySideLayout.ts')
  const target = { sessionId: 'peer', path: 'D:/proj/peer.jsonl' }
  let scans = 0
  const sessions = new Proxy([
    { id: 'other', path: target.path, title: 'Path match', cwd: 'D:/other' },
    { id: 'peer', path: 'D:/old/peer.jsonl', title: ' Peer ', cwd: 'D:/proj', projectId: 'p' }
  ], {
    get(items, key, receiver) {
      if (key === Symbol.iterator) scans++
      return Reflect.get(items, key, receiver)
    }
  })
  const base = {
    sessions, settings: { projects: [{ id: 'p', name: 'Project', cwd: 'D:/proj' }] },
    manualTitles: {}, titles: {}, session: { sessionId: 'main', cwd: 'd:\\PROJ', isStreaming: true },
    sessionRuntimes: { peer: { draft: '草稿', session: { cwd: 'D:/proj', model: { name: 'Model' } } } }
  }
  const header = createSplitHeaderSelector(target)
  const composer = createSplitPeerComposerSelector(target)
  const initialHeader = header(base)
  const initialComposer = composer(base)
  assert.deepEqual(initialHeader, { title: 'Peer', project: 'Project' })
  assert.deepEqual(initialComposer, { title: 'Peer', draft: '草稿', running: false, model: 'Model', cwdBusy: true })
  ok(scans === 1, '同一会话列表只建一次索引，ID 优先于路径且由标题和副屏输入复用')

  let stream = base
  for (let i = 0; i < 100; i++) {
    stream = {
      ...stream, session: { ...stream.session, outputSequence: i },
      sessionRuntimes: { peer: { ...stream.sessionRuntimes.peer, messages: [{ content: String(i) }], session: { ...stream.sessionRuntimes.peer.session } } }
    }
    assert.equal(header(stream), initialHeader)
    assert.equal(composer(stream), initialComposer)
  }
  ok(scans === 1, '主屏状态和副屏消息流的 100 次引用更新不改变外壳快照或重扫会话列表')
  const renamed = { ...base, sessions: [...sessions], manualTitles: { peer: ' 手动名称 ' }, settings: { projects: [{ id: 'p', cwd: 'D:/new-folder/' }] } }
  assert.deepEqual(header(renamed), { title: '手动名称', project: 'new-folder' })
  assert.equal(createSplitHeaderSelector({ path: 'd:\\PROJ\\peer.jsonl' })(renamed).title, 'Path match')
  ok(composer(renamed).title === '手动名称', '重命名、项目目录回退与大小写无关的路径查找保持正确')
  const updated = { ...base, session: { ...base.session, isStreaming: false }, sessionRuntimes: { peer: { draft: '新草稿', session: { cwd: 'D:/proj', model: { name: 'New model' }, isAgentRunning: true } } } }
  assert.deepEqual(composer(updated), { title: 'Peer', draft: '新草稿', running: true, model: 'New model', cwdBusy: false })
  const background = { ...base, session: null, sessionRuntimes: { ...base.sessionRuntimes, runner: { session: { cwd: 'D:/PROJ', isAgentRunning: true } } } }
  ok(composer(background).cwdBusy && !composer({ ...background, sessionRuntimes: base.sessionRuntimes }).cwdBusy, '同目录忙碌响应后台任务启停，排除副屏自身')

  const { createPreviewManifestSelector, livePreviewTarget } = await compile('src/renderer/src/features/preview/preview-stream.ts')
  const manifest = createPreviewManifestSelector(true)
  const v1 = { id: 'v1', sourceId: 'document', version: 1 }
  const v2 = { id: 'v2', sourceId: 'document', version: 2 }
  const list = manifest({ messages: [{ artifacts: [v1, v2] }] })
  assert.deepEqual(list, [v2])
  assert.equal(manifest({ messages: [{ artifacts: [v1, v2], content: '流式工具输出' }] }), list)
  assert.equal(manifest({ messages: [{ artifacts: [v2] }] }), list)
  ok(manifest({ messages: [] }).length === 0, '清单仅在可见产物版本变化时更新，清空消息不会残留旧会话产物')
  const hidden = createPreviewManifestSelector(false)
  ok(hidden({ get messages() { throw new Error('不应读取隐藏预览的消息') } }).length === 0, '隐藏或非当前属主的清单跳过消息读取')
  const live = { sessionId: 'peer', path: 'D:/proj/Web.html', revision: 2, draft: '<main />' }
  assert.equal(livePreviewTarget(live, 'peer', 'd:\\proj\\web.html'), live)
  assert.equal(livePreviewTarget(live, 'main', live.path), null)
  assert.equal(livePreviewTarget(live, 'peer', 'D:/proj/other.html'), null)
  ok(livePreviewTarget(live, 'peer', null) === null, 'HTML 流只通知匹配的会话和文件')

  const { createTerminalPaneJobsSelector, terminalAwaitingConfirm } = await compile('src/renderer/src/features/terminal/terminal-pane-state.ts')
  const terminalJobs = createTerminalPaneJobsSelector()
  const job = (terminalId, command, extra = {}) => ({ terminalId, command, state: 'running', ...extra })
  const mine = [job('a', 'first'), job('a', 'second'), job('a', 'shell', { kind: 'bash' }), job('b', 'finished', { state: 'timeout', endedAt: 3 })]
  const jobs = terminalJobs(mine, ['a', 'b'])
  assert.equal(jobs.count, 2)
  assert.deepEqual([...jobs.commands], [['a', 'first']])
  assert.equal(terminalJobs([...mine.map((item) => ({ ...item })), job('foreign', 'unrelated')], ['a', 'b']), jobs)
  assert.equal(terminalJobs([job('a', 'first', { state: 'stopping' }), job('a', 'unseen command', { state: 'timeout' })], ['a']), jobs)
  ok(terminalJobs([mine[1], mine[0]], ['a']).commands.get('a') === 'second', '终端忽略无关任务与不可见字段，保留活跃计数和首条命令顺序')
  ok(terminalJobs(mine, ['b']).count === 0 && terminalJobs([job('a', '')], ['a']).commands.has('a'), '终端归属变化移除旧任务，空命令仍计为占用')
  const approvals = [{ tool: 'terminal', sessionId: 'foreign' }, { tool: 'terminal', sessionId: 'peer', phase: 'resolved' }, { tool: 'terminal', sessionId: 'peer', subagentId: 'sub' }, { tool: 'bash', sessionId: 'peer' }]
  ok(!terminalAwaitingConfirm(approvals, 'peer') && terminalAwaitingConfirm(approvals, null) && terminalAwaitingConfirm([...approvals, { tool: 'terminal' }], 'peer'), '终端审批提示保留会话约束、代理排除和无会话回退')

  const { usageChartData, usageDayRows, usageModelRows } = await compile('src/renderer/src/features/usage/usage-page-data.ts')
  const { usageModelName, usageModelFree, usageBars } = await compile('src/renderer/src/features/settings/usage/usage-model.ts')
  const heat = Array.from({ length: 40 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, tokens: i === 4 ? 5 : i === 37 ? 20 : i === 39 ? 10 : 0 }))
  const chart = usageChartData(heat, 'all')
  assert.equal(chart.points.length, 36)
  assert.deepEqual(chart.axisLabels, ['11/5', '11/22', '11/40'])
  assert.equal(usageChartData(heat, '7d').points.length, 7)
  ok(usageChartData(heat.map((day) => ({ ...day, tokens: 0 })), 'all').points.length === 30, '走势图保留原始窗口长度和轴标签')
  const dayRows = usageDayRows(heat, 'all')
  ok(dayRows.map((row) => row.key).join() === '2026-11-40,2026-11-38' && dayRows[0].ratio === 0.5 && dayRows[1].share === 20 / 30, '按天明细保持 30 天上限、逆序及原份额')
  const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const models = [
    { provider: 'first', id: 'foo', name: 'First catalog entry', cost: free },
    { provider: 'second', id: 'foo', name: 'Second catalog entry', cost: { ...free, output: 1 } },
    { provider: 'third', id: 'foo', name: 'foo', cost: { ...free, input: 1 } },
    { provider: 'second', id: 'foo', name: 'Duplicate', cost: free }
  ]
  const entries = [
    { key: 'foo', sources: ['second/foo', 'first/foo'], tokens: 100, cost: 2 },
    { key: 'foo', sources: ['third/foo'], tokens: 60, cost: 3 },
    { key: 'foo', sources: ['missing/foo'], tokens: 0, cost: 0 },
    { key: 'new:free', sources: ['missing/new:free'], tokens: 40, cost: 0 }
  ]
  const bars = usageBars(entries.map((entry) => ({ key: entry.key, label: usageModelName(entry, models), value: entry.tokens })))
  assert.deepEqual(usageModelRows(entries, models), bars.map((bar, i) => ({ ...bar, cost: entries[i].cost, free: usageModelFree(entries[i], models), title: entries[i].sources.join(' · '), provider: entries[i].sources[0].split('/')[0] })))
  ok(true, '索引后的模型标签、免费判定与原实现一致，来源冲突时保持目录优先级与回退')
})
