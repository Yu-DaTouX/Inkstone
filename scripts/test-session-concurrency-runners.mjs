import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

export async function runSessionConcurrencyConflictTests(ok) {
  const { RunnerRegistry } = await compile('../src/main/runners.ts')

  const mkAgent = () => {
    const calls = { start: 0, stop: 0, switchSession: [], newSession: 0 }
    return {
      calls,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      bashRunning: false,
      wrote: false,
      queue: { steering: [], followUp: [] },
      hasWrittenThisRun() {
        return this.wrote
      },
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

  const cwdKey = (value) =>
    String(value ?? '')
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase()

  const runnersAt = (reg, cwd) => reg.statuses().filter((s) => cwdKey(s.cwd) === cwdKey(cwd))

  {
    const { reg, created } = make()
    const first = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/b.jsonl' })
    ok(r.ok === true && r.id !== first.id, '同一目录有会话在跑：共用目录并行，另开一个运行实例', JSON.stringify(r))
    ok(created.length === 2 && runnersAt(reg, 'C:/proj').length === 2, '同目录现在有两个运行实例', JSON.stringify(created))
    ok(busy.calls.stop === 0 && busy.state.isAgentRunning === true, '并行不停掉、不改动原会话')
  }

  {
    const { reg, created } = make()
    const first = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }
    busy.calls.switchSession.length = 0

    const r = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/b.jsonl', preview: true })
    ok(r.ok === true && r.deferred !== true && r.id !== first.id, '只翻历史：同目录忙碌时也直接打开，不再 deferred', JSON.stringify(r))
    ok(busy.calls.switchSession.length === 0 && busy.calls.stop === 0, '预览不动忙碌实例')
    ok(created.length === 2, '预览在额度内新开实例')

    const hit = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/a.jsonl', preview: true })
    ok(hit.ok === true && hit.via === 'hit' && hit.id === first.id, '切回正在跑的实例：直接命中', JSON.stringify(hit))
  }

  {
    const { reg, created } = make()
    const first = await reg.select({ cwd: 'C:/free', sessionFile: 'C:/free/a.jsonl' })
    const second = await reg.select({ cwd: 'C:/free', sessionFile: 'C:/free/b.jsonl' })
    ok(second.ok === true && second.via === 'reuse' && second.id === first.id, '同 cwd 没有忙碌实例时照常复用', JSON.stringify(second))
    ok(created.length === 1, '复用不新建实例')
  }

  for (const mark of ['pending', 'isStreaming', 'isCompacting']) {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/a.jsonl' })
    const agent = reg.agentOf(first.id)
    if (mark === 'pending') agent.pending = 1
    else agent.state = { ...agent.state, [mark]: true }
    const r = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/b.jsonl' })
    ok(r.ok === true && r.id !== first.id, `${mark} 的实例算忙：不被复用，另开实例`, JSON.stringify(r))
  }

  {
    const { reg } = make()
    const busyTarget = await reg.select({ cwd: 'C:/target', sessionFile: 'C:/target/a.jsonl' })
    const busyAgent = reg.agentOf(busyTarget.id)
    busyAgent.state = { ...busyAgent.state, isAgentRunning: true }
    const idle = await reg.select({ cwd: 'C:/other', sessionFile: 'C:/other/a.jsonl' })
    const r = await reg.select({ cwd: 'C:/target', sessionFile: 'C:/target/b.jsonl' })
    ok(r.ok === true && r.id !== busyTarget.id, '跨目录复用空闲实例进入有会话在跑的目录：照常打开', JSON.stringify(r))
    ok(busyAgent.calls.stop === 0, '忙碌会话不受影响')
    ok(reg.agentOf(idle.id) !== busyAgent, '空闲实例与忙碌实例不是同一个')
  }

  {
    let signature = 'plugins:none'
    const { reg, created } = make({ launchSignature: () => signature })
    const first = await reg.select({ cwd: 'C:/sig', sessionFile: 'C:/sig/a.jsonl' })
    const original = reg.agentOf(first.id)

    const same = await reg.select({ cwd: 'C:/sig' })
    ok(same.ok === true && same.via === 'reuse' && created.length === 1, '扩展与技能未变时原地复用空闲实例', JSON.stringify(same))
    ok(reg.agentOf(first.id) === original && original.calls.newSession === 1, '原进程直接开新会话')

    signature = 'plugins:comfyui'
    const changed = await reg.select({ cwd: 'C:/sig' })
    const replacement = reg.agentOf(first.id)
    ok(changed.ok === true && changed.via === 'reuse' && created.length === 2, '扩展或技能变化后换新进程承接新会话', JSON.stringify(changed))
    ok(replacement !== original && replacement.calls.start === 1 && replacement.calls.newSession === 1, '新进程启动并开新会话')
    ok(original.calls.stop === 1, '旧进程被停掉')

    const again = await reg.select({ cwd: 'C:/sig' })
    ok(again.ok === true && created.length === 2 && reg.agentOf(first.id) === replacement, '换过的新进程之后照常复用', JSON.stringify(again))
  }
}

export async function runSessionConcurrencySendGuardTests(ok) {
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
    ok(g.ok === true, '自己空闲、同 cwd 另有忙碌实例：发送前复核也放行', JSON.stringify(g))
    ok(first.calls.stop === 0, '放行时没有停掉忙碌会话')
    ok(reg.size === 2, '放行后实例数不变')
    ok(first.state.isAgentRunning === true, '放行不改动忙碌会话状态')
    ok(reg.activeRunnerId === firstId, '放行不改动当前视图')
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
    ok(g.ok === true, '大小写 / 斜杠 / 末尾分隔符差异下发送前复核也放行', JSON.stringify(g))
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
  const report = (condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  }
  await runSessionConcurrencyConflictTests(report)
  await runSessionConcurrencySendGuardTests(report)
  console.log(`Session concurrency runner tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
