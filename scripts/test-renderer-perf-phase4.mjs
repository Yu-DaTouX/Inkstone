import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const {
    createStore, shallow, selectContextSession, selectOverviewSession, selectTerminalJobView, selectMcpView,
    createLogStatusSelector, createPeerAskSelector, createFilesRowsSelector, watchSplitRestore,
    restoreSplit, SPLIT_STORAGE_VERSION, cwdBusy
  } = await compile(null, {
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        export { createStore } from 'zustand/vanilla'
        export { shallow } from 'zustand/shallow'
        export * from './src/renderer/src/features/workbench/rail-selectors'
        export { createPeerAskSelector } from './src/renderer/src/features/split/peer-ask-view'
        export { watchSplitRestore, restoreSplit, SPLIT_STORAGE_VERSION } from './src/renderer/src/features/split/split-persist'
        export { createFilesRowsSelector } from './src/renderer/src/features/files/files-model'
        export { cwdBusy } from './src/renderer/src/features/changes/git-flow'
      `
    }
  })

  const session = {
    sessionId: 'a', sessionFile: 'a.jsonl', conversationFile: 'conversation.jsonl',
    model: { id: 'model', provider: 'pi' }, isAgentRunning: true, isStreaming: false, isCompacting: false
  }
  const before = { session, peekedSessionId: null, peekedPath: null, activeRunnerId: 'runner-a' }
  const tick = { ...before, session: { ...session, messageCount: 101, thinkingLevel: 'high', retry: { attempt: 2 } } }
  const projections = [selectContextSession, selectOverviewSession, selectTerminalJobView, selectMcpView]
  ok(projections.every((select) => shallow(select(before), select(tick))), '文本流、思考档与重试推送不改变右栏订阅投影')
  ok(shallow(selectOverviewSession(before), selectOverviewSession({ ...before, session: { ...session, isStreaming: true } })), '已运行时的出字开始不改变概览的运行标记')
  ok(!shallow(selectContextSession(before), selectContextSession({ ...before, session: { ...session, isCompacting: true } })), '实际压缩状态仍更新上下文面板')
  ok(!shallow(selectOverviewSession(before), selectOverviewSession({ ...before, session: { ...session, lastCompaction: { status: 'completed' } } })), '新压缩结果仍更新概览摘要')
  const peek = { ...before, peekedSessionId: 'b', peekedPath: 'b.jsonl' }
  ok(selectOverviewSession(before).key === 'conversation.jsonl' && selectTerminalJobView(before).sessionFile === 'a.jsonl', '概览折叠键和后台任务保持各自的路径优先级')
  ok(selectTerminalJobView(peek).sessionId === 'b' && selectOverviewSession(peek).key === 'b.jsonl', '历史预览归属切换')
  ok(!shallow(selectMcpView(before), selectMcpView({ ...before, activeRunnerId: 'runner-b' })) && !shallow(selectMcpView(before), selectMcpView(peek)), 'MCP 在运行实例或预览切换时刷新')

  const logStatuses = createLogStatusSelector()
  const logs = logStatuses({ statuses: { ext: 'ready' } })
  ok(logStatuses({ statuses: { ext: 'ready', inkstone_context_usage: 'updated', inkstone_prompt_suggestion: 'changed' } }) === logs, '日志忽略不会显示的上下文和提示状态')
  ok(logStatuses({ statuses: { ext: 'offline' } }) !== logs, '可见扩展状态变化时更新日志')
  const ordered = logStatuses({ statuses: { x: '1', y: '2' } })
  ok(logStatuses({ statuses: { y: '2', x: '1' } }) !== ordered, '扩展状态顺序变化时更新显示顺序')

  const selectAsk = createPeerAskSelector('b')
  const approvals = [{ sessionId: 'a', title: 'not for this pane' }]
  const question = { message: 'Choose', title: 'Fallback' }
  const peer = { approvals, sessionRuntimes: { b: { uiRequests: [question], messages: [] } } }
  const ask = selectAsk(peer)
  ok(ask?.kind === 'answer' && ask.text === 'Choose', '副屏显示自己的首个提问')
  ok(selectAsk({ ...peer, sessionRuntimes: { ...peer.sessionRuntimes, a: { messages: ['stream'] }, b: { uiRequests: [{ ...question, harmless: true }], messages: ['peer stream'] } } }) === ask, '主屏与副屏出字、提问非显示字段变化不改变副屏提示引用')
  const approved = selectAsk({ ...peer, approvals: [...approvals, { sessionId: 'b', title: 'Approve' }] })
  ok(approved?.kind === 'approval' && approved.text === 'Approve', '副屏自己的审批仍优先于提问')
  ok(selectAsk({ approvals, sessionRuntimes: {} }) === null, '副屏请求清空后取消提示')

  const a = { id: 'a', path: 'a.jsonl' }
  const b = { id: 'b', path: 'b.jsonl' }
  const saved = { version: SPLIT_STORAGE_VERSION, tiles: [{ sessionId: 'a' }, { sessionId: 'b' }], live: 1 }
  const store = createStore(() => ({ sessions: [], messages: [] }))
  let tries = 0
  let result = null
  const stop = watchSplitRestore(store, (sessions) => {
    tries++
    result = restoreSplit(saved, sessions)
    return result !== null
  })
  store.setState({ messages: ['delta'] })
  ok(tries === 0, '未载入会话和流式推送都不会触发分屏恢复')
  store.setState({ sessions: [a] })
  store.setState({ messages: ['delta 2'] })
  ok(tries === 1 && result === null, '部分会话到达后等待；无关推送不重算')
  store.setState({ sessions: [a, b] })
  ok(tries === 2 && result?.split?.tiles[result.split.live]?.sessionId === 'b', '列表补齐时恢复分屏及焦点')
  store.setState({ sessions: [{ ...a, title: 'new title' }, b] })
  ok(tries === 2, '恢复后不再监听会话列表')
  stop()

  const selectRows = createFilesRowsSelector()
  const tree = { cwd: 'E:/project', listings: { '': { entries: [{ name: 'file.txt', dir: false }] } }, open: {} }
  const rows = selectRows(tree)
  ok(rows.length === 1 && selectRows({ ...tree, focusPath: 'file.txt', loading: { '': true } }) === rows, '焦点和加载状态不重建已展示的文件树行')
  ok(selectRows({ ...tree, listings: { '': { entries: [{ name: 'new.txt', dir: false }] } } })[0]?.path === 'new.txt', '文件变化仍重建可见行')
  ok(!cwdBusy([{ cwd: 'E:/other', running: true }], tree.cwd) && cwdBusy([{ cwd: 'e:\\project', running: true }], tree.cwd), '分支选择仅关心当前仓库运行实例的忙闲')
})
