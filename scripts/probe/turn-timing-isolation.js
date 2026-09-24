/*
 * H-6b：并发会话的回合计时归属（cost 0，本机 OpenAI 兼容 fixture）。
 *
 * A、B 使用不同 cwd。通过应用暴露的 selectSession / send IPC 让 A、B 两个
 * 主进程 runner 同时工作；fixture 对 B 故意等待更久，从读回时长识别计时归属。
 * peekSession 验消息挂点；Electron 退出后由 afterExit 验独立计时文件与消息 id。
 */
;(async () => {
  const out = []
  const ok = (condition, label) => {
    out.push((condition ? '  ✓ ' : '  ✗ ') + label)
    return !!condition
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = window.__yanStore
  const state = () => store.getState()
  const norm = (path) => String(path ?? '').replace(/[\\/]+/g, '/').toLowerCase()
  const waitFor = async (fn, timeoutMs = 20000, stepMs = 250) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await sleep(stepMs)
    }
    return null
  }
  const fixtureModel = 'yantimingfixture/turn-timing-isolation-fixture'
  const [provider, modelId] = fixtureModel.split('/')
  const summaryFor = (path) => (state().sessions ?? []).find((session) => session.path === path)
  const runnersNow = () => window.yan.runnerStatuses()
  const runnerFor = async (path, predicate = () => true, timeoutMs = 12000) =>
    waitFor(async () => {
      const runners = await runnersNow()
      const runner = runners.find((item) => norm(item.sessionFile) === norm(path))
      return runner && predicate(runner) ? runner : null
    }, timeoutMs)

  try {
    localStorage.setItem('yan.onboarded', '1')
    const ready = await waitFor(
      () => (state().conn === 'ready' && (state().sessions ?? []).length > 0 && state().session?.sessionFile ? true : null),
      45000,
      300
    )
    ok(!!ready, 'pi RPC 与初始会话就绪')
    if (!ready) return out.join('\n')
    await state().refreshSessions?.()
    await state().reloadModels?.()

    const sessions = state().sessions ?? []
    const A = sessions.find((session) => String(session.path).includes('yan-ab-a-'))
    const B = sessions.find((session) => String(session.path).includes('yan-ab-b-'))
    ok(!!A && !!B, `找到两个隔离会话（A=${!!A} B=${!!B}）`)
    if (!A || !B) return out.join('\n')
    ok(A.cwd !== B.cwd, 'A、B 的 cwd 不同，允许并行')
    out.push(`  A=${A.path}`)
    out.push(`  B=${B.path}`)

    const available = (state().models ?? []).some((model) => `${model.provider}/${model.id}` === fixtureModel)
    ok(available, `本机 fixture 模型已载入（${fixtureModel}）`)
    if (!available) return out.join('\n')

    /* ---- A 启动后通过主进程 IPC 选中 B，必须新建并行 runner ---- */
    await state().switchSession(A.path)
    const selectedA = await waitFor(
      () => norm(state().session?.sessionFile) === norm(A.path) ? true : null,
      20000
    )
    ok(!!selectedA, 'renderer store.switchSession 选择 A，并投影到 A 的 sessionFile')
    if (!selectedA) return out.join('\n')
    await state().setWorkMode('standard')
    const modelA = await window.yan.setModel(provider, modelId)
    ok(modelA?.ok === true, 'A 已切到成本为零的本机模型')
    if (modelA?.ok !== true) return out.join('\n')

    const sendA = await window.yan.send('YAN_TIMING_ISOLATION_A：请只回复 TURN_TIMING_ISOLATION_REPLY_A。')
    ok(sendA?.ok === true, 'A 的测试消息已提交')
    const runningA = await runnerFor(A.path, (runner) => runner.running)
    ok(!!runningA, 'A 的真实主进程 runner 已运行')
    if (!runningA) return out.join('\n')
    await sleep(1200)

    await state().switchSession(B.path)
    const selectedB = await waitFor(
      () => norm(state().session?.sessionFile) === norm(B.path) ? true : null,
      20000
    )
    ok(!!selectedB, 'A 在途时 renderer store.switchSession 选择 B，并投影到 B 的 sessionFile')
    if (!selectedB) {
      out.push(`  A 运行时的 runner 快照=${JSON.stringify(await runnersNow())}`)
      return out.join('\n')
    }
    const activeB = await runnerFor(B.path, (runner) => runner.isActive)
    ok(!!activeB, 'B 作为独立 runner 成为主进程活动会话')
    const activeBId = activeB?.runId ?? activeB?.id
    ok(state().activeRunnerId === activeBId, `renderer store 活动实例与 B 对齐（${state().activeRunnerId ?? '缺失'}）`)
    const modelB = await window.yan.setModel(provider, modelId)
    ok(modelB?.ok === true, 'B 已切到成本为零的本机模型')
    if (modelB?.ok !== true) return out.join('\n')

    const sendB = await window.yan.send('YAN_TIMING_ISOLATION_B：请只回复 TURN_TIMING_ISOLATION_REPLY_B。')
    ok(sendB?.ok === true, 'B 的测试消息已提交')
    const runningB = await runnerFor(B.path, (runner) => runner.running)
    ok(!!runningB, 'B 的真实主进程 runner 已运行')
    const concurrent = await waitFor(async () => {
      const runners = await runnersNow()
      const a = runners.find((runner) => norm(runner.sessionFile) === norm(A.path))
      const b = runners.find((runner) => norm(runner.sessionFile) === norm(B.path))
      return a?.running && b?.running ? { a, b } : null
    }, 10000)
    ok(!!concurrent, 'A、B 两个 runner 同时在途')

    const bothIdle = await waitFor(async () => {
      const runners = await runnersNow()
      return !runners.some(
        (runner) => [A.path, B.path].some((path) => norm(runner.sessionFile) === norm(path) && runner.running)
      )
        ? true
        : null
    }, 60000, 300)
    ok(!!bothIdle, 'A、B 两条回合都已结束')
    if (!bothIdle) return out.join('\n')
    let projectionStable = true
    const stableUntil = Date.now() + 1500
    while (Date.now() < stableUntil) {
      if (
        norm(state().session?.sessionFile) !== norm(B.path) ||
        state().activeRunnerId !== activeBId
      ) {
        projectionStable = false
        break
      }
      await sleep(100)
    }
    ok(projectionStable, 'A 的迟到推送没有把 renderer store 会话 / 活动实例切回 A')

    const inspectTurn = async (session, tag) => {
      const marker = `YAN_TIMING_ISOLATION_${tag.toUpperCase()}`
      const expectedReply = `TURN_TIMING_ISOLATION_REPLY_${tag.toUpperCase()}`
      let messages = []
      let user = null
      let following = []
      let timed = []
      await waitFor(async () => {
        const peek = await window.yan.peekSession(session.path)
        messages = peek?.messages ?? []
        const userIndex = messages.findIndex((message) => message.role === 'user' && String(message.text ?? '').includes(marker))
        user = userIndex >= 0 ? messages[userIndex] : null
        following = userIndex >= 0 ? messages.slice(userIndex + 1).filter((message) => message.role === 'assistant') : []
        timed = following.filter((message) => message.turnTiming)
        return user && following.some((message) => String(message.text ?? '').includes(expectedReply)) && timed.length
          ? true
          : null
      }, 12000, 300)
      ok(!!user, `${tag.toUpperCase()} 的独有用户消息已从 JSONL 读回`)
      ok(following.some((message) => String(message.text ?? '').includes(expectedReply)), `${tag.toUpperCase()} 收到对应 fixture 回复`)
      ok(timed.length === 1, `${tag.toUpperCase()} 只在自己的回合读到一条计时（${timed.length}）`)
      ok(!!user && timed[0]?.turnTiming?.logicalTurnId === user.id, `${tag.toUpperCase()} 计时锚定自己的用户消息（${timed[0]?.turnTiming?.logicalTurnId ?? '缺失'}）`)
      out.push(`  ${tag.toUpperCase()} 即时读回终止状态=${timed[0]?.turnTiming?.terminalReason ?? '缺失'}（退出后将核对最终磁盘快照）`)
      return {
        sessionFile: session.path,
        userId: user?.id ?? '',
        assistantIds: following.map((message) => message.id),
        timedAssistantIds: timed.map((message) => message.id),
        elapsedMs: timed[0]?.turnTiming?.elapsedMs ?? 0
      }
    }

    const a = await inspectTurn(A, 'a')
    const b = await inspectTurn(B, 'b')
    ok(Number(b.elapsedMs) > Number(a.elapsedMs) + 2500, `不同 provider 等待时长落在各自会话（A=${a.elapsedMs}ms，B=${b.elapsedMs}ms）`)
    out.push(`  turn-timing-isolation.snapshot=${JSON.stringify({ a, b })}`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
