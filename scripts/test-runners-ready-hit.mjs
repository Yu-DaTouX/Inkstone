#!/usr/bin/env node
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { RunnerRegistry } = await compile('src/main/runners.ts')

  const gate = () => {
    let open
    const promise = new Promise((resolve) => { open = resolve })
    return { promise, open }
  }

  const harness = () => {
    const agents = []
    let nextStartGate = null
    const registry = new RunnerRegistry({
      limit: 4,
      createAgent: (id, cwd) => {
        const startGate = nextStartGate
        nextStartGate = null
        const agent = {
          id,
          cwd,
          conn: 'connecting',
          switchGate: null,
          calls: { start: 0, stop: 0, switchSession: [] },
          state: { sessionId: undefined, sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd },
          getState() { return this.state },
          getPendingUiCount() { return 0 },
          hasRunningBash() { return false },
          getConn() { return { state: this.conn, detail: '' } },
          setRunnerGeneration() {},
          queueSnapshot() { return { steering: [], followUp: [] } },
          async start() {
            this.calls.start++
            if (startGate) await startGate.promise
            this.conn = 'ready'
            return { ok: true }
          },
          async stop() { this.calls.stop++; this.conn = 'exited' },
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
    return { registry, agents, holdNextStart: (g) => { nextStartGate = g } }
  }

  const settled = async (promise, ms = 30) => {
    let done = false
    void promise.then(() => { done = true }, () => { done = true })
    await new Promise((resolve) => setTimeout(resolve, ms))
    return done
  }

  {
    const { registry, agents, holdNextStart } = harness()
    const ready = await registry.select({ cwd: 'C:/a', sessionFile: 'C:/s/ready.jsonl' })
    ok(ready.ok && agents[0].conn === 'ready', '先有一个就绪的会话实例')
    const slowGate = gate()
    holdNextStart(slowGate)
    const slow = registry.select({ cwd: 'C:/b', sessionFile: 'C:/s/slow.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const back = registry.select({ cwd: 'C:/a', sessionFile: 'C:/s/ready.jsonl' })
    ok(await settled(back), '切回已就绪的会话不再排在另一个慢启动后面')
    const hit = await back
    ok(hit.ok && hit.via === 'hit' && hit.id === ready.id, '直接命中原实例', JSON.stringify(hit))
    ok(registry.activeRunnerId === ready.id, '当前视图切回就绪会话')
    slowGate.open()
    const slowResult = await slow
    ok(slowResult.ok, '慢启动的会话照常完成')
    ok(registry.activeRunnerId === ready.id, '较早发起的慢选择完成后不覆盖较新的选择')
  }

  {
    const { registry, agents, holdNextStart } = harness()
    const blocker = gate()
    holdNextStart(blocker)
    const first = registry.select({ cwd: 'C:/x', sessionFile: 'C:/s/first.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const same = registry.select({ cwd: 'C:/x', sessionFile: 'C:/s/first.jsonl' })
    ok(!(await settled(same)), '还在启动中的实例不走快速命中，排队等启动完成')
    blocker.open()
    const [a, b] = await Promise.all([first, same])
    ok(a.ok && b.ok && b.id === a.id && agents.length === 1, '启动完成后命中同一实例，不重复开', JSON.stringify({ a, b }))
  }

  {
    const { registry, agents } = harness()
    const one = await registry.select({ cwd: 'C:/r', sessionFile: 'C:/s/one.jsonl' })
    await registry.select({ cwd: 'C:/q', sessionFile: 'C:/s/other.jsonl' })
    agents[0].switchGate = gate()
    const reuse = registry.select({ cwd: 'C:/r', sessionFile: 'C:/s/two.jsonl' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    ok(agents[0].calls.switchSession.at(-1) === 'C:/s/two.jsonl', '\u524d\u7f6e\uff1a\u7a7a\u95f2\u5b9e\u4f8b\u6b63\u5728\u88ab\u590d\u7528\u5207\u5230\u53e6\u4e00\u4e2a\u4f1a\u8bdd')
    const old = registry.select({ cwd: 'C:/r', sessionFile: 'C:/s/one.jsonl' })
    ok(!(await settled(old)), '正在被复用切走的实例不能被快速命中')
    agents[0].switchGate.open()
    const reused = await reuse
    const back = await old
    ok(reused.ok && reused.sessionId === 'id:C:/s/two.jsonl' && back.ok && back.sessionId === 'id:C:/s/one.jsonl', '两次选择按顺序生效，各自拿到正确的会话', JSON.stringify({ reused, back, one }))
    ok(registry.agentOf(back.id).getState().sessionFile === 'C:/s/one.jsonl', '最终实例停在最后选择的会话上')
  }
})
