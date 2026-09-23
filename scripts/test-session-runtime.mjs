/**
 * 渲染端后台会话缓存的纯策略测试。
 * 不启动 Electron、不连接 pi，只验证身份封套、增量归并与代次闸门。
 */
export function runSessionRuntimeTests(ok, reduceSessionRuntime, sessionRuntimeKey, updateSessionRuntime, migrateSessionRuntime, rebindSessionRuntime) {
  const runtimeA = { sessionId: 'session-a', runId: 'r1', projectId: 'project-a', generation: 1 }
  const runtimeB = { sessionId: 'session-b', runId: 'r2', projectId: 'project-b', generation: 1 }
  const user = { id: 'u1', role: 'user', text: 'hello' }
  const assistant = { id: 'a1', role: 'assistant', text: '', thinking: '' }

  let map = {}
  ok(sessionRuntimeKey(runtimeA) === 'session-a', '会话缓存优先使用稳定 sessionId')
  map = reduceSessionRuntime(map, runtimeA, { ch: 'sync', payload: [user, assistant] })
  map = reduceSessionRuntime(map, runtimeA, { ch: 'msg-update', payload: { id: 'a1', patch: { textDelta: 'world', thinkingDelta: '先想' } } })
  ok(map['session-a'].messages[1].text === 'world', '后台会话保留 text 增量')
  ok(map['session-a'].messages[1].thinking === '先想', '后台会话保留 thinking 增量')

  map = reduceSessionRuntime(map, runtimeA, {
    ch: 'tool',
    payload: {
      msgId: 'a1',
      call: { id: 't1', name: 'bash', args: {}, status: 'running', output: 'one' }
    }
  })
  map = reduceSessionRuntime(map, runtimeA, {
    ch: 'tool',
    payload: {
      msgId: 'a1',
      call: { id: 't1', name: 'bash', args: {}, status: 'ok', output: 'ignored' },
      outputDelta: 'two'
    }
  })
  ok(map['session-a'].messages[1].toolCalls[0].output === 'onetwo', '工具输出按增量追加而不是覆盖')

  map = reduceSessionRuntime(map, runtimeB, { ch: 'msg-add', payload: { id: 'b1', role: 'assistant', text: '后台 B' } })
  ok(map['session-a'].messages.length === 2 && map['session-b'].messages.length === 1, 'A/B 后台事件分别落入各自会话')

  const before = map['session-a']
  const stale = { ...runtimeA, generation: 0 }
  map = reduceSessionRuntime(map, stale, { ch: 'msg-add', payload: { id: 'late', role: 'assistant', text: '迟到' } })
  ok(map['session-a'] === before, '低代次迟到事件被丢弃')

  map = reduceSessionRuntime(map, { ...runtimeA, generation: 2 }, {
    ch: 'state',
    payload: { sessionId: 'session-a', thinkingLevel: 'high', availableThinkingLevels: [], isStreaming: true, isCompacting: false, messageCount: 2, pendingMessageCount: 0, cwd: 'C:/a' }
  })
  ok(map['session-a'].runtime.generation === 2 && map['session-a'].session.isStreaming, '新代次可以推进状态快照')

  const modelA = {
    id: 'model-a', name: 'Model A', provider: 'test', reasoning: true, contextWindow: 128000
  }
  const commandsA = [{ name: 'deploy', source: 'yan', executable: true }]
  map = updateSessionRuntime(map, { ...runtimeA, generation: 2 }, {
    draft: 'A 的草稿',
    models: [modelA],
    thinkingLevels: ['low', 'high'],
    commands: commandsA
  })
  ok(map['session-a'].draft === 'A 的草稿', '草稿按会话缓存')
  ok(map['session-a'].models[0].id === 'model-a' && map['session-a'].thinkingLevels[1] === 'high', '模型与思考档按会话缓存')
  ok(map['session-a'].commands[0].name === 'deploy', '命令列表按会话缓存')

  map = updateSessionRuntime(map, runtimeB, { draft: 'B 的草稿' })
  ok(map['session-a'].draft === 'A 的草稿' && map['session-b'].draft === 'B 的草稿', 'A/B 草稿不会互相覆盖')
  const beforeDataReplacement = map['session-a']
  map = updateSessionRuntime(map, { ...runtimeA, generation: 1 }, { draft: '旧草稿', commands: [] })
  ok(map['session-a'] === beforeDataReplacement, '低代次能力/草稿写入同样被丢弃')

  let early = updateSessionRuntime({}, { sessionId: '', runId: 'r-early', generation: 1 }, {
    draft: '启动早期草稿',
    models: [modelA],
    thinkingLevels: ['medium'],
    commands: commandsA
  })
  early = migrateSessionRuntime(early, { sessionId: 'session-early', runId: 'r-early', generation: 1 })
  ok(early['session-early'].draft === '启动早期草稿', '启动早期草稿迁移到稳定 sessionId')
  ok(early['session-early'].models[0].id === 'model-a' && early['session-early'].commands[0].name === 'deploy', '启动早期能力列表随身份迁移')

  const beforeRunReplacement = map['session-a']
  map = reduceSessionRuntime(map, { sessionId: 'session-a', runId: 'r-old', generation: 1 }, {
    ch: 'msg-add',
    payload: { id: 'late-run', role: 'assistant', text: '旧运行实例迟到' }
  })
  ok(map['session-a'] === beforeRunReplacement, '不同 runId 的低代次事件同样被稳定 sessionId 闸门丢弃')

  /* 子代理列表是跨会话的全局运行资源，不能随会话快照投影或被切换清空。 */
  map = reduceSessionRuntime(map, runtimeA, {
    ch: 'subagent',
    payload: {
      id: 'sub-1',
      task: '全局子任务',
      cwd: 'C:/repo',
      isolation: 'worktree',
      status: 'running',
      startedAt: 1,
      transcript: [],
      review: 'none'
    }
  })
  ok(!Object.prototype.hasOwnProperty.call(map['session-a'], 'subagents'), '全局子代理事件不进入会话缓存')

  /*
   * 已回答的 UI 请求必须能**从缓存里**也被清掉（真实缺陷：`ask` 场景第 6 节）。
   * 只清顶层的话，下一次 `runners` 推送会把缓存投影回顶层 —— 面板复活。
   */
  /* 用**独立会话键**：前面几节已经把 session-a 的代次推高，复用它会被闸门丢掉 */
  const runtimeUi = { sessionId: 'session-ui', runId: 'r-ui', generation: 1 }
  map = reduceSessionRuntime(map, runtimeUi, {
    ch: 'ui-request',
    payload: { id: 'ui-1', method: 'select', title: '选一个', options: ['a', 'b'], createdAt: 1 }
  })
  ok(map['session-ui'].uiRequests.length === 1, 'ui-request 进了会话缓存')
  map = updateSessionRuntime(map, runtimeUi, { uiRequests: [] })
  ok(map['session-ui'].uiRequests.length === 0, 'uiRequests 可以由缓存补丁清空（防止投影时复活）')

  /* 清空后再来一条 `runners` 式的投影源：缓存里没有旧请求，就不会复活 */
  map = reduceSessionRuntime(map, runtimeUi, { ch: 'todos', payload: [] })
  ok(map['session-ui'].uiRequests.length === 0, '后续事件不会把已清的请求带回来')
  map = updateSessionRuntime(map, runtimeUi, { draft: '未发送的草稿' })
  const nextRuntime = { sessionId: 'next-segment', runId: 'next-runner', generation: 1 }
  const rebound = rebindSessionRuntime(map, runtimeUi.sessionId, nextRuntime, {
    sessionId: nextRuntime.sessionId, conversationId: runtimeUi.sessionId
  })
  ok(rebound['next-segment'].draft === '未发送的草稿', '交接保留未发送草稿')
  ok(rebound['next-segment'].messages === map['session-ui'].messages, '交接原位保留消息引用，不清空历史')
  ok(rebound['next-segment'].runtime.runId === 'next-runner', '界面保持逻辑会话，同时消息路由接到新实例')
  ok(rebound['next-segment'].session.conversationId === 'session-ui', '逻辑会话身份不会随着物理片段改变')

}
