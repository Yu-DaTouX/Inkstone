import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runSessionConcurrencySendGuardTests(ok) {
  const compile = async (entry) => {
    const compiled = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false
    })
    return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  }

  const { RunnerRegistry } = await compile('../src/main/runners.ts')
  const { guardSameCwdExecute, SAME_CWD_BUSY_ERROR } = await compile('../src/main/session-send-guard.ts')

  const mkAgent = () => {
    const calls = { start: 0, stop: 0, switchSession: [], newSession: 0 }
    return {
      calls,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      bashRunning: false,
      queue: { steering: [], followUp: [] },
      getState() {
        return this.state
      },
      getPendingUiCount() {
        return this.pending
      },
      hasRunningBash() {
        return this.bashRunning
      },
      getConn() {
        return { state: 'ready', detail: '' }
      },
      setRunnerGeneration(generation) {
        this.capabilityGeneration = generation
      },
      async start() {
        calls.start++
        return { ok: true }
      },
      async stop() {
        calls.stop++
      },
      async switchSession(p) {
        calls.switchSession.push(p)
        this.state = { ...this.state, sessionFile: p }
        return { ok: true }
      },
      async newSession() {
        calls.newSession++
        this.state = { ...this.state, sessionFile: undefined }
        return { ok: true }
      },
      queueSnapshot() {
        return structuredClone(this.queue)
      },
      async restoreQueueSnapshot(snapshot) {
        this.queue = structuredClone(snapshot)
        return { ok: true }
      }
    }
  }

  const make = (options = {}) => {
    const agents = []
    const created = []
    const reg = new RunnerRegistry({
      limit: 3,
      createAgent: (id, cwd, generation) => {
        const agent = mkAgent()
        agent.id = id
        agent.state = { ...agent.state, cwd }
        if (generation !== undefined) agent.capabilityGeneration = generation
        agents.push(agent)
        created.push({ id, cwd })
        return agent
      },
      ...options
    })
    return { reg, agents, created }
  }

  const twoIdleSameCwd = async (reg, a = 'C:/proj', b = 'C:/proj') => {
    const first = await reg.select({ cwd: a, sessionFile: 'C:/proj/a.jsonl' })
    const second = await reg.select({ cwd: b, sessionFile: 'C:/proj/b.jsonl', activate: false })
    return { first: reg.agentOf(first.id), second: reg.agentOf(second.id), firstId: first.id, secondId: second.id }
  }

  const busy = (agent, flag = true) => {
    agent.state = { ...agent.state, isAgentRunning: flag }
  }

  {
    const { reg, created } = make()
    const { first, second, firstId, secondId } = await twoIdleSameCwd(reg)
    ok(reg.size === 2, '前置：同 cwd 已有两个空闲实例', JSON.stringify(created))
    busy(first)

    const g = reg.guardExecute(secondId)
    ok(g.ok === false, '自己空闲、同 cwd 另有忙碌实例：发送前复核拒绝', JSON.stringify(g))
    ok(g.error === SAME_CWD_BUSY_ERROR, '拒绝用统一的同 cwd 冲突文案', g.error)
    ok(/请等它跑完或停止它/.test(g.error ?? ''), '拒绝信息给出等待 / 停止原任务的提示', g.error)
    ok(first.calls.stop === 0, '拒绝时没有停掉忙碌会话')
    ok(reg.size === 2, '拒绝后实例数不变（不另起写者）')
    ok(first.state.isAgentRunning === true, '拒绝不改动忙碌会话状态')
    ok(reg.activeRunnerId === firstId, '拒绝不改动当前视图')
  }

  {
    const { reg } = make()
    const { first, second, firstId, secondId } = await twoIdleSameCwd(reg)
    busy(first)
    busy(second)

    ok(reg.guardExecute(firstId).ok === true, '忙碌实例对自己的插话 / 排队放行（不受同 cwd 的别人影响）')
    ok(reg.guardExecute(secondId).ok === true, '另一条忙碌实例对自己的插话 / 排队也放行')
    ok(second.calls.stop === 0, '放行不动别的实例')
  }

  {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/free', sessionFile: 'C:/free/a.jsonl' })
    ok(reg.guardExecute(first.id).ok === true, '同 cwd 没有别的忙碌实例：放行（不误报）')

    const { reg: reg2 } = make()
    const busyA = await reg2.select({ cwd: 'C:/p1', sessionFile: 'C:/p1/a.jsonl' })
    busy(reg2.agentOf(busyA.id))
    const idleB = await reg2.select({ cwd: 'C:/p2', sessionFile: 'C:/p2/a.jsonl' })
    ok(reg2.guardExecute(idleB.id).ok === true, '不同 cwd 上的忙碌实例不影响：放行')
  }

  {
    const { reg } = make()
    ok(reg.guardExecute('missing').ok === true, '目标实例不存在：放行')
    let seenLookup = false
    const lookup = () => {
      seenLookup = true
      return true
    }
    ok(guardSameCwdExecute(null, lookup).ok === true, 'helper：input 为 null 放行')
    ok(guardSameCwdExecute({ runnerId: '', cwd: 'C:/x', selfBusy: false }, lookup).ok === true, 'helper：无 runnerId 放行')
    ok(guardSameCwdExecute({ runnerId: 'r1', cwd: '', selfBusy: false }, lookup).ok === true, 'helper：空 cwd 放行')
    ok(seenLookup === false, 'helper：放行前不查忙碌集合')
  }

  {
    const { reg } = make()
    const { firstId, secondId, first } = await twoIdleSameCwd(reg, 'C:/Proj/', 'c:\\proj')
    busy(first)
    const g = reg.guardExecute(secondId)
    ok(g.ok === false, '大小写 / 斜杠 / 末尾分隔符差异不能绕过发送前复核', JSON.stringify(g))
    ok(reg.guardExecute(firstId).ok === true, '规范化下发起者自己仍放行')
  }

  {
    const { reg } = make()
    const { first, secondId } = await twoIdleSameCwd(reg)
    busy(first)
    const before = JSON.stringify(first.state)
    const stoppedBefore = first.calls.stop
    for (let i = 0; i < 3; i++) reg.guardExecute(secondId)
    ok(first.calls.stop === stoppedBefore, '多次复核都不停别的会话')
    ok(JSON.stringify(first.state) === before, '多次复核不改动忙碌会话状态')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runSessionConcurrencySendGuardTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Session concurrency send-guard tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
