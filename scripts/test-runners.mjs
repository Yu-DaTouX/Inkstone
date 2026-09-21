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
    const calls = { start: 0, stop: 0, switchSession: [], newSession: 0, restoredQueues: [] }
    return {
      calls,
      state: { sessionId: 's', sessionFile: undefined, isAgentRunning: false, isStreaming: false, isCompacting: false, cwd: 'C:/p' },
      pending: 0,
      queue: { steering: [], followUp: [] },
      capabilityGeneration: 1,
      restoreResult: { ok: true },
      /** 直执行 shell 是否在跑（L05：它也算“忙”，见 runners.ts 的 busy） */
      bashRunning: false,
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
        calls.restoredQueues.push(structuredClone(snapshot))
        if (!this.restoreResult.ok) return this.restoreResult
        this.queue = structuredClone(snapshot)
        return { ok: true }
      }
    }
  }

  const made = []
  const make = () => {
    const agents = []
    const reg = new RunnerRegistry({
      limit: 2,
      createAgent: (id, _cwd, generation) => {
        const a = mkAgent()
        a.id = id
        if (generation !== undefined) a.setRunnerGeneration(generation)
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
      ok(reg.hasBusyCwd('c:/a/') === true, '按规范化 cwd 可识别忙碌实例（包管理必须据此拒绝变更）')
      ok(reg.hasBusyCwd('C:/other') === false, '不同 cwd 不受忙碌实例影响')
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

      /*
       * ---- 4b. 直执行 shell 在跑也算忙（L05） ----
       *
       * 直执行 bash 不经过模型，所以 isAgentRunning / isStreaming 都是 false。
       * 但它同样在改工作目录 —— 不算忙的话，切换会复用到这颗实例，
       * 用户在新会话里只会看到“已有一条命令在跑”（看着像卡死）。
       */
      {
        const madeB = []
        const regB = new RunnerRegistry({
          limit: 2,
          createAgent: (id) => {
            const a = mkAgent()
            a.id = id
            madeB.push(a)
            return a
          }
        })
        const b1 = await regB.select({ cwd: 'C:/z', sessionFile: 'C:/z1.jsonl' })
        ok(b1.ok, '先建一个实例用于 shell 忙碌判定')
        madeB[0].bashRunning = true
        ok(regB.hasBusyCwd('c:/z/') === true, 'cwd 忙碌查询也包含直执行 bash')
        const b2 = await regB.select({ cwd: 'C:/z', sessionFile: 'C:/z2.jsonl' })
        ok(!b2.ok, '直执行 shell 在跑时，同 cwd 的切换被拒绝', JSON.stringify(b2))
        ok(/同一工作目录/.test(b2.error ?? ''), '理由仍是“同一工作目录已有运行中的会话”', JSON.stringify(b2.error))
        madeB[0].bashRunning = false
        const b3 = await regB.select({ cwd: 'C:/z', sessionFile: 'C:/z2.jsonl' })
        ok(b3.ok, 'shell 跑完后同 cwd 又能正常切换/复用', JSON.stringify(b3))
      }

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
      const r5 = await reg.select({ cwd: 'C:/a', sessionFile: 'C:/s3.jsonl' })
      ok(r5.ok && r5.via === 'reuse', '有空闲实例时复用它（省进程）', `via=${r5.via}`)
      ok(r5.id === first.id, '复用的正是那个空闲实例')
      ok(first.calls.switchSession.includes('C:/s3.jsonl'), '复用 = 让它切到新会话')
      ok(first.calls.stop === 0, '同项目复用不会停止实例（跨项目换进程见第 13 组）')
      ok((r5.generation ?? 0) > 1, '复用会话时 generation 递增')
      ok(first.capabilityGeneration === r5.generation, '复用后 capability 守卫同步到当前 generation')
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
      const r7 = await reg.select({ cwd: 'C:/d', sessionFile: 'C:/s4.jsonl' })
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

      /*
       * ---- 13. 跨项目复用空闲实例必须换进程（D5）----
       *
       * pi 进程的 cwd 只在 spawn 时确定，`new_session` 改不了它。
       * 只改注册表字段的话，新会话会落在旧项目目录里。
       */
      {
        const { reg, agents } = make()
        const first = await reg.select({ cwd: 'C:/p1', sessionFile: 'C:/s-p1.jsonl' })
        const oldAgent = agents[0]
        ok(agents.length === 1, '同项目内只起了一个进程')

        /* 同一 cwd 换会话：复用同一个进程 */
        const same = await reg.select({ cwd: 'C:/p1', sessionFile: 'C:/s-p1b.jsonl' })
        ok(same.ok && same.via === 'reuse' && agents.length === 1, '同项目复用不换进程', `agents=${agents.length}`)
        ok(oldAgent.calls.switchSession.includes('C:/s-p1b.jsonl'), '同项目复用只切会话文件')

        /* 跨项目换会话：必须换进程，runner id 保持不变 */
        const moved = await reg.select({ cwd: 'C:/p2', sessionFile: 'C:/s-p2.jsonl' })
        ok(moved.ok && moved.via === 'reuse', '跨项目仍复用同一个 runner 身份', `via=${moved.via}`)
        ok(moved.id === first.id, 'runner id 稳定（渲染端缓存不用换键）')
        ok(agents.length === 2, '跨项目复用会新建一个 pi 进程', `agents=${agents.length}`)
        ok(oldAgent.calls.stop === 1, '旧 cwd 的进程被停掉')
        ok(agents[1].calls.start === 1, '新进程已启动')
        ok(agents[1].calls.switchSession.includes('C:/s-p2.jsonl'), '新进程切到目标会话')
        ok(reg.activeRunner()?.cwd === 'C:/p2', '注册表里的 cwd 指向新项目', reg.activeRunner()?.cwd)
        ok((moved.generation ?? 0) > 1, '换项目同样让 generation 递增（迟到事件失效）')
        ok(agents[1].capabilityGeneration === moved.generation, '跨项目替代实例带着注册表的新 generation 启动')
      }

      /* ---- 13b. 后台定向会话不得改变桌面当前视图（远程 send） ---- */
      {
        const { reg, agents } = make()
        const foreground = await reg.select({ cwd: 'C:/foreground', sessionFile: 'C:/foreground.jsonl' })
        const background = await reg.select({
          cwd: 'C:/background',
          sessionFile: 'C:/background.jsonl',
          activate: false
        })
        ok(background.ok && background.via === 'new', '后台定向发送创建独立 runner，不复用前台实例')
        ok(background.id !== foreground.id && agents.length === 2, '前后台会话各有自己的实例')
        ok(reg.activeRunnerId === foreground.id, '创建后台 runner 后桌面当前视图保持不变', reg.activeRunnerId)
        const repeated = await reg.select({
          cwd: 'C:/background',
          sessionFile: 'C:/background.jsonl',
          activate: false
        })
        ok(repeated.ok && repeated.via === 'hit' && repeated.id === background.id, '后台定向发送复用同一目标 runner')
        ok(reg.activeRunnerId === foreground.id, '命中后台 runner 也不会抢走桌面视图', reg.activeRunnerId)
        const nextBackground = await reg.select({
          cwd: 'C:/background-next',
          sessionFile: 'C:/background-next.jsonl',
          activate: false
        })
        ok(nextBackground.ok && nextBackground.via === 'reuse' && nextBackground.id === background.id, '只复用非前台空闲 runner 来承接另一个后台会话')
        ok(reg.activeRunnerId === foreground.id, '跨项目复用后台 runner 仍保留前台视图', reg.activeRunnerId)
      }
      {
        const { reg, agents } = make()
        const foreground = await reg.select({ cwd: 'C:/same', sessionFile: 'C:/same-front.jsonl' })
        const background = await reg.select({
          cwd: 'C:/same',
          sessionFile: 'C:/same-back.jsonl',
          activate: false
        })
        agents[0].state = { ...agents[0].state, isAgentRunning: true }
        ok(reg.hasBusyCwd('C:/same', background.id), '定向发送可检测目标外同 cwd runner 正在工作')
        ok(!reg.hasBusyCwd('C:/same', foreground.id), '按 runId 排除后不会把目标自身误判为冲突')
        ok(reg.activeRunnerId === foreground.id, '同 cwd 冲突查询不改变桌面视图')
      }

      /* ---- 14. 跨项目换进程失败时回退，不把旧实例弄丢 ---- */
      {
        const { reg, agents } = make()
        const first = await reg.select({ cwd: 'C:/p1' })
        /* 下一个新建的假 agent 启动失败 */
        reg.opts.createAgent = (id, cwd) => {
          const bad = mkAgent()
          bad.id = id
          bad.cwd = cwd
          bad.start = async () => ({ ok: false, error: '起不来' })
          agents.push(bad)
          return bad
        }
        const failed = await reg.select({ cwd: 'C:/p2' })
        ok(!failed.ok && /起不来/.test(failed.error ?? ''), '跨项目换进程失败会明确报错', JSON.stringify(failed.error))
        ok(reg.activeRunner()?.cwd === 'C:/p1', '失败后注册表仍指回旧 cwd')
        ok(agents[0].calls.stop === 0, '失败时旧进程没有被停掉')
        ok(agents[1].calls.stop === 1, '起不来的半个进程被收掉')
        ok(first.id === reg.activeRunner()?.id, '实例身份没有被换掉')
        ok(agents[0].capabilityGeneration === first.generation, '跨项目启动失败后旧实例 capability generation 回滚')
      }
      /* ---- 15. 新实例切换失败：必须回收进程，不能只摘登记（R02） ---- */
      {
        const { reg, agents } = make()
        const first = await reg.select({ cwd: 'C:/p1', sessionFile: 'C:/s-p1.jsonl' })
        /* 让已有实例忙起来，逼 select 走「新建实例」而不是复用 */
        agents[0].state = { ...agents[0].state, isAgentRunning: true }
        let leaked = null
        reg.opts.createAgent = (id, cwd) => {
          const bad = mkAgent()
          bad.id = id
          bad.cwd = cwd
          bad.switchSession = async (p) => {
            bad.calls.switchSession.push(p)
            return { ok: false, error: '切换被扩展取消' }
          }
          agents.push(bad)
          leaked = bad
          return bad
        }
        const failed = await reg.select({ cwd: 'C:/p2', sessionFile: 'C:/s-p2.jsonl' })
        ok(!failed.ok && /切换被扩展取消/.test(failed.error ?? ''), '新实例切换失败会报错', JSON.stringify(failed.error))
        ok(reg.size === 1, '失败的新实例不会留在注册表里', `size=${reg.size}`)
        ok(leaked?.calls.stop === 1, '失败的新实例被真正停掉（不是只删登记）', `stop=${leaked?.calls.stop}`)
        ok(reg.activeRunner()?.id === first.id, 'activeId 还原到原来的实例')
        await reg.stopAll()
        ok(
          agents.every((a) => a.calls.stop >= 1),
          'stopAll 能覆盖到所有被创建过的实例（没有漏回收对象）',
          agents.map((a) => a.calls.stop).join(',')
        )
      }

      /* ---- 16. 新实例 start 抛异常 / switch 抛异常同样要回收 ---- */
      {
        for (const mode of ['start-throws', 'switch-throws']) {
          const { reg, agents } = make()
          const firstId = (await reg.select({ cwd: 'C:/p1', sessionFile: 'C:/s-p1.jsonl' })).id
          agents[0].state = { ...agents[0].state, isAgentRunning: true }
          let bad = null
          reg.opts.createAgent = (id, cwd) => {
            bad = mkAgent()
            bad.id = id
            bad.cwd = cwd
            if (mode === 'start-throws') {
              bad.start = async () => {
                bad.calls.start++
                throw new Error('spawn 失败')
              }
            } else {
              bad.switchSession = async () => {
                throw new Error('切换超时')
              }
            }
            agents.push(bad)
            return bad
          }
          const failed = await reg.select({ cwd: 'C:/p2', sessionFile: 'C:/s-p2.jsonl' })
          ok(!failed.ok, `${mode}：以失败返回而不是冒泡异常`, JSON.stringify(failed))
          ok(/spawn 失败|切换超时/.test(failed.error ?? ''), `${mode}：错误信息带上了原始原因`, failed.error)
          ok(reg.size === 1, `${mode}：注册表回到 1 个实例`, `size=${reg.size}`)
          ok(bad?.calls.stop === 1, `${mode}：半途实例被停掉`, `stop=${bad?.calls.stop}`)
          ok(reg.activeRunner()?.id === firstId, `${mode}：activeId 已还原`)
          await reg.stopAll()
        }
      }

      /* ---- 17. 受管资源激活只重载目标 runner，并保住会话与队列 ---- */
      {
        const agents = []
        const reg = new RunnerRegistry({
          limit: 3,
          createAgent: (id, cwd, generation) => {
            const a = mkAgent()
            a.id = id
            a.generation = generation
            a.state = { ...a.state, cwd }
            agents.push(a)
            return a
          }
        })
        const target = await reg.select({ cwd: 'C:/same', projectId: 'p', sessionFile: 'C:/same-target.jsonl' })
        const other = await reg.select({
          cwd: 'C:/same',
          projectId: 'p',
          sessionFile: 'C:/same-other.jsonl',
          activate: false
        })
        /* 先让 r2 暂时忙起来，防止创建第三个实例时按正常策略复用它。 */
        reg.agentOf(other.id).state = { ...reg.agentOf(other.id).state, isAgentRunning: true }
        const unrelated = await reg.select({
          cwd: 'C:/elsewhere',
          projectId: 'q',
          sessionFile: 'C:/elsewhere.jsonl',
          activate: false
        })
        const originalTarget = reg.agentOf(target.id)
        const otherAgent = reg.agentOf(other.id)
        const unrelatedAgent = reg.agentOf(unrelated.id)
        originalTarget.queue = { steering: ['先处理 A'], followUp: ['之后处理 B'] }

        const sameCwdBusy = await reg.restartOne(target.id)
        ok(!sameCwdBusy.ok && /同一工作目录/.test(sameCwdBusy.error ?? ''), '同 cwd 的其它 runner 忙时拒绝重载')
        ok(agents.length === 3 && originalTarget.calls.stop === 0, '拒绝期间没有创建替代进程或停止旧实例')

        otherAgent.state = { ...otherAgent.state, isAgentRunning: false }
        unrelatedAgent.state = { ...unrelatedAgent.state, isAgentRunning: true }
        const restartRequest = reg.restartOne(target.id)
        const duplicateRestart = reg.restartOne(target.id)
        ok(restartRequest === duplicateRestart, '同一 runner 的并发重载请求合并为同一操作')
        const restarted = await restartRequest
        const replacement = reg.agentOf(target.id)
        ok(restarted.ok && restarted.id === target.id, '目标 runner 成功单独重载且身份稳定')
        ok(replacement !== originalTarget && agents.length === 4, '目标换成新 AgentController')
        ok(replacement.generation === restarted.generation, '替代 AgentController 获得注册表即将启用的 generation')
        ok(replacement.state.sessionFile === 'C:/same-target.jsonl', '新进程载回同一会话文件')
        ok(
          JSON.stringify(replacement.queue) === JSON.stringify({ steering: ['先处理 A'], followUp: ['之后处理 B'] }),
          'steering / follow-up 队列都恢复且顺序不变',
          JSON.stringify(replacement.queue)
        )
        ok(originalTarget.calls.stop === 1, '替代实例就绪后才停止目标旧进程')
        ok(otherAgent.calls.stop === 0 && unrelatedAgent.calls.stop === 0, '同项目其它 runner 与无关目录 runner 均未停止')
        ok(unrelatedAgent.state.isAgentRunning && reg.agentOf(unrelated.id) === unrelatedAgent, '重载不影响无关目录正在运行的任务')
        ok(reg.activeRunnerId === target.id, '重载保留当前前台 runner')
        ok((restarted.generation ?? 0) > (target.generation ?? 0), '重载递增 generation 以隔离迟到事件')
      }

      /* ---- 18. 新实例恢复队列失败时回滚到仍存活的旧实例 ---- */
      {
        const agents = []
        const reg = new RunnerRegistry({
          createAgent: (id, cwd) => {
            const a = mkAgent()
            a.id = id
            a.state = { ...a.state, cwd }
            if (agents.length === 1) a.restoreResult = { ok: false, error: '队列恢复失败' }
            agents.push(a)
            return a
          }
        })
        const selected = await reg.select({ cwd: 'C:/rollback', sessionFile: 'C:/rollback.jsonl' })
        const previous = reg.agentOf(selected.id)
        previous.queue = { steering: ['未发出的消息'], followUp: [] }
        const failed = await reg.restartOne(selected.id)
        ok(!failed.ok && /队列恢复失败/.test(failed.error ?? ''), '队列恢复失败让重载明确失败')
        ok(reg.agentOf(selected.id) === previous, '失败后注册表恢复旧实例')
        ok(previous.calls.stop === 0, '失败回滚时旧进程保持存活')
        ok(agents[1].calls.stop === 1, '失败的替代进程已回收')
        ok(reg.runtimeOf(selected.id)?.generation === selected.generation, '失败回滚恢复原 generation')
      }

      /* ---- 19. 持久能力目标跨 app runner id 变化按会话身份恢复 ---- */
      {
        const { reg } = make()
        const selected = await reg.select({ cwd: 'C:/durable', projectId: 'project-durable', sessionFile: 'C:/sessions/durable.jsonl' })
        const snapshot = reg.activationSnapshot({
          runnerId: 'stale-runner-id',
          cwd: 'c:/DURABLE/',
          sessionFile: 'c:/SESSIONS/DURABLE.JSONL',
          projectId: 'project-durable'
        })
        ok(snapshot?.id === selected.id, '能力目标：旧 runner id 失效时按同 cwd / session / project 找回当前实例')
        ok(snapshot?.ready === true && snapshot.busy === false, '能力目标：恢复快照报告真实 ready / idle 状态')
        const wrongProject = reg.activationSnapshot({
          runnerId: selected.id,
          cwd: 'C:/durable',
          sessionFile: 'C:/sessions/durable.jsonl',
          projectId: 'another-project'
        })
        ok(wrongProject === null, '能力目标：projectId 漂移不能只凭会话路径通过')
        await reg.stopAll()
      }
    })()
  }
}
