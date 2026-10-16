import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function runExecutionAdmissionTests(ok) {
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
  const guard = await build({
    entryPoints: [fileURLToPath(new URL('../src/main/session-send-guard.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const { SAME_CWD_ADMISSION_ERROR, SAME_CWD_BUSY_ERROR } = await import(
    `data:text/javascript;base64,${Buffer.from(guard.outputFiles[0].text).toString('base64')}`
  )

  const mkAgent = () => {
    const calls = { start: 0, stop: 0, switchSession: [], newSession: 0 }
    return {
      calls,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      bashRunning: false,
      queue: { steering: [], followUp: [] },
      getState() { return this.state },
      getPendingUiCount() { return this.pending },
      hasRunningBash() { return this.bashRunning },
      getConn() { return { state: 'ready', detail: '' } },
      setRunnerGeneration(generation) { this.capabilityGeneration = generation },
      async start() { calls.start++; return { ok: true } },
      async stop() { calls.stop++ },
      async switchSession(p) { calls.switchSession.push(p); this.state = { ...this.state, sessionFile: p }; return { ok: true } },
      async newSession() { calls.newSession++; this.state = { ...this.state, sessionFile: undefined }; return { ok: true } },
      queueSnapshot() { return structuredClone(this.queue) },
      async restoreQueueSnapshot(snapshot) { this.queue = structuredClone(snapshot); return { ok: true } }
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
        agent.state = { ...agent.state, cwd, sessionId: `s-${id}` }
        if (generation !== undefined) agent.capabilityGeneration = generation
        agents.push(agent)
        created.push({ id, cwd })
        return agent
      },
      ...options
    })
    return { reg, agents, created }
  }

  const busy = (reg, id, flag = true) => {
    const agent = reg.agentOf(id)
    agent.state = { ...agent.state, isAgentRunning: flag }
  }

  const sendWithAdmission = async (reg, id, gate) => {
    const claim = reg.admitExecute(id)
    if (!claim.ok) return claim
    try {
      await gate
      if (!reg.confirmExecute(id, claim.token)) return { ok: false, error: 'stale-admission' }
      return { ok: true, token: claim.token }
    } finally {
      reg.releaseExecute(id, claim.token)
    }
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
    const b = await reg.select({ cwd: 'C:/proj', sessionFile: 'C:/proj/b.jsonl', activate: false })
    busy(reg, a.id, false)
    busy(reg, b.id, false)

    let release
    const gate = new Promise((resolve) => { release = resolve })
    const first = sendWithAdmission(reg, a.id, gate)
    const second = sendWithAdmission(reg, b.id, gate)
    release()
    const [r1, r2] = await Promise.all([first, second])
    const results = [r1, r2].sort((x, y) => Number(y.ok) - Number(x.ok))
    ok(results[0].ok === true && results[1].ok === false, '两空闲同 cwd 并发只放行一个入场', JSON.stringify(results))
    ok(results[1].error === SAME_CWD_ADMISSION_ERROR, '被拒的一方给出同步入场冲突原因', results[1].error)
    ok(reg.size === 2, '拒绝不新建 / 不停实例')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/reentrant', sessionFile: 'C:/reentrant/a.jsonl' })
    const one = reg.admitExecute(a.id)
    const two = reg.admitExecute(a.id)
    ok(one.ok && two.ok && one.token === two.token, '同实例重入返回同一 token', JSON.stringify({ one, two }))
    busy(reg, a.id, true)
    ok(reg.admitExecute(a.id).ok === true, '忙碌实例对自己的插话 / 排队放行')
    reg.releaseExecute(a.id, one.token)
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/one', sessionFile: 'C:/one/a.jsonl' })
    const b = await reg.select({ cwd: 'C:/two', sessionFile: 'C:/two/a.jsonl', activate: false })
    ok(reg.admitExecute(a.id).ok === true, 'cwd1 入场成功')
    ok(reg.admitExecute(b.id).ok === true, '不同 cwd 也能同时入场')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/a.jsonl' })
    const b = await reg.select({ cwd: 'C:/busy', sessionFile: 'C:/busy/b.jsonl', activate: false })
    busy(reg, a.id, true)
    const g = reg.admitExecute(b.id)
    ok(g.ok === false && g.error === SAME_CWD_BUSY_ERROR, '同 cwd 另有忙碌实例时入场失败', JSON.stringify(g))
    ok(reg.admitExecute(a.id).ok === true, '忙碌的发起者自己继续放行')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/release', sessionFile: 'C:/release/a.jsonl' })
    const b = await reg.select({ cwd: 'C:/release', sessionFile: 'C:/release/b.jsonl', activate: false })
    const claim = reg.admitExecute(a.id)
    ok(claim.ok && reg.admitExecute(b.id).ok === false, 'a 持有 claim 时 b 被拒')
    reg.releaseExecute(a.id, claim.token)
    ok(reg.admitExecute(b.id).ok === true, '失败 / 取消 release 后 b 可以入场')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/removed', sessionFile: 'C:/removed/a.jsonl' })
    const b = await reg.select({ cwd: 'C:/removed', sessionFile: 'C:/removed/b.jsonl', activate: false })
    const old = reg.admitExecute(a.id)
    await reg.stopOne(a.id)
    const fresh = reg.admitExecute(b.id)
    ok(fresh.ok === true, '进程删除后登记被回收，新实例可以入场', JSON.stringify(fresh))
    reg.releaseExecute(a.id, old.token)
    ok(reg.confirmExecute(b.id, fresh.token) === true, '删除进程的旧 token release 不会清掉新实例的 claim')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/epoch', sessionFile: 'C:/epoch/a.jsonl' })
    const old = reg.admitExecute(a.id)
    ok(old.ok === true, '旧代次入场成功')
    const moved = await reg.select({ cwd: 'C:/epoch', sessionFile: 'C:/epoch/b.jsonl' })
    ok(moved.ok && moved.via === 'reuse' && (moved.generation ?? 0) > 1, '复用换会话后代次前进', JSON.stringify(moved))
    ok(reg.confirmExecute(a.id, old.token) === false, '换代次后旧 token 不能通过 confirm')
    const fresh = reg.admitExecute(a.id)
    ok(fresh.ok === true, '新代次可以重新入场', JSON.stringify(fresh))
    reg.releaseExecute(a.id, old.token)
    ok(reg.confirmExecute(a.id, fresh.token) === true, '旧代 token release 不会清掉新代 claim')
    reg.releaseExecute(a.id, fresh.token)
    ok(reg.admitExecute(a.id).ok === true, '新 claim 正常归还后可以再入场')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/confirm', sessionFile: 'C:/confirm/a.jsonl' })
    const claim = reg.admitExecute(a.id)
    ok(claim.ok && reg.confirmExecute(a.id, claim.token) === true, '持有 claim 时 confirm 通过')
    ok(reg.confirmExecute(a.id, claim.token + 999) === false, 'token 不符 confirm 失败')
    reg.releaseExecute(a.id, claim.token)
    ok(reg.confirmExecute(a.id, claim.token) === false, 'release 之后 confirm 失败')
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/Proj/', sessionFile: 'C:/Proj/a.jsonl' })
    const b = await reg.select({ cwd: 'c:\\proj', sessionFile: 'C:/proj/b.jsonl', activate: false })
    const claim = reg.admitExecute(a.id)
    const blocked = reg.admitExecute(b.id)
    ok(claim.ok && blocked.ok === false, '不同写法的同一物理目录不能同时入场', JSON.stringify(blocked))
  }

  {
    const { reg } = make()
    const a = await reg.select({ cwd: 'C:/leak', sessionFile: 'C:/leak/a.jsonl' })
    for (let i = 0; i < 5; i++) {
      const c = reg.admitExecute(a.id)
      if (c.ok) reg.releaseExecute(a.id, c.token)
    }
    const final = reg.admitExecute(a.id)
    ok(final.ok === true, '反复 claim / release 后仍能正常入场')
    reg.releaseExecute(a.id, final.token)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  await runExecutionAdmissionTests((condition, label, detail) => {
    if (condition) passed++
    else {
      failed++
      console.error(`FAIL: ${label}`, detail ?? '')
    }
  })
  console.log(`Execution admission tests: ${passed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
}
