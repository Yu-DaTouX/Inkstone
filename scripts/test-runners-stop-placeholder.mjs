#!/usr/bin/env node
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { RunnerRegistry } = await compile('src/main/runners.ts')
  const { canReclaimIdle } = await compile('src/main/runner-reclaim.ts')

  const gate = () => {
    let open
    const promise = new Promise((resolve) => { open = resolve })
    return { promise, open }
  }

  const harness = (options = {}) => {
    const agents = []
    const registry = new RunnerRegistry({
      limit: 3,
      ...options,
      createAgent: (id, cwd) => {
        const agent = {
          id,
          cwd,
          conn: 'ready',
          stopGate: null,
          switchGate: null,
          calls: { start: 0, stop: 0, switchSession: [] },
          state: { sessionId: undefined, sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd },
          getState() { return this.state },
          getPendingUiCount() { return 0 },
          hasRunningBash() { return false },
          getConn() { return { state: this.conn, detail: '' } },
          setRunnerGeneration() {},
          queueSnapshot() { return { steering: [], followUp: [] } },
          async start() { this.calls.start++; this.conn = 'ready'; return { ok: true } },
          async stop() {
            this.calls.stop++
            if (this.stopGate) await this.stopGate.promise
          },
          async switchSession(file) {
            this.calls.switchSession.push(file)
            if (this.switchGate) await this.switchGate.promise
            this.state = { ...this.state, sessionFile: file, sessionId: `id:${file}` }
            return { ok: true }
          },
          async newSession() {
            this.state = { ...this.state, sessionFile: undefined, sessionId: `new:${id}` }
            return { ok: true }
          }
        }
        agents.push(agent)
        return agent
      }
    })
    return { registry, agents }
  }

  console.log('stop 挂起期间保留占位')
  {
    const { registry, agents } = harness()
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    ok(first.ok && agents.length === 1, '先开出一个运行实例')
    agents[0].stopGate = gate()
    const stopping = registry.stopOne(first.id)
    await Promise.resolve()
    ok(registry.size === 0, '停止中的实例已不在登记表')
    const second = registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(agents.length === 1, '停止完成前同一会话不会创建第二个 agent')
    ok(registry.hasBusyCwd('C:/p/a') === true, '停止中的实例算占用同目录')
    ok(registry.hasBusyCwd('C:/p/a', first.id) === false, '排除自身时不算占用')
    agents[0].stopGate.open()
    ok((await stopping) === true, 'stopOne 在停止完成后返回')
    const reopened = await second
    ok(reopened.ok && reopened.via === 'new' && agents.length === 2, '停止完成后同一会话才开出新实例', JSON.stringify(reopened))
    ok(registry.hasBusyCwd('C:/p/a') === false, '停止完成后占位已移除')
    await registry.stopAll()
  }

  console.log('同目录与预览')
  {
    const { registry, agents } = harness()
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    agents[0].stopGate = gate()
    const stopping = registry.stopOne(first.id)
    const preview = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl', preview: true })
    ok(preview.ok && preview.deferred === true && agents.length === 1, '预览选择在停止期间延后而不开实例', JSON.stringify(preview))
    const other = registry.select({ cwd: 'c:\\P\\A', sessionFile: 'C:/s/two.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(agents.length === 1, '同目录的另一会话也等待停止完成')
    agents[0].stopGate.open()
    await stopping
    ok((await other).ok && agents.length === 2, '停止完成后继续')
    await registry.stopAll()
  }

  console.log('等待超时给出明确失败，占位保留到真正停止')
  {
    const { registry, agents } = harness({ stopWaitMs: 40 })
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    agents[0].stopGate = gate()
    const stopping = registry.stopOne(first.id)
    const result = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    ok(!result.ok && !!result.error && agents.length === 1, '等待超时返回失败且不并行再开', JSON.stringify(result))
    ok(registry.hasBusyCwd('C:/p/a') === true, '超时后占位仍保留')
    agents[0].stopGate.open()
    await stopping
    ok(registry.hasBusyCwd('C:/p/a') === false, '真正停止后才移除占位')
    await registry.stopAll()
  }

  console.log('stopBySessionFile 与 stopByCwd 经过占位')
  {
    const { registry, agents } = harness()
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    agents[0].stopGate = gate()
    const stopping = registry.stopBySessionFile('c:\\s\\ONE.jsonl')
    await Promise.resolve()
    const again = registry.stopBySessionFile('C:/s/one.jsonl')
    let settled = false
    void again.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    ok(settled === false, '重复停止同一会话会等待进行中的停止')
    agents[0].stopGate.open()
    ok((await stopping) === true && (await again) === true, '两次停止都在完成后返回')
    ok(agents[0].calls.stop === 1, '同一 agent 只被停止一次')
    ok(first.ok, 'stopBySessionFile 路径别名命中')
    await registry.stopAll()
  }

  console.log('复用分支 await 期间被停止')
  {
    const { registry, agents } = harness()
    const a = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/a.jsonl' })
    const b = await registry.select({ cwd: 'C:/p/b', sessionFile: 'C:/s/b.jsonl' })
    ok(a.ok && b.ok && registry.activeRunnerId === b.id, '前置：b 为当前')
    agents[0].switchGate = gate()
    const switching = registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/c.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    ok(agents[0].calls.switchSession.at(-1) === 'C:/s/c.jsonl', '复用分支已进入 switchSession')
    await registry.stopOne(a.id)
    agents[0].switchGate.open()
    const result = await switching
    ok(!result.ok && !!result.error, '复用期间被停止后 select 返回失败', JSON.stringify(result))
    ok(registry.activeRunnerId === b.id, 'activeRunnerId 保持不变')
    ok(agents[0].calls.switchSession.length === 2, '不对已停止的实例回滚切换')
    await registry.stopAll()
  }

  console.log('命中死 runner 会 relaunch')
  {
    const { registry, agents } = harness()
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    agents[0].conn = 'exited'
    const hit = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    ok(hit.ok && hit.id === first.id && hit.via === 'reuse', '已退出的 runner 被 relaunch', JSON.stringify(hit))
    ok(agents.length === 2 && agents[1].calls.start === 1, '新建了替代 agent 并启动')
    ok(agents[0].calls.stop === 1, '旧 agent 被停止')
    ok(agents[1].calls.switchSession[0] === 'C:/s/one.jsonl', '替代 agent 载入原会话')
    agents[1].conn = 'error'
    const bySession = await registry.select({ sessionId: hit.sessionId, cwd: 'C:/p/a' })
    ok(bySession.ok && agents.length === 3 && agents[2].calls.switchSession[0] === 'C:/s/one.jsonl', '按 sessionId 命中错误态 runner 也自愈并沿用原会话文件', JSON.stringify(bySession))
    const alive = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:/s/one.jsonl' })
    ok(alive.via === 'hit' && agents.length === 3, '存活的 runner 仍然直接命中')
    await registry.stopAll()
  }

  console.log('路径别名命中同一 runner')
  {
    const { registry, agents } = harness()
    const first = await registry.select({ cwd: 'C:/p/a', sessionFile: 'C:\\a\\b.jsonl' })
    const alias = await registry.select({ cwd: 'C:/p/a', sessionFile: 'c:/a/b.jsonl' })
    ok(alias.ok && alias.id === first.id && alias.via === 'hit' && agents.length === 1, 'C:\\a\\b.jsonl 与 c:/a/b.jsonl 命中同一 runner', JSON.stringify(alias))
    await registry.stopAll()
  }

  console.log('空闲回收允许已退出或错误态')
  {
    const facts = { active: false, hidden: false, busy: false, busyCwd: false, ready: false, saved: true, queued: false, visible: false, parentProtected: false, restarting: false, lastActiveAt: 0 }
    const later = 11 * 60_000
    ok(canReclaimIdle(facts, later) === false, '启动中（非 ready 非 dead）不回收')
    ok(canReclaimIdle({ ...facts, dead: true }, later) === true, '已退出或错误态允许回收')
    ok(canReclaimIdle({ ...facts, dead: true, busy: true }, later) === false, '忙碌的死实例不回收')
    ok(canReclaimIdle({ ...facts, dead: true, visible: true }, later) === false, '界面可见的死实例不回收')

    let now = 0
    const { registry, agents } = harness({ now: () => now, isSessionVisible: () => false })
    const dead = await registry.select({ cwd: 'C:/p/d', sessionFile: 'C:/s/d.jsonl' })
    const hold = await registry.select({ cwd: 'C:/p/h', sessionFile: 'C:/s/h.jsonl' })
    ok(hold.ok && dead.ok, '前置：两个 runner')
    agents[0].conn = 'exited'
    now = 20 * 60_000
    const reclaimed = await registry.reclaimIdle()
    ok(reclaimed === dead.id && registry.size === 1, '死实例在空闲超时后被回收', String(reclaimed))
    await registry.stopAll()
  }
})
