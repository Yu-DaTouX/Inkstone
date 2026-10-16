import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runSessionConcurrencyConflictTests(ok) {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../src/main/runners.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const { RunnerRegistry } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  )

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
    busy.wrote = false
    busy.bashRunning = false

    const r = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/b.jsonl' })
    ok(r.ok === false, '同一 cwd 上「还没写过文件」的忙碌会话也算冲突（不能先放进来、随后两边同时写）', JSON.stringify(r))
    ok(reg.size === 1 && created.length === 1, '拒绝后没有在同一物理 cwd 起第二个运行实例')
    ok(runnersAt(reg, 'C:/proj').length === 1, '同一物理 cwd 始终只有一个运行实例')
    ok(busy.calls.stop === 0, '拒绝时没有停掉原会话')
    ok(/请等它跑完或停止它/.test(r.error ?? ''), '拒绝信息给出等待 / 停止原任务的提示', r.error)
  }

  {
    const seen = []
    const { reg, created } = make({
      resolveCwdConflict: async (target) => {
        seen.push(target.cwd)
        return { cwd: 'C:/proj-wt' }
      }
    })
    const first = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }
    busy.wrote = false

    const r = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/b.jsonl' })
    ok(r.ok === true && r.via === 'new', 'Git 隔离成功：换到隔离工作树继续', JSON.stringify(r))
    ok(seen.length === 1 && seen[0] === 'C:/proj', '宿主收到的是原 cwd 与完整目标', JSON.stringify(seen))
    ok(created.some((x) => x.cwd === 'C:/proj-wt'), '新实例起在隔离目录里')
    ok(runnersAt(reg, 'C:/proj').length === 1, '主目录仍只有原来的忙碌实例')
    ok(busy.calls.stop === 0, '隔离没有停掉原本那个会话')
  }

  {
    const { reg, created } = make({ resolveCwdConflict: async () => ({ reason: '这个目录不是 Git 仓库' }) })
    const first = await reg.select({ cwd: 'C:/plain', sessionFile: 'C:/plain/a.jsonl' })
    reg.agentOf(first.id).state = { ...reg.agentOf(first.id).state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/plain', sessionFile: 'C:/plain/b.jsonl' })
    ok(r.ok === false, '非 Git：隔离不了时明确拒绝激活', JSON.stringify(r))
    ok(/这个目录不是 Git 仓库/.test(r.error ?? ''), '拒绝信息带上隔离失败原因', r.error)
    ok(/请等它跑完或停止它/.test(r.error ?? ''), '拒绝信息提示等待 / 停止原任务', r.error)
    ok(created.length === 1 && runnersAt(reg, 'C:/plain').length === 1, '非 Git 拒绝后不新增实例')
  }

  {
    const { reg, created } = make({ resolveCwdConflict: async () => ({ cwd: 'C:/same/' }) })
    const first = await reg.select({ cwd: 'C:/same', sessionFile: 'C:/same/a.jsonl' })
    reg.agentOf(first.id).state = { ...reg.agentOf(first.id).state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/same', sessionFile: 'C:/same/b.jsonl' })
    ok(r.ok === false, '返回同一个目录 = 没隔离成：仍然拒绝', JSON.stringify(r))
    ok(created.length === 1, '拒绝后不新增实例')
  }

  {
    const { reg, created } = make({ resolveCwdConflict: async () => null })
    const first = await reg.select({ cwd: 'C:/bg', sessionFile: 'C:/bg/a.jsonl' })
    reg.agentOf(first.id).state = { ...reg.agentOf(first.id).state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/bg', sessionFile: 'C:/bg/b.jsonl' })
    ok(r.ok === false, '宿主不处理（null）时失败关闭，不静默放行', JSON.stringify(r))
    ok(created.length === 1, '失败关闭后不新增实例')
  }

  {
    const seen = []
    const { reg, created } = make({
      resolveCwdConflict: async (target) => {
        seen.push(target.cwd)
        return { cwd: 'C:/iso/never' }
      }
    })
    const first = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }
    busy.calls.switchSession.length = 0

    const r = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/b.jsonl', preview: true })
    ok(r.ok === true && r.deferred === true, '只翻历史：冲突时 deferred', JSON.stringify(r))
    ok(seen.length === 0, '预览不触发隔离（不建工作树）')
    ok(created.length === 1, '预览不新建实例')
    ok(busy.calls.switchSession.length === 0, '预览不动忙碌实例')
    ok(busy.calls.stop === 0, '预览不停实例')

    const hit = await reg.select({ cwd: 'C:/hist', sessionFile: 'C:/hist/a.jsonl', preview: true })
    ok(hit.ok === true && hit.via === 'hit' && hit.deferred !== true, '预览命中已有实例时正常切视图', JSON.stringify(hit))
    ok(seen.length === 0, '命中路径不触发隔离')
  }

  {
    const seen = []
    const { reg } = make({
      resolveCwdConflict: async (target) => {
        seen.push(target.cwd)
        return { cwd: 'C:/iso/never' }
      }
    })
    const first = await reg.select({ cwd: 'C:/cur', sessionFile: 'C:/cur/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/cur', sessionFile: 'C:/cur/a.jsonl' })
    ok(r.ok === true && r.via === 'hit' && r.id === first.id, '切回正在跑的实例：直接命中', JSON.stringify(r))
    ok(seen.length === 0, '命中已有实例不触发隔离')
    ok(busy.calls.stop === 0, '命中路径不停实例')
  }

  {
    const { reg, created } = make()
    const first = await reg.select({ cwd: 'C:/free', sessionFile: 'C:/free/a.jsonl' })
    const second = await reg.select({ cwd: 'C:/free', sessionFile: 'C:/free/b.jsonl' })
    ok(second.ok === true && second.via === 'reuse' && second.id === first.id, '同 cwd 没有忙碌实例时照常复用（不误报冲突）', JSON.stringify(second))
    ok(created.length === 1, '复用不新建实例')
  }

  {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/ask', sessionFile: 'C:/ask/a.jsonl' })
    reg.agentOf(first.id).pending = 1
    const r = await reg.select({ cwd: 'C:/ask', sessionFile: 'C:/ask/b.jsonl' })
    ok(r.ok === false, '等用户回答（pending UI）也算忙：判定为冲突', JSON.stringify(r))
  }
  for (const flag of ['isStreaming', 'isCompacting']) {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/a.jsonl' })
    reg.agentOf(first.id).state = { ...reg.agentOf(first.id).state, [flag]: true }
    const r = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/b.jsonl' })
    ok(r.ok === false, `${flag} 也算忙：判定为冲突`, JSON.stringify(r))
  }

  {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/Proj/', sessionFile: 'C:/Proj/a.jsonl' })
    reg.agentOf(first.id).state = { ...reg.agentOf(first.id).state, isAgentRunning: true }
    const r = await reg.select({ cwd: 'c:\\proj', sessionFile: 'C:/proj/b.jsonl' })
    ok(r.ok === false, '大小写 / 斜杠 / 末尾分隔符差异不能绕过冲突检查', JSON.stringify(r))
  }

  {
    const { reg, created } = make()
    const busyTarget = await reg.select({ cwd: 'C:/target', sessionFile: 'C:/target/a.jsonl' })
    const busyAgent = reg.agentOf(busyTarget.id)
    busyAgent.state = { ...busyAgent.state, isAgentRunning: true }
    const idle = await reg.select({ cwd: 'C:/other', sessionFile: 'C:/other/a.jsonl' })
    ok(reg.agentOf(idle.id) !== busyAgent, '前置：空闲实例与忙碌实例是两个运行实例')

    const r = await reg.select({ cwd: 'C:/target', sessionFile: 'C:/target/b.jsonl' })
    ok(r.ok === false, '跨 cwd 复用空闲实例也不能被带进有忙碌会话的目录', JSON.stringify(r))
    ok(reg.activeRunnerId === idle.id, '拒绝后当前视图仍是那个空闲实例')
    ok(reg.agentOf(idle.id)?.calls.stop === 0, '拒绝时没有停掉空闲实例')
    ok(runnersAt(reg, 'C:/target').length === 1, 'C:/target 上仍然只有一个运行实例')
    ok(created.filter((x) => cwdKey(x.cwd) === cwdKey('C:/target')).length === 1, '没有为 C:/target 新建第二个实例')
  }

  {
    const { reg } = make()
    const first = await reg.select({ cwd: 'C:/later', sessionFile: 'C:/later/a.jsonl' })
    const busy = reg.agentOf(first.id)
    busy.state = { ...busy.state, isAgentRunning: true }
    const blocked = await reg.select({ cwd: 'C:/later', sessionFile: 'C:/later/b.jsonl' })
    ok(blocked.ok === false, '忙碌期间拒绝')
    busy.state = { ...busy.state, isAgentRunning: false }
    const allowed = await reg.select({ cwd: 'C:/later', sessionFile: 'C:/later/b.jsonl' })
    ok(allowed.ok === true, '原任务跑完后同一 cwd 又能正常切换', JSON.stringify(allowed))
  }

  {
    const seen = []
    const { reg, created } = make({
      resolveCwdConflict: async (target) => {
        seen.push(target.cwd)
        return { cwd: 'C:/busy-wt' }
      }
    })
    const wt = await reg.select({ cwd: 'C:/busy-wt', sessionFile: 'C:/busy-wt/a.jsonl' })
    reg.agentOf(wt.id).state = { ...reg.agentOf(wt.id).state, isAgentRunning: true }
    const main = await reg.select({ cwd: 'C:/main', sessionFile: 'C:/main/a.jsonl' })
    reg.agentOf(main.id).state = { ...reg.agentOf(main.id).state, isAgentRunning: true }

    const r = await reg.select({ cwd: 'C:/main', sessionFile: 'C:/main/b.jsonl' })
    ok(r.ok === false, '隔离目标目录里已有忙碌实例时明确拒绝（不在忙目录上再起写入者）', JSON.stringify(r))
    ok(seen.length === 1, '换到新目录后只复核一次，不递归再触发隔离', JSON.stringify(seen))
    ok(/隔离目标目录里还有会话正在运行/.test(r.error ?? ''), '拒绝信息说明隔离目标目录也忙', r.error)
    ok(/请等它跑完或停止它/.test(r.error ?? ''), '拒绝信息提示等待 / 停止原任务', r.error)
    ok(reg.agentOf(wt.id).calls.stop === 0, '拒绝时没有停掉隔离目录里的会话')
    ok(created.filter((x) => cwdKey(x.cwd) === cwdKey('C:/busy-wt')).length === 1, '没有在忙碌的隔离目录再起实例')
    ok(reg.size === 2, '拒绝后实例数不变')
  }

  {
    const { reg, created } = make({ resolveCwdConflict: async () => ({ cwd: 'C:/free-wt' }) })
    const main = await reg.select({ cwd: 'C:/main', sessionFile: 'C:/main/a.jsonl' })
    reg.agentOf(main.id).state = { ...reg.agentOf(main.id).state, isAgentRunning: true }
    await reg.select({ cwd: 'C:/free-wt', sessionFile: 'C:/free-wt/a.jsonl', activate: false })

    const r = await reg.select({ cwd: 'C:/main', sessionFile: 'C:/main/b.jsonl' })
    ok(r.ok === true, '隔离目标目录只有空闲实例时照常切换（不误报冲突）', JSON.stringify(r))
    ok(created.length === 2, '复用空闲隔离实例，不新建实例', JSON.stringify(created))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runSessionConcurrencyConflictTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Session concurrency conflict tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
