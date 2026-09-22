/**
 * 子代理控制器（src/main/subagents.ts）的策略测试。
 *
 * 这里不 spawn 真 pi、不花额度：`createRpc` 注入假客户端，
 * `prepare` 注入可控工作区。真 git 只用在「退出时清理 worktree」那条，
 * 因为它验证的正是文件系统上的真实结果。
 *
 * 覆盖的是 2026-09-15 审计登记的四条缺陷：
 *   D1 并发槽位必须在准备隔离区**之前**预占
 *   D2 已结束的任务在退出时仍要被归档清理（finalize 的 promise 缓存不能挡住）
 *   D3 准备期间切父会话不能让 cwd 与 parentSessionId 分属两代
 *   D4 「只读」要落到 pi 的 `--tools` 白名单，而不只是换个 cwd
 *   D15 toolResult 要回填到原工具调用（否则同一个调用显示成两条，真实结果看不出来）
 *   D16 任务结束后要关掉 pi 子进程（否则泄漏进程，且 worktree 在 Windows 上删不掉）
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 假 pi 客户端：记录参数，允许测试手动投递事件 */
function makeRpcFactory() {
  const created = []
  const createRpc = ({ cwd, args }) => {
    const handlers = new Map()
    const rpc = {
      cwd,
      args,
      running: false,
      closed: false,
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() {
        rpc.running = true
      },
      async command(type) {
        if (type === 'get_state') return { success: true, data: {} }
        if (type === 'prompt') return { success: true }
        return { success: true }
      },
      async close() {
        rpc.running = false
        rpc.closed = true
      },
      emit(event, ...payload) {
        for (const listener of handlers.get(event) ?? []) listener(...payload)
      }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

/** 不碰文件系统的假工作区（只读模式走这条，collectDiff 直接返回空摘要） */
const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return predicate()
}

export async function runSubagentControllerTests(ok, SubagentController) {
  /* ---- D1：并发槽位在 prepare 之前预占 ---- */
  {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: async (rootCwd, id, isolation) => {
        await gate
        return { isolation, rootCwd, cwd: rootCwd }
      }
    })
    const pending = [ctrl.start('任务 1'), ctrl.start('任务 2'), ctrl.start('任务 3')]
    release()
    const results = await Promise.all(pending)
    const accepted = results.filter((r) => r.ok)
    const rejected = results.filter((r) => !r.ok)
    ok(accepted.length === 2, '并发启动时最多两个通过（槽位在准备隔离区前就占住）', `通过=${accepted.length}`)
    ok(rejected.length === 1, '第三个并发请求被拒绝', `拒绝=${rejected.length}`)
    ok(/最多 2 个/.test(rejected[0]?.error ?? ''), '拒绝理由说明并发上限', JSON.stringify(rejected[0]?.error))
    await ctrl.stopAll()
  }

  /* ---- D3：准备期间切父会话，不能发生代次漂移 ---- */
  {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      parentSessionId: 'sess-a',
      parentRunId: 'r1',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: async (rootCwd, id, isolation) => {
        await gate
        return { isolation, rootCwd, cwd: rootCwd }
      }
    })
    const started = ctrl.start('准备期间切会话')
    /* 用户在这一刻切到别的项目 / 会话 */
    ctrl.setContext({ cwd: 'C:/proj-b', parentSessionId: 'sess-b', parentRunId: 'r2' })
    release()
    const res = await started
    ok(res.ok === true, '准备期间切会话不影响已发起的子代理', res.error ?? '')
    ok(res.run?.cwd === 'C:/proj-a', '子代理仍用发起时的 cwd', res.run?.cwd)
    ok(factory.created[0]?.cwd === 'C:/proj-a', 'pi 进程也在发起时的 cwd 启动')
    ok(res.run?.parentSessionId === 'sess-a', '父会话身份与 cwd 来自同一代次', res.run?.parentSessionId)
    ok(res.run?.parentRunId === 'r1', '父 runner 身份同样是发起时的')
    await ctrl.stopAll()
  }

  /* ---- D4：只读子代理必须带 pi 侧工具白名单 ---- */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('只读审查', undefined, 'controlled-cwd')
    ok(res.ok === true, '只读子代理可以启动', res.error ?? '')
    const args = factory.created[0]?.args ?? []
    ok(args.includes('--no-extensions'), '子代理关闭用户扩展自动发现', JSON.stringify(args))
    ok(args.includes('--no-skills'), '子代理关闭用户 Skill 自动发现', JSON.stringify(args))
    const at = args.indexOf('--tools')
    ok(at >= 0, '只读子代理把工具白名单交给 pi（--tools）', JSON.stringify(args))
    ok(args[at + 1] === 'read,grep,find,ls', '白名单只含只读工具', args[at + 1])
    ok(!args.includes('write') && !args.includes('edit') && !args.includes('bash'), '白名单里没有写入类工具')
    await ctrl.stopAll()
  }

  /* ---- D15：toolResult 回填到原调用，不新增消息 ---- */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('看看工具调用', undefined, 'controlled-cwd')
    const id = res.run?.id
    const rpc = factory.created[0]
    ok(!!id && !!rpc, '拿到 run 与假 rpc')
    rpc.emit('event', {
      type: 'message_end',
      message: {
        role: 'assistant',
        id: 'm1',
        content: [{ type: 'toolCall', id: 'tc1', name: 'write', arguments: { path: 'x.txt' } }]
      }
    })
    const one = ctrl.get(id)
    ok(one?.transcript.length === 1, '工具调用先落成一条消息', `条数=${one?.transcript.length}`)
    ok(one?.transcript[0].toolCalls?.[0]?.status === 'ok', '未收到结果前是历史默认状态')

    rpc.emit('event', {
      type: 'message_end',
      message: {
        role: 'toolResult',
        id: 'r1',
        toolCallId: 'tc1',
        toolName: 'write',
        isError: true,
        content: [{ type: 'text', text: 'Tool write not found' }]
      }
    })
    const two = ctrl.get(id)
    ok(two?.transcript.length === 1, '结果回填到原调用，没有新增一条消息', `条数=${two?.transcript.length}`)
    ok(
      two?.transcript[0].toolCalls?.[0]?.status === 'error',
      '调用状态反映真实结果（error）',
      two?.transcript[0].toolCalls?.[0]?.status
    )
    ok(/not found/.test(two?.transcript[0].toolCalls?.[0]?.output ?? ''), '输出也挂在同一个调用上')
    await ctrl.stopAll()
  }

  /* ---- D16：任务结束后子代理进程必须收掉 ---- */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('跑完就收进程', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    rpc.emit('event', { type: 'agent_settled' })
    const closed = await waitFor(() => rpc.closed === true)
    ok(closed, '任务结束后 pi 子进程被关掉（否则泄漏进程，worktree 也删不掉）')
    ok(ctrl.get(res.run?.id)?.status === 'done', '关进程不影响终态判定')
    await ctrl.stopAll()
  }

  /*
   * L03 尾巴：模型自己失败不能被 settled 当成「已完成」。
   *
   * pi 的失败回合也会走到 `agent_settled`，错误只体现在 assistant 消息的
   * `stopReason` 上；不看它的后果是子代理面板显示「已完成」、`error=null`
   *（2026-09-19 在真实窗口用坏模型名实测到的就是这两个值）。
   */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('模型会失败', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    rpc.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', id: 'm1', content: [], stopReason: 'error' }
    })
    rpc.emit('event', { type: 'agent_settled' })
    const run = ctrl.get(res.run?.id)
    ok(run?.status === 'error', '模型报错时终态是 error（不是 done）', String(run?.status))
    ok(/模型返回错误/.test(run?.error ?? ''), 'error 带可读原因', JSON.stringify(run?.error))
    ok(run?.latestActivity !== '已完成', '列表里的活动也不是「已完成」', String(run?.latestActivity))
    await ctrl.stopAll()
  }

  /* 对照：`stopReason: 'stop'`（或压根没这个字段）仍算正常结束 —— 空回复不是失败 */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('正常空回复', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    rpc.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', id: 'm1', content: [], stopReason: 'stop' }
    })
    rpc.emit('event', { type: 'agent_settled' })
    const run = ctrl.get(res.run?.id)
    ok(run?.status === 'done', 'stopReason=stop 时终态仍是 done', String(run?.status))
    ok(!run?.error, '对照下没有 error', JSON.stringify(run?.error))
    await ctrl.stopAll()
  }

  /* ---- L03：pi 起不来时必须报错并回收，不留僵尸任务 ---- */
  {
    const created = []
    const createRpc = ({ cwd, args }) => {
      const handlers = new Map()
      const rpc = {
        cwd,
        args,
        running: false,
        closed: false,
        on(event, listener) {
          const list = handlers.get(event) ?? []
          list.push(listener)
          handlers.set(event, list)
          return rpc
        },
        /* spawn 什么也不做：模拟「进程起不来」（真实链路的坏 pi 入口） */
        spawn() {},
        async command() {
          return { success: true }
        },
        async close() {
          rpc.closed = true
        },
        emit(event, ...payload) {
          for (const listener of handlers.get(event) ?? []) listener(...payload)
        }
      }
      created.push(rpc)
      return rpc
    }
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('pi 起不来', undefined, 'controlled-cwd')
    ok(res.ok === false, '起不来时 start 返回失败而不是假装启动成功', JSON.stringify(res.error))
    ok(/启动超时/.test(res.error ?? ''), '错误说的是启动超时', JSON.stringify(res.error))
    /* start 失败时不回 run（回它反而像“启动了”），所以从列表里按任务找 */
    const run = ctrl.list().find((r) => r.task === 'pi 起不来')
    ok(run?.status === 'error', 'run 停在 error（不留在「运行中」）', String(run?.status))
    ok(created[0]?.closed === true, '起不来的进程也被 close 掉')
    await ctrl.stopAll()
  }

  /*
   * L03：运行超时要真的能触发。
   * 10 分钟等不起 —— 用 `YAN_SUBAGENT_TIMEOUT_MS` 压到 200ms（真实验证同一先例：
   * `YAN_AUTO_CONTINUE` 把退避压短）。断言到点后转 error + 进程被收。
   */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    process.env.YAN_SUBAGENT_TIMEOUT_MS = '200'
    const res = await ctrl.start('挂着不动', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    let timedOut = false
    try {
      timedOut = await waitFor(() => {
        const r = ctrl.get(res.run?.id ?? '')
        return r?.status === 'error' && /运行超时/.test(r.error ?? '')
      }, 5000)
    } finally {
      /*
       * 覆盖值必须留到超时**真的触发**之后：`runTimeoutText()` 在触发时
       * 才读 env（实测提前 delete 会让提示写成「超过 10 分钟」而实际是 200ms）。
       */
      delete process.env.YAN_SUBAGENT_TIMEOUT_MS
    }
    ok(timedOut, '到点后转 error 且原因写着运行超时', String(ctrl.get(res.run?.id ?? '')?.error))
    ok(!/10 分钟/.test(ctrl.get(res.run?.id ?? '')?.error ?? ''), '提示报的是覆盖后的上限（不是写死的 10 分钟）')
    ok(rpc?.closed === true, '超时后 pi 子进程被收掉（不留僵尸）')
    await ctrl.stopAll()
  }

  /*
   * 流式事件序列：id 不能漂移。
   *
   * 子代理的转录 id 是按序号生成的（`m{序号}`），所以“序号 = 下一条新消息”
   * 这个假设必须成立。D15 把 toolResult 改成**回填而不 push**之后，用
   * `transcript.length` 当序号就会错位：同一条流式回复会被拆成多条，
   * 最终回复的文本也可能被盖掉（实测 subagent 场景的“转录里有模型回复”失败）。
   */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('流式 + 工具结果', undefined, 'controlled-cwd')
    const id = res.run?.id
    const rpc = factory.created[0]
    const push = (type, message) => rpc.emit('event', { type, message })

    push('message_start', { role: 'user', content: '去写个文件' })
    push('message_start', { role: 'assistant', content: [] })
    push('message_update', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'write', arguments: {} }]
    })
    push('message_end', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'write', arguments: {} }]
    })
    push('message_end', {
      role: 'toolResult',
      toolCallId: 'tc1',
      toolName: 'write',
      content: [{ type: 'text', text: 'ok' }]
    })
    push('message_start', { role: 'assistant', content: [] })
    push('message_end', { role: 'assistant', content: [{ type: 'text', text: '写好了' }] })

    const t = ctrl.get(id)?.transcript ?? []
    ok(t.length === 3, '流式回合只落三条消息（用户 / 工具调用 / 最终回复）', `条数=${t.length}`)
    ok(t[1]?.toolCalls?.[0]?.id === 'tc1', '工具调用消息就位')
    ok(t[1]?.toolCalls?.[0]?.output === 'ok', '工具结果回填到同一条调用上')
    ok(t[2]?.text === '写好了', '最终回复的文本没有被流式重复盖掉', JSON.stringify(t[2]?.text))
    await ctrl.stopAll()
  }

  /* ---- D2：已结束的未审阅 worktree，退出时仍要被归档清理 ---- */
  {
    const root = await mkdtemp(join(tmpdir(), 'yan-subagent-ctrl-'))
    const archive = join(root, 'archives')
    await mkdir(archive, { recursive: true })
    const git = (args) => execFileAsync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' })
    try {
      await git(['init', '-q'])
      await git(['config', 'user.email', 'yan-tests@example.invalid'])
      await git(['config', 'user.name', 'Yan tests'])
      await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
      await git(['add', 'base.txt'])
      await git(['commit', '-qm', 'base'])

      const factory = makeRpcFactory()
      const ctrl = new SubagentController({
        cwd: root,
        archiveDir: archive,
        createRpc: factory.createRpc,
        onChange: () => {}
      })
      const res = await ctrl.start('在隔离区写一个文件', undefined, 'worktree')
      ok(res.ok === true, '写入型子代理拿到独立 worktree', res.error ?? '')
      const run = res.run
      ok(run?.isolation === 'worktree' && run.cwd !== root, 'worktree 与主工作目录不同', run?.cwd)
      ok(!(factory.created[0]?.args ?? []).includes('--tools'), '写入型子代理不套只读白名单')

      await writeFile(join(run.cwd, 'new.txt'), 'created\n', 'utf8')
      factory.created[0].emit('event', { type: 'agent_settled' })
      const closed = await waitFor(() => factory.created[0]?.closed === true)
      ok(closed, '真实 worktree 任务结束后子进程也收掉了（目录才删得掉）')
      const pending = await waitFor(() => ctrl.get(run.id)?.review === 'pending')
      ok(pending, '普通结束先把 worktree 留给用户审阅', ctrl.get(run.id)?.review)
      ok(existsSync(run.cwd), '审阅期间 worktree 还在磁盘上')

      /* 用户直接退出：已结束的任务也必须被归档清理（D2）。 */
      await ctrl.stopAll()
      const after = ctrl.get(run.id)
      ok(after?.review === 'archived', '退出时把未审阅的 worktree 归档', after?.review)
      ok(after?.diff?.files === 1, '归档摘要记录了改动文件', JSON.stringify(after?.diff))
      ok(!!after?.resultPath && existsSync(after.resultPath), '退出后保留可追溯的补丁', after?.resultPath)
      ok(!existsSync(run.cwd), '退出后临时 worktree 已删除')

      /* 重复退出不能报错，也不该重复删一次已经没了的东西。 */
      await ctrl.stopAll()
      ok(ctrl.get(run.id)?.review === 'archived', '重复退出保持归档状态')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}
