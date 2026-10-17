import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runRunnerReclaimTests(ok) {
  const compiled = await build({
    stdin: { contents: "export * from './src/main/runners'; export * from './src/main/runner-reclaim'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true, platform: 'node', format: 'esm', write: false
  })
  const { RunnerRegistry, RunnerVisibility, canReclaimIdle, IDLE_RECLAIM_AFTER_MS: T, IDLE_RECLAIM_SCAN_MS } =
    await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const make = (options = {}) => {
    let now = 0
    const agents = [], reclaimed = []
    const reg = new RunnerRegistry({
      now: () => now,
      isSessionVisible: () => false,
      onReclaimed: entry => reclaimed.push(entry),
      ...options,
      createAgent: (id, cwd, generation) => {
        const agent = {
          id, generation, stopped: 0, switches: [], bash: false, pending: 0,
          state: { sessionId: id, cwd, isAgentRunning: false, isStreaming: false, isCompacting: false },
          queue: { steering: [], followUp: [] },
          conn: 'ready',
          getState() { return this.state },
          getConn() { return { state: this.conn } },
          hasRunningBash() { return this.bash },
          getPendingUiCount() { return this.pending },
          queueSnapshot() { return structuredClone(this.queue) },
          setRunnerGeneration(value) { this.generation = value },
          async start() { return { ok: true } },
          async stop() { this.stopped++ },
          async switchSession(path) { this.switches.push(path); this.state.sessionFile = path; return { ok: true } },
          async newSession() { this.state.sessionFile = undefined; return { ok: true } },
          async initializeContextBudgetV1Default() { return { ok: true } },
          async restoreQueueSnapshot(queue) { this.queue = queue; return { ok: true } }
        }
        agents.push(agent)
        return agent
      }
    })
    return { reg, agents, reclaimed, at: time => { now = time } }
  }
  const setup = async (options = {}, count = 2, hidden = false) => {
    const fixture = make(options)
    for (let n = 0; n < count; n++) {
      const result = await fixture.reg.select({ cwd: `C:/p${n}`, sessionFile: `C:/s${n}.jsonl`, hidden: hidden && n === 0 })
      ok(result.ok, `建立夹具实例 ${n + 1}`)
      fixture.agents[n].state.isAgentRunning = true
    }
    for (const agent of fixture.agents) agent.state.isAgentRunning = false
    return fixture
  }

  const base = { active: false, hidden: false, busy: false, busyCwd: false, ready: true, saved: true,
    queued: false, visible: false, parentProtected: false, restarting: false, lastActiveAt: 0 }
  ok(canReclaimIdle(base, T), '阈值到达才可回收')
  ok(!canReclaimIdle(base, T - 1), '阈值前1毫秒不回收')
  ok(!canReclaimIdle(base, -1), '时钟回拨不回收')
  ok(!canReclaimIdle({ ...base, lastActiveAt: NaN }, T), '无效活动时间不回收')
  for (const key of ['active', 'hidden', 'busy', 'busyCwd', 'queued', 'visible', 'parentProtected', 'restarting']) {
    ok(!canReclaimIdle({ ...base, [key]: true }, T), `纯判据：${key} 保护`)
  }
  for (const key of ['ready', 'saved']) ok(!canReclaimIdle({ ...base, [key]: false }, T), `纯判据：缺少 ${key} 不回收`)

  const visibility = new RunnerVisibility()
  const state = { sessionId: 's1', sessionFile: 'C:/Sessions/one.jsonl' }
  ok(visibility.includes(state), '显示集合未知时保护全部实例')
  ok(visibility.update([{ sessionId: 's1' }, { sessionFile: 'c:\\sessions\\two.jsonl' }]), '接受多列显示集合')
  ok(visibility.includes(state), '按稳定会话ID保护')
  ok(visibility.includes({ sessionId: 's2', sessionFile: 'C:/Sessions/two.jsonl' }), '按规范化会话路径保护')
  ok(!visibility.includes({ sessionId: 'cold' }), '显示集合之外不保护')
  for (const input of [null, {}, [null], [{}], [{ sessionId: 3 }], [{ sessionFile: '' }], [{ sessionId: 'x'.repeat(257) }], Array(6).fill({ sessionId: 'x' })]) {
    ok(!visibility.update(input), '非法/超长显示集合拒绝')
    ok(visibility.includes(state), '非法输入不抹掉上一次保护集合')
  }
  visibility.reset()
  ok(visibility.includes(state), '渲染重载/崩溃期间重新保护全部')
  ok(visibility.update([]) && !visibility.includes(state), '空显示集合允许回收非活动会话')

  {
    const f = await setup()
    f.at(T - 1)
    ok(await f.reg.reclaimIdle() === null, '实际扫描未到阈值不回收')
    f.at(T)
    const generation = f.reg.statuses()[0].generation
    const id = await f.reg.reclaimIdle()
    ok(id === f.agents[0].id, '回收最早空闲的非活动实例')
    ok(f.agents[0].stopped === 1 && f.agents[1].stopped === 0, '只关闭目标进程')
    ok(f.reg.size === 1 && f.reg.activeRunnerId === f.agents[1].id, '移除登记且不改变当前选择')
    ok(f.reclaimed.length === 1 && f.reclaimed[0].idleMs === T && f.reclaimed[0].remaining === 1, '回收日志含空闲时间和剩余数量')
    f.agents[1].state.isAgentRunning = true
    const restored = await f.reg.select({ cwd: 'C:/p0', sessionFile: 'C:/s0.jsonl' })
    ok(restored.ok && restored.via === 'new', '切回回收会话可以新建实例')
    ok(restored.generation > generation && restored.id !== id, '恢复使用新身份和更高代次')
    ok(f.reg.active().switches.includes('C:/s0.jsonl'), '恢复载入原会话文件')
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    f.at(T)
    await f.reg.reclaimIdle()
    const restored = await f.reg.select({ cwd: 'C:/p0', sessionFile: 'C:/s0.jsonl' })
    ok(restored.ok && restored.via === 'reuse', '切回也可以走已有空闲实例复用路径')
    ok(f.reg.active().state.sessionFile === 'C:/s0.jsonl', '跨目录复用载回原会话')
    await f.reg.stopAll()
  }
  for (const field of ['isAgentRunning', 'isStreaming', 'isCompacting', 'bash', 'pending', 'steering', 'followUp']) {
    const f = await setup()
    const first = f.agents[0]
    const set = value => {
      if (field in first.state) first.state[field] = value
      else if (field === 'steering' || field === 'followUp') first.queue[field] = value ? ['等待发送'] : []
      else first[field] = value
    }
    set(true)
    f.at(T)
    ok(await f.reg.reclaimIdle() === null && first.stopped === 0, `${field} 不回收`)
    set(false)
    f.reg.noteActivity(first.id)
    f.at(2 * T - 1)
    ok(await f.reg.reclaimIdle() === null, `${field} 结束后重新等待完整阈值`)
    f.at(2 * T)
    ok(await f.reg.reclaimIdle() === first.id, `${field} 收尾后超过阈值可回收`)
    await f.reg.stopAll()
  }
  for (const field of ['visible', 'parent']) {
    let protectedNow = true
    const f = await setup(field === 'visible'
      ? { isSessionVisible: () => protectedNow }
      : { isParentProtected: (_sessionId, id) => protectedNow && id === 'r1' })
    f.at(T)
    ok(await f.reg.reclaimIdle() === null, `${field} 的父/分屏实例不回收`)
    if (field === 'visible') { f.at(T + 123); f.reg.noteVisibleActivity() }
    protectedNow = false
    f.at(T + 124)
    ok(await f.reg.reclaimIdle() === null, `${field} 解除保护不立即回收`)
    f.at(2 * T + (field === 'visible' ? 122 : -1))
    ok(await f.reg.reclaimIdle() === null, `${field} 解除保护后阈值前仍保护`)
    f.at(2 * T + (field === 'visible' ? 123 : 0))
    ok(await f.reg.reclaimIdle() === 'r1', `${field} 解除保护后完整空闲期才回收`)
    await f.reg.stopAll()
  }
  {
    let childrenRunning = true
    const f = await setup({ hasRunningSubagents: sessionId => childrenRunning && sessionId === 'r1' })
    f.agents[1].state.isAgentRunning = true
    const opened = await f.reg.select({ cwd: 'C:/p0', sessionFile: 'C:/other.jsonl' })
    ok(opened.ok && opened.via === 'new' && opened.id === 'r3', '父会话有运行中子代理时打开同目录会话改为新建实例')
    ok(f.agents[0].switches.length === 1 && f.agents[0].state.sessionFile === 'C:/s0.jsonl', '父会话实例保持原会话')
    f.agents[2].state.isAgentRunning = true
    const full = await f.reg.select({ cwd: 'C:/p9', sessionFile: 'C:/full.jsonl' })
    ok(!full.ok && full.error.includes('上限'), '只剩父会话实例空闲且已达上限时明确拒绝')
    ok(f.agents[0].stopped === 0 && f.agents[0].state.sessionFile === 'C:/s0.jsonl', '上限拒绝不换下父会话')
    childrenRunning = false
    const reused = await f.reg.select({ cwd: 'C:/p9', sessionFile: 'C:/later.jsonl' })
    ok(reused.ok && reused.via === 'reuse' && reused.id === 'r1', '子代理结束后父会话实例可以复用')
    ok(f.reg.active().state.sessionFile === 'C:/later.jsonl', '复用后载入新会话')
    await f.reg.stopAll()
  }
  {
    const f = await setup({ isSessionVisible: undefined })
    f.at(T)
    ok(await f.reg.reclaimIdle() === null, '未接显示集合同步时默认禁止自动回收')
    await f.reg.stopAll()
  }
  for (const field of ['saved', 'ready', 'hidden']) {
    const f = await setup({}, 2, field === 'hidden')
    if (field === 'saved') f.agents[0].state.sessionFile = undefined
    if (field === 'ready') f.agents[0].conn = 'connecting'
    f.at(T)
    ok(await f.reg.reclaimIdle() === null, `${field} 前置条件不满足不回收`)
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    f.agents[1].state.isAgentRunning = true
    f.reg.runners.get('r2').cwd = 'c:/P0/'
    f.at(T)
    ok(await f.reg.reclaimIdle() === null, '同一cwd有另一忙碌实例不回收')
    await f.reg.stopAll()
  }
  {
    const f = await setup({}, 3)
    f.at(T)
    const a = f.reg.reclaimIdle(), b = f.reg.reclaimIdle()
    ok(a === b, '并行扫描合并为同一个操作')
    ok(await a === 'r1' && f.reg.size === 2, '一轮最多回收一个')
    ok(await f.reg.reclaimIdle() === 'r2' && f.reg.size === 1, '下一轮才回收第二个，当前实例保留')
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    f.at(T)
    const hit = f.reg.select({ cwd: 'C:/p0', sessionFile: 'C:/s0.jsonl' })
    const scan = f.reg.reclaimIdle()
    ok((await hit).via === 'hit', '先到的切回先命中旧实例')
    ok(await scan === null && f.agents[0].stopped === 0, '扫描不能关闭刚选中或刚失焦的实例')
    f.at(2 * T - 1)
    ok(await f.reg.reclaimIdle() === null, '前一个活动实例失焦后重新等待完整阈值')
    f.at(2 * T)
    ok(await f.reg.reclaimIdle() === 'r2', '前一个活动实例失焦完整10分钟后才回收')
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    const entered = deferred(), release = deferred()
    f.agents[0].stop = async function () { this.stopped++; entered.resolve(); await release.promise }
    f.at(T)
    const scan = f.reg.reclaimIdle()
    await entered.promise
    let selected = false
    const select = f.reg.select({ cwd: 'C:/p0', sessionFile: 'C:/s0.jsonl' }).then(result => { selected = true; return result })
    await Promise.resolve()
    ok(!selected, '回收关闭期间后到的切回等待串行链')
    release.resolve()
    ok(await scan === 'r1' && (await select).ok, '关闭完成后切回恢复成功')
    ok(f.reg.active().state.sessionFile === 'C:/s0.jsonl', '并发恢复没有选中正在关闭的进程')
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    f.at(T)
    const scan = f.reg.reclaimIdle(), restart = f.reg.restartOne('r1')
    ok(await scan === null, '排队的重载操作保护目标，不被扫描抢先回收')
    ok((await restart).ok && f.reclaimed.length === 0, '重载完成不会额外再回收')
    f.at(2 * T)
    ok(await f.reg.reclaimIdle() === 'r1', '重载结束后重新等待完整空闲期')
    await f.reg.stopAll()
  }
  {
    const f = await setup({}, 3)
    for (const agent of f.agents) agent.state.isAgentRunning = true
    f.at(T)
    ok(await f.reg.reclaimIdle() === null, '全忙时扫描不腾位置')
    const result = await f.reg.select({ cwd: 'C:/overflow', sessionFile: 'C:/overflow.jsonl' })
    ok(!result.ok && result.error.includes('上限'), '3实例上限仍明确拒绝')
    ok(f.agents.every(agent => agent.stopped === 0), '上限拒绝未关闭任一旧会话')
    await f.reg.stopAll()
  }
  {
    const f = await setup()
    const previousSet = globalThis.setInterval, previousClear = globalThis.clearInterval
    let ticks = 0, cleared = 0, unref = 0, callback, interval
    const timer = { unref: () => unref++ }
    try {
      globalThis.setInterval = (fn, ms) => { ticks++; callback = fn; interval = ms; return timer }
      globalThis.clearInterval = value => { if (value === timer) cleared++ }
      f.reg.startIdleReclaim(); f.reg.startIdleReclaim()
      ok(ticks === 1 && interval === IDLE_RECLAIM_SCAN_MS && unref === 1, '定时器只有一个、60秒扫描且不阻塞退出')
      f.at(T); callback()
      ok(await f.reg.reclaimIdle() === 'r1', '定时器调用正式回收路径')
      await f.reg.stopAll()
      ok(cleared === 1, 'stopAll 释放定时器')
      callback()
      ok(await f.reg.reclaimIdle() === null, '退出后迟到的扫描不再工作')
    } finally {
      globalThis.setInterval = previousSet; globalThis.clearInterval = previousClear
      await f.reg.stopAll()
    }
  }
  {
    const f = await setup()
    f.at(T)
    const scan = f.reg.reclaimIdle()
    await f.reg.stopAll()
    ok(await scan === null && f.reclaimed.length === 0, 'stopAll 使尚未执行的扫描作废')
    ok(f.agents.every(agent => agent.stopped === 1), '退出并发不重复关闭实例')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0, failed = 0
  await runRunnerReclaimTests((condition, label) => {
    if (condition) passed++
    else { failed++; console.error(`FAIL: ${label}`) }
  })
  console.log(`Runner reclaim: ${passed} passed, ${failed} failed (假Agent/可注入时钟，无模型)`)
  if (failed) process.exitCode = 1
}
