/**
 * 会话后台工作调度服务（src/main/session-work-scheduler.ts）的单测。
 *
 * 用假依赖驱动：不起 pi、不碰窗口，只验调度规则本身 ——
 *   · 同一会话串行、不同会话互不阻塞；
 *   · 忙碌 / 交接中 / 已安排错误重试时「现在不做决定」；
 *   · 优先级：重复拦下补记 → 交接 → 普通续跑；
 *   · 模型报错 → 按计划退避后写续行快照；用户发言（reset）撤掉待发的续行；
 *   · 学习练习正等作答时不写快照，只提示。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeDeps(overrides = {}) {
  const log = []
  const states = new Map()
  const deps = {
    log,
    states,
    stateOf: (id) => states.get(id) ?? null,
    hasHandoffOperation: () => false,
    handoffPending: () => false,
    consumeRepeatBlocks: async (id) => { log.push(`repeat:${id}`) },
    tryArmHandoff: async (id) => { log.push(`handoff:${id}`); return false },
    maybeArmGoalContinue: async (id) => { log.push(`goal:${id}`) },
    workModeKeyFor: (id) => `key-${id}`,
    autoContinueLimit: 3,
    studyGateBlocks: async () => false,
    writeRetrySnapshot: async (id, snapshot) => { log.push(`snapshot:${id}:${snapshot.kind}`) },
    notify: (id, message, type) => { log.push(`notify:${id}:${type}`) },
    autoContinues: {
      load: async () => undefined,
      reset: async (key) => { log.push(`reset:${key}`) },
      noteFailure: async () => ({
        plan: { action: 'retry', delayMs: 30, attempt: 1, error: 'boom', note: 'retrying' },
        duplicate: false
      })
    },
    ...overrides
  }
  return deps
}

export async function runSessionWorkSchedulerTests(ok, { createSessionWorkScheduler }) {
  /* ---- 1. 空闲时按优先级：重复拦下 → 交接 → 续跑 ---- */
  {
    const deps = fakeDeps()
    deps.states.set('a', { isAgentRunning: false, isStreaming: false })
    const sw = createSessionWorkScheduler(deps)
    await sw.schedule('a', 'settled')
    ok(deps.log.join(',') === 'repeat:a,handoff:a,goal:a', `空闲时依次：重复拦下 → 交接 → 续跑（${deps.log.join(',')}）`)
  }

  /* ---- 2. 交接成功就不再续跑 ---- */
  {
    const deps = fakeDeps({ tryArmHandoff: async (id) => { deps.log.push(`handoff:${id}`); return true } })
    deps.states.set('a', { isAgentRunning: false })
    const sw = createSessionWorkScheduler(deps)
    await sw.schedule('a', 'settled')
    ok(!deps.log.includes('goal:a'), '发起交接后不再安排普通续跑')
  }

  /* ---- 3. 忙碌 / 交接中 / 实例不存在：不做决定 ---- */
  {
    const deps = fakeDeps()
    deps.states.set('busy', { isAgentRunning: true })
    deps.states.set('streaming', { isAgentRunning: false, isStreaming: true })
    const sw = createSessionWorkScheduler(deps)
    await sw.schedule('busy', 'settled')
    await sw.schedule('streaming', 'settled')
    await sw.schedule('missing', 'settled')
    ok(deps.log.length === 0, `忙碌 / 流式 / 实例不存在时什么都不做（${deps.log.join(',') || '无'}）`)

    const handoff = fakeDeps({ hasHandoffOperation: () => true })
    handoff.states.set('h', { isAgentRunning: false })
    await createSessionWorkScheduler(handoff).schedule('h', 'settled')
    ok(handoff.log.length === 0, '交接进行中不做决定')

    const cleared = fakeDeps({ handoffPending: () => true })
    cleared.states.set('c', { isAgentRunning: false })
    await createSessionWorkScheduler(cleared).schedule('c', 'settled')
    ok(cleared.log.join(',') === 'repeat:c', '重复拦下之后交接现场仍在：不再发起交接或续跑')
  }

  /* ---- 4. 同一会话串行，不同会话互不阻塞 ---- */
  {
    let release
    const gate = new Promise((r) => { release = r })
    const deps = fakeDeps({
      consumeRepeatBlocks: async (id) => {
        deps.log.push(`repeat:${id}:start`)
        if (id === 'a') await gate
        deps.log.push(`repeat:${id}:end`)
      },
      tryArmHandoff: async () => true
    })
    deps.states.set('a', { isAgentRunning: false })
    deps.states.set('b', { isAgentRunning: false })
    const sw = createSessionWorkScheduler(deps)
    const first = sw.schedule('a', 'one')
    const second = sw.schedule('a', 'two')
    await sw.schedule('b', 'other')
    ok(deps.log.includes('repeat:b:end') && !deps.log.includes('repeat:a:end'), '会话 b 不被会话 a 的长任务阻塞')
    ok(deps.log.filter((line) => line === 'repeat:a:start').length === 1, '同一会话的第二次调度排在第一次之后')
    release()
    await Promise.all([first, second])
    ok(deps.log.filter((line) => line === 'repeat:a:start').length === 2, '第一次结束后第二次才开始')
  }

  /* ---- 5. 模型报错 → 退避后写续行快照；等待期间不做其它决定 ---- */
  {
    const deps = fakeDeps()
    deps.states.set('e', { isAgentRunning: false })
    const sw = createSessionWorkScheduler(deps)
    sw.observePush('e', { ch: 'agent-error', payload: { text: 'boom', source: 'stop' } })
    await sleep(5)
    ok(sw.hasPendingAutoContinue('e'), '模型报错后安排了一次自动继续')
    ok(deps.log.includes('notify:e:warning'), '安排自动继续时提示用户')
    await sw.schedule('e', 'settled')
    ok(!deps.log.includes('goal:e'), '已安排错误重试时不再安排普通续跑')
    await sleep(60)
    ok(deps.log.includes('snapshot:e:retry'), '退避到点写入续行快照')
    ok(!sw.hasPendingAutoContinue('e'), '写完快照后不再挂着定时器')
  }

  /* ---- 6. 用户发言 / 一轮成功 → 撤掉待发的自动继续并归零 ---- */
  {
    const deps = fakeDeps()
    const sw = createSessionWorkScheduler(deps)
    sw.observePush('r', { ch: 'agent-error', payload: { text: 'boom', source: 'stop' } })
    await sleep(5)
    sw.observePush('r', { ch: 'msg-update', payload: { patch: { role: 'assistant', text: 'ok' } } })
    await sleep(60)
    ok(!deps.log.includes('snapshot:r:retry'), '一轮真的产出后，待发的自动继续被撤掉')
    ok(deps.log.includes('reset:key-r'), '失败计数归零')
  }

  /* ---- 7. 达到上限 → 只提示不安排 ---- */
  {
    const deps = fakeDeps()
    deps.autoContinues.noteFailure = async () => ({
      plan: { action: 'stop', reason: 'limit', note: 'stopped' },
      duplicate: false
    })
    const sw = createSessionWorkScheduler(deps)
    sw.observePush('s', { ch: 'agent-error', payload: { text: 'boom', source: 'stop' } })
    await sleep(5)
    ok(!sw.hasPendingAutoContinue('s') && deps.log.includes('notify:s:error'), '达到上限时只以错误提示告知，不再安排')
  }

  /* ---- 8. 学习练习等作答：到点也不写快照 ---- */
  {
    let waiting = false
    const deps = fakeDeps({ studyGateBlocks: async () => waiting })
    const sw = createSessionWorkScheduler(deps)
    sw.observePush('l', { ch: 'agent-error', payload: { text: 'boom', source: 'stop' } })
    await sleep(5)
    waiting = true
    await sleep(60)
    ok(!deps.log.includes('snapshot:l:retry') && deps.log.includes('notify:l:info'), '学习正等作答时不叫醒模型，只提示')
  }

  /* ---- 9. 回合结束的 state 推送触发调度 ---- */
  {
    const deps = fakeDeps()
    deps.states.set('p', { isAgentRunning: false })
    const sw = createSessionWorkScheduler(deps)
    sw.observePush('p', { ch: 'state', payload: { isAgentRunning: false } })
    await sleep(10)
    ok(deps.log.includes('goal:p'), '回合结束的 state 推送会排一次后台工作')
    const busy = fakeDeps()
    const sw2 = createSessionWorkScheduler(busy)
    sw2.observePush('q', { ch: 'state', payload: { isAgentRunning: true } })
    await sleep(10)
    ok(busy.log.length === 0, '回合进行中的 state 推送不触发调度')
  }
}
