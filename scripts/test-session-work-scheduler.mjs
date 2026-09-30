/** Settled observations must never create host continuation prompts. */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function fakeDeps(overrides = {}) {
  const log = []
  const states = new Map()
  return {
    log, states, stateOf: id => states.get(id) ?? null,
    hasHandoffOperation: () => false, handoffPending: () => false,
    consumeRepeatBlocks: async id => { log.push(`repeat:${id}`) },
    tryArmHandoff: async id => { log.push(`handoff:${id}`); return true },
    maybeArmGoalContinue: async id => { log.push(`goal:${id}`) },
    workModeKeyFor: id => `key-${id}`, autoContinueLimit: 3,
    writeRetrySnapshot: async id => { log.push(`snapshot:${id}`) },
    notify: id => { log.push(`notify:${id}`) },
    autoContinues: { reset: async () => { log.push('reset') }, noteFailure: async () => { log.push('failure'); return { plan: { action: 'retry', delayMs: 1 } } } },
    ...overrides
  }
}
export async function runSessionWorkSchedulerTests(ok, { createSessionWorkScheduler }) {
  {
    const deps = fakeDeps()
    deps.states.set('a', {})
    await createSessionWorkScheduler(deps).schedule('a', 'settled')
    ok(deps.log.join(',') === 'repeat:a', '空闲收尾只补记观察，不安排交接或目标续跑')
  }
  {
    const deps = fakeDeps()
    for (const key of ['isAgentRunning', 'isStreaming', 'isCompacting']) deps.states.set(key, { [key]: true })
    const scheduler = createSessionWorkScheduler(deps)
    for (const id of [...deps.states.keys(), 'missing']) await scheduler.schedule(id, 'settled')
    ok(deps.log.length === 0, '运行、流式、原生压缩期间和缺失会话不补记')
    deps.states.set('h', {})
    deps.hasHandoffOperation = () => true
    await scheduler.schedule('h', 'settled')
    ok(deps.log.length === 0, '正在进行的显式交接不被后台补记打断')
  }
  {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const deps = fakeDeps({ consumeRepeatBlocks: async id => {
      deps.log.push(`${id}:start`)
      if (id === 'a') await gate
      deps.log.push(`${id}:end`)
    } })
    deps.states.set('a', {}); deps.states.set('b', {})
    const scheduler = createSessionWorkScheduler(deps)
    const first = scheduler.schedule('a', 'first')
    const second = scheduler.schedule('a', 'second')
    await scheduler.schedule('b', 'independent')
    ok(deps.log.includes('b:end') && !deps.log.includes('a:end'), '不同会话的观察互不阻塞')
    ok(deps.log.filter(item => item === 'a:start').length === 1, '同一会话串行补记')
    release(); await Promise.all([first, second])
    ok(deps.log.filter(item => item === 'a:end').length === 2, '串行链释放后完成全部补记')
  }
  {
    const deps = fakeDeps()
    const scheduler = createSessionWorkScheduler(deps)
    scheduler.observePush('e', { ch: 'agent-error', payload: { text: 'fixture failure' } })
    scheduler.observePush('e', { ch: 'msg-update', payload: { patch: { role: 'assistant', text: 'fixture output' } } })
    await scheduler.resetAutoContinue('e'); scheduler.cancelAutoContinue('e')
    await sleep(40)
    ok(!scheduler.hasPendingAutoContinue('e') && deps.log.length === 0, '模型错误、输出和旧重置接口不生成重试或续行快照')
  }
  {
    const deps = fakeDeps()
    deps.states.set('p', {})
    const scheduler = createSessionWorkScheduler(deps)
    scheduler.observePush('p', { ch: 'state', payload: { isAgentRunning: false } })
    await sleep(5)
    ok(deps.log.length === 0, '打开旧会话时不自动产生后台动作')
    scheduler.observePush('p', { ch: 'state', payload: { isAgentRunning: true } })
    scheduler.observePush('p', { ch: 'state', payload: { isAgentRunning: false } })
    await sleep(5)
    ok(deps.log.join(',') === 'repeat:p', '原生回合结束后只记录观察')
  }
}
