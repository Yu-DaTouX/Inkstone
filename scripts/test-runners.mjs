/**
 * 运行实例注册表的策略测试（N12）。
 *
 * 这些断言全部是**策略级**的，不需要起任何 pi 进程：
 *   · 切到已有实例 → 只改视图（不发停止、不重切别的实例）
 *   · 忙碌的实例绝不被复用，也绝不被停掉腾位置
 *   · 到并发上限 → 明确报错（而不是牺牲后台任务）
 *   · 空闲实例才允许复用
 *
 * 用假 agent（只实现注册表用到的那几个方法）驱动，行为可确定复现。
 */
export function runRunnerTests(ok, RunnerRegistry) {
  const mkAgent = () => {
    const calls = { start: 0, stop: 0, switchSession: [], newSession: 0 }
    return {
      calls,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      getState() {
        return this.state
      },
      getPendingUiCount() {
        return this.pending
      },
      getConn() {
        return { state: 'ready', detail: '' }
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
      }
    }
  }

  const made = []
  const make = () => {
    const agents = []
    const reg = new RunnerRegistry({
      limit: 2,
      createAgent: (id) => {
        const a = mkAgent()
        a.id = id
        agents.push(a)
        made.push(a)
        return a
      }
    })
    return { reg, agents }
  }

  /* ---- 1. 首次选择：新建实例 ---- */
  {
    const { reg } = make()
    let r
    return (async () => {
      r = await reg.select({ cwd: 'C:/a', sessionFile: 'C:/s1.jsonl' })
      ok(r.ok && r.via === 'new', '首次选择会新建运行实例', `via=${r.via}`)
      ok(reg.size === 1, '注册表里有 1 个实例')
      const first = made[0]
      ok(first.calls.start === 1, '新实例被启动')
      ok(first.calls.switchSession.includes('C:/s1.jsonl'), '新实例切到了目标会话')

      /* ---- 2. 再选同一个会话：命中，不动任何实例 ---- */
      const r2 = await reg.select({ cwd: 'C:/a', sessionFile: 'C:/s1.jsonl' })
      ok(r2.ok && r2.via === 'hit', '切回同一会话命中已有实例（只改视图）', `via=${r2.via}`)
      ok(r2.id === r.id, '命中的是同一个实例 id')
      ok(first.calls.stop === 0, '命中路径没有停止任何实例')
      ok(first.calls.switchSession.length === 1, '命中路径没有重新切会话')

      /* ---- 3. 忙碌实例不被复用：另开一个 ---- */
      first.state = { ...first.state, isAgentRunning: true }
      const r3 = await reg.select({ cwd: 'C:/b', sessionFile: 'C:/s2.jsonl' })
      ok(r3.ok && r3.via === 'new', '实例忙着时不会复用/打断它（另开实例）', `via=${r3.via}`)
      ok(first.calls.stop === 0, '忙碌实例没有被停止')
      ok(first.state.sessionFile === 'C:/s1.jsonl', '忙碌实例仍停在原会话上（上下文没被换走）')
      ok(reg.size === 2, '现在有 2 个实例')

      /* ---- 4. 同 cwd 忙碌冲突：明确拒绝，不牺牲后台会话 ---- */
      const rConflict = await reg.select({ cwd: 'C:/a/', sessionFile: 'C:/s-conflict.jsonl' })
      ok(!rConflict.ok, '同一工作目录已有忙碌会话时拒绝并发写入')
      ok(/同一工作目录/.test(rConflict.error ?? ''), '冲突信息明确指出同一工作目录', JSON.stringify(rConflict.error))
      ok(first.calls.stop === 0 && made.length === 2, '冲突时没有停止或额外创建实例')
      ok(reg.size === 2, '冲突拒绝后实例数量不变')

      /* ---- 5. 达到上限且都忙：明确报错，不牺牲后台会话 ---- */
      const second = made[1]
      second.state = { ...second.state, isAgentRunning: true }
      const r4 = await reg.select({ cwd: 'C:/c', sessionFile: 'C:/s3.jsonl' })
      ok(!r4.ok, '到并发上限时拒绝切换')
      ok(/上限/.test(r4.error ?? ''), '错误信息说明是并发上限', JSON.stringify(r4.error))
      ok(first.calls.stop === 0 && second.calls.stop === 0, '拒绝时**没有**停掉任何后台会话')
      ok(reg.size === 2, '实例数量不变')

      /* ---- 6. 有实例空闲时才复用（并且是切会话不是停止） ---- */
      first.state = { ...first.state, isAgentRunning: false }
      const r5 = await reg.select({ cwd: 'C:/c', sessionFile: 'C:/s3.jsonl' })
      ok(r5.ok && r5.via === 'reuse', '有空闲实例时复用它（省进程）', `via=${r5.via}`)
      ok(r5.id === first.id, '复用的正是那个空闲实例')
      ok(first.calls.switchSession.includes('C:/s3.jsonl'), '复用 = 让它切到新会话')
      ok(first.calls.stop === 0, '复用路径没有停止实例')
      ok((r5.generation ?? 0) > 1, '复用会话时 generation 递增')
      const envelope = reg.runtimeOf(first.id)
      ok(envelope?.runId === first.id && envelope?.generation === r5.generation, '运行时封套包含 runId 与当前代次')

      /* ---- 7. 状态快照 ---- */
      const statuses = reg.statuses()
      ok(statuses.length === 2, '状态快照覆盖所有实例')
      const s1 = statuses.find((x) => x.id === first.id)
      ok(s1?.running === false, '快照里的 running 反映实例真实状态')
      ok(s1?.isActive === true, '当前视图那个实例标记 isActive')
      ok(second.id && statuses.find((x) => x.id === second.id)?.running === true, '后台忙碌实例在快照里是 running')

      /* ---- 8. waiting（有请求在等回答）也算忙 ---- */
      first.pending = 1
      first.state = { ...first.state, isAgentRunning: false }
      const r7 = await reg.select({ cwd: 'C:/a', sessionFile: 'C:/s4.jsonl' })
      ok(
        !r7.ok && /上限/.test(r7.error ?? ''),
        '等待回答的实例也算忙（不会被顶掉，而是明确拒绝）',
        JSON.stringify(r7.error)
      )
      ok(reg.size === 2, '拒绝后实例数不变')
      first.pending = 0

      /* ---- 9. 单独停止只影响一个 ---- */
      const beforeStop = statuses.length
      await reg.stopOne(first.id)
      ok(reg.size === 1, `stopOne 之后实例数 ${beforeStop} → ${reg.size}`)
      ok(first.calls.stop === 1, '只停了指定那个实例')
      ok(second.calls.stop === 0, '另一个实例没有被牵连')

      /* ---- 10. hasBusy ---- */
      ok(reg.hasBusy() === true, '还有忙碌实例时 hasBusy = true')
      second.state = { ...second.state, isAgentRunning: false }
      ok(reg.hasBusy() === false, '全部空闲后 hasBusy = false')

      /* ---- 11. 全部停止 ---- */
      await reg.stopAll()
      ok(reg.size === 0 && reg.statuses().length === 0, 'stopAll 之后注册表清空')
      ok(made.every((a) => a.calls.stop >= 1), '所有实例都被停过')

      /* ---- 12. stopByCwd 也必须按规范化路径匹配 ---- */
      {
        const { reg: cwdReg } = make()
        const created = await cwdReg.select({ cwd: 'C:/same/project/' })
        const runner = cwdReg.agentOf(created.id)
        const stopped = await cwdReg.stopByCwd('c:\\same\\project')
        ok(stopped === 1, 'stopByCwd 会识别大小写、斜杠和尾部斜杠差异', `stopped=${stopped}`)
        ok(cwdReg.size === 0, '规范化路径停止后实例已移除')
        ok(runner?.calls.stop === 1, '规范化路径只停止匹配到的实例')
      }
    })()
  }
}
