import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  {
    const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-send-'))
    const factory = makeRpcFactory(), queued = [], prompts = [], finished = []
    let promptGate = null
    const createRpc = opts => {
      const rpc = factory.createRpc(opts), inner = rpc.command
      rpc.command = async (type, payload, options) => {
        if (type === 'prompt') prompts.push({ rpc, payload })
        if (type === 'prompt' && !payload?.streamingBehavior && promptGate) await promptGate
        if (type === 'prompt' && payload?.streamingBehavior) {
          queued.push(payload)
          return { success: true, data: { disposition: 'queued' } }
        }
        return inner(type, payload, options)
      }
      return rpc
    }
    const ctrl = new SubagentController({ cwd: archive, archiveDir: archive, parentSessionId: 'parent-a', prepare: fakePrepare,
      createRpc, onChange: () => {}, onFinished: run => finished.push(run) })
    try {
      const started = await ctrl.start('原任务', undefined, 'controlled-cwd')
      const id = started.run.id
      ok((await ctrl.send(id, '   ')).ok === false, '空追加被拒绝')
      ok((await ctrl.send(id, '补充', 'steer', { parentSessionId: 'parent-b' })).error?.includes('本会话'), '其他会话不能向它追加')
      ok((await ctrl.send(id, '补充')).error?.includes('本会话'), '主会话来源不带会话身份时也不能追加')
      ok(queued.length === 0, '被拒绝的追加不会发给 pi')
      const steer = await ctrl.send(id, '改查 src/main', 'steer', { parentSessionId: 'parent-a' })
      ok(steer.ok && steer.delivery === 'queued', 'steer 追加送达并标记排队', JSON.stringify(steer))
      ok(queued[0].streamingBehavior === 'steer' && queued[0].message.startsWith('【主会话追加】') && queued[0].message.endsWith('改查 src/main'), '经 prompt 按 steer 排队，并标明来自主会话')
      ok(ctrl.get(id).latestActivity.includes('当前工具结束后'), '活动摘要说明送达时机', ctrl.get(id).latestActivity)
      const follow = await ctrl.send(id, '做完再列出测试', 'followUp', { parentSessionId: 'parent-a' })
      ok(follow.ok && queued[1].streamingBehavior === 'followUp', 'follow-up 模式按 followUp 排队')
      factory.created[0].emit('event', { type: 'agent_settled', aborted: false })
      ok(await waitFor(() => ctrl.get(id)?.status === 'done'), '子代理正常结束')
      const noSession = await ctrl.send(id, '接着查', 'steer', { from: 'user' })
      ok(!noSession.ok && noSession.error.includes('会话记录') && factory.created.length === 1, '没有会话记录时不续接', noSession.error)
      const sessionDir = join(archive, 'sessions', id)
      await mkdir(sessionDir, { recursive: true })
      await writeFile(join(sessionDir, 'a.jsonl'), '{}\n')
      const resumed = await ctrl.send(id, '接着查 src/renderer', 'steer', { from: 'user' })
      ok(resumed.ok && resumed.delivery === 'resumed', '结束后再发会续接', JSON.stringify(resumed))
      const second = factory.created[1]
      ok(!!second && second.args.includes('--session') && second.args[second.args.indexOf('--session') + 1] === join(sessionDir, 'a.jsonl'), '续接用原会话文件重新拉起 pi', JSON.stringify(second?.args))
      const resumePrompt = prompts.at(-1)
      ok(resumePrompt.rpc === second && !resumePrompt.payload.streamingBehavior && resumePrompt.payload.message.startsWith('【用户追加】你已经完成过原任务') && resumePrompt.payload.message.endsWith('接着查 src/renderer'), '续接后按新一轮发送，并标明来自用户')
      ok(ctrl.get(id).status === 'running' && !ctrl.get(id).endedAt && !ctrl.get(id).error, '续接后回到运行中并清掉结束状态')
      factory.created[0].emit('exit', 0, null)
      ok(ctrl.get(id).status === 'running', '旧进程迟到的退出事件不影响续接后的运行')
      second.emit('event', { type: 'agent_settled', aborted: false })
      ok(await waitFor(() => ctrl.get(id)?.status === 'done' && finished.filter(run => run.id === id).length === 2), '续接后的结束会再通知一次父会话', String(finished.length))
      ok((await ctrl.send('sub-ffffffff', 'x')).error === '找不到这个子代理', '未知 id 报找不到')

      const createdBeforeStop = factory.created.length
      const early = ctrl.send(id, '停掉我', 'steer', { from: 'user' })
      const earlyStop = await ctrl.stop(id)
      const earlyResult = await early
      ok(earlyStop.ok && !earlyResult.ok && earlyResult.error.includes('停止'), '续接刚开始时点停止会取消续接', earlyResult.error)
      ok(factory.created.length === createdBeforeStop && ctrl.get(id).status === 'done', '取消的续接不会拉起进程，也不改状态')

      let openGate = () => {}
      promptGate = new Promise(resolve => { openGate = resolve })
      const slow = ctrl.send(id, '慢一点', 'steer', { from: 'user' })
      ok(await waitFor(() => prompts.at(-1)?.payload.message.endsWith('慢一点')), '续接后的消息已发出')
      await ctrl.stop(id)
      openGate()
      promptGate = null
      const slowResult = await slow
      ok(!slowResult.ok && slowResult.error.includes('没有被处理') && ctrl.get(id).status === 'cancelled', '发送途中被停止时不报送达成功', slowResult.error)

      const clearing = ctrl.send(id, '清理时继续', 'steer', { from: 'user' })
      await ctrl.clearFinished()
      const clearingResult = await clearing
      ok(clearingResult.ok && ctrl.get(id)?.status === 'running', '续接进行中时清理已结束不会把它清掉', JSON.stringify(clearingResult))
      factory.created.at(-1).emit('event', { type: 'agent_settled', aborted: false })
      ok(await waitFor(() => ctrl.get(id)?.status === 'done'), '再次续接后正常结束')

      const tree = await ctrl.start('改代码', undefined, 'worktree')
      factory.created.at(-1).emit('event', { type: 'agent_settled', aborted: false })
      ok(await waitFor(() => ctrl.get(tree.run.id)?.status === 'done'), 'worktree 子代理结束')
      const refused = await ctrl.send(tree.run.id, '再改一点', 'steer', { from: 'user' })
      ok(!refused.ok && refused.error.includes('worktree'), 'worktree 子代理结束后不续接', refused.error)

      const reopened = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc, onChange: () => {} })
      await reopened.loadHistory()
      const before = factory.created.length
      const cold = await reopened.send(id, '重启后接着问', 'steer', { parentSessionId: 'parent-a' })
      ok(cold.ok && cold.delivery === 'resumed' && factory.created.length === before + 1, '重启后可从历史续接', JSON.stringify(cold))
      ok(reopened.get(id).transcript.length === ctrl.get(id).transcript.length && reopened.get(id).status === 'running', '历史续接保留原记录')
      factory.created.at(-1).emit('event', { type: 'agent_settled', aborted: false })
      ok(await waitFor(() => reopened.get(id)?.status === 'done'), '历史续接后正常结束')
      const draining = reopened.send(id, '停止全部时续接', 'steer', { from: 'user' })
      await reopened.stopAll()
      const drainingResult = await draining
      ok(!drainingResult.ok && reopened.get(id).status !== 'running' && reopened.get(id).status !== 'starting', '停止全部会取消进行中的续接', JSON.stringify({ drainingResult, status: reopened.get(id).status }))
    } finally {
      await ctrl.stopAll()
      await rm(archive, { recursive: true, force: true })
    }
  }

  {
    const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-coalesce-'))
    const factory = makeRpcFactory(), pushed = []
    const ctrl = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare,
      createRpc: factory.createRpc, onChange: run => pushed.push(JSON.parse(JSON.stringify(run))) })
    try {
      const a = await ctrl.start('stream A', undefined, 'controlled-cwd')
      const b = await ctrl.start('stream B', undefined, 'controlled-cwd')
      const send = (rpc, type, text) => rpc.emit('event', { type, message: { role: 'assistant', content: [{ type: 'text', text }] } })
      send(factory.created[0], 'message_start', '')
      send(factory.created[1], 'message_start', '')
      const initial = pushed.length
      for (let i = 0; i < 40; i++) {
        send(factory.created[0], 'message_update', `A-${i}中文🖋️`)
        send(factory.created[1], 'message_update', `B-${i}`)
      }
      ok(pushed.length === initial, '流式突发不逐token推送完整快照')
      ok(ctrl.get(a.run.id).transcript.at(-1).text === 'A-39中文🖋️', '主动读取不等待推送计时器')
      await new Promise(done => setTimeout(done, 55))
      ok(pushed.length === initial + 2, '两个运行分别合并为一个推送')
      ok(pushed.filter(run => run.id === a.run.id).at(-1).transcript.at(-1).text === 'A-39中文🖋️', '合并推送保留完整中文emoji')
      ok(pushed.filter(run => run.id === b.run.id).at(-1).transcript.at(-1).text === 'B-39', '并行运行不串流式内容')
      send(factory.created[0], 'message_update', '待结束')
      send(factory.created[0], 'message_end', '最终全文')
      ok(pushed.at(-1).transcript.at(-1).text === '最终全文', '消息结束立即替换为权威全文')
      const ended = pushed.length
      await new Promise(done => setTimeout(done, 55))
      ok(pushed.length === ended, '结束后没有旧计时器重复推送')
      send(factory.created[1], 'message_update', '工具前最新正文')
      factory.created[1].emit('event', { type: 'tool_execution_start', toolName: 'read' })
      ok(pushed.at(-1).toolCalls === 1 && pushed.at(-1).transcript.at(-1).text === '工具前最新正文', '工具开始立即携带最新正文推送')
      send(factory.created[1], 'message_update', '停止前最新正文')
      await ctrl.stop(b.run.id)
      ok(pushed.at(-1).status === 'cancelled' && pushed.at(-1).transcript.at(-1).text === '停止前最新正文', '停止立即推送并保留最新正文')
      const stopped = pushed.length
      await new Promise(done => setTimeout(done, 55))
      ok(pushed.length === stopped, '停止清理待推送计时器')
      await ctrl.clearFinished()
      ok(ctrl.get(b.run.id) === undefined, '停止记录显式清除后不反弹')
    } finally {
      await ctrl.stopAll()
      await rm(archive, { recursive: true, force: true })
    }
  }

  {
    const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-history-'))
    try {
      const factory = makeRpcFactory()
      let finished = 0, restoredNotifications = 0, restoredRpc = 0
      const ctrl = new SubagentController({ cwd: 'C:/history-project', parentSessionId: 'history-parent', parentRunId: 'r-old',
        parentMessageId: 'history-message', projectId: 'history-project', archiveDir: archive, prepare: fakePrepare,
        createRpc: opts => {
          const rpc = factory.createRpc(opts), inner = rpc.command
          rpc.command = async type => type === 'get_state'
            ? { success: true, data: { thinkingLevel: 'low' } }
            : type === 'get_session_stats'
              ? { success: true, data: { contextUsage: { tokens: 2000, contextWindow: 10000, percent: 20 } } }
              : inner(type)
          return rpc
        }, onChange: () => {}, onFinished: () => { finished++ } })
      const started = await ctrl.start('持久化调用记录', 'openai-codex/gpt-6.1-sol', 'controlled-cwd')
      ok(started.ok, '历史回归：假 RPC 子代理成功启动')
      ok(ctrl.hasParentRun('history-parent', 'r-new'), '运行中的子代理按父会话ID保护回收')
      ok(ctrl.hasParentRun(undefined, 'r-old'), '运行中的子代理兼容按父实例ID保护')
      ok(!ctrl.hasParentRun('unrelated', 'r-unrelated'), '子代理归属不保护无关会话')
      const id = started.run.id, rpc = factory.created[0]
      rpc.emit('event', { type: 'tool_execution_start', toolName: 'read', toolCallId: 'saved-call' })
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'saved-call', name: 'read', arguments: { path: 'example.ts' } }] } })
      rpc.emit('event', { type: 'message_end', message: { role: 'toolResult', toolCallId: 'saved-call', toolName: 'read', content: [{ type: 'text', text: 'saved tool result' }] } })
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '保存后的最终回复' }] } })
      rpc.emit('event', { type: 'agent_settled' })
      ok(await waitFor(() => finished === 1), '历史回归：结束收口落盘后通知一次')
      await ctrl.stopAll()
      const disk = JSON.parse(await readFile(join(archive, `${id}.json`), 'utf8'))
      ok(disk.transcript[0].toolCalls[0].output === 'saved tool result', '磁盘快照包含回填后的调用结果')
      ok(disk.model === 'openai-codex/gpt-6.1-sol' && disk.thinkingLevel === 'low' && disk.contextUsage.tokens === 2000, '模型、思考和原生上下文同时持久化')
      const restarted = () => new SubagentController({ cwd: 'C:/other-current-project', archiveDir: archive,
        createRpc: () => { restoredRpc++; throw new Error('历史不得创建进程') }, onChange: () => {},
        onFinished: () => { restoredNotifications++ } })
      const restored = restarted()
      await Promise.all([restored.loadHistory(), restored.loadHistory()])
      const history = restored.get(id)
      ok(restored.list().length === 1 && history?.transcript[0].toolCalls[0].output === 'saved tool result', '新控制器读回调用及结果，不重复加载')
      ok(history?.transcript.at(-1).text === '保存后的最终回复', '重启后最终回复仍可查看')
      ok(history?.parentSessionId === 'history-parent' && history.parentMessageId === 'history-message' && history.cwd === 'C:/history-project', '历史保持原父会话、消息和工作目录，不归给当前项目')
      ok(restored.hasParentRun('history-parent', 'r-new'), '保守版：已结束历史仍保护其父会话，不复制转录')
      await restored.stopAll()
      ok(restored.runningCount === 0 && restoredRpc === 0 && restoredNotifications === 0, '恢复历史不占槽、不启动进程、不重发通知')
      await restored.clearFinished()
      ok(restored.list().length === 0 && existsSync(join(archive, `${id}.json`)), '清除只隐藏历史，原调用快照仍保留')
      ok(!restored.hasParentRun('history-parent', 'r-old'), '显式清除子代理归属后解除父会话保护')
      const cleared = restarted()
      await cleared.loadHistory()
      ok(cleared.list().length === 0, '显式清除的已完成任务重启后不会重新出现')

      const legacy = { id: 'sub-legacy', task: '旧版任务', rootCwd: 'C:/legacy', parentSessionId: 'legacy-parent',
        isolation: 'controlled-cwd', status: 'done', startedAt: 100, endedAt: 200, review: 'none' }
      await writeFile(join(archive, 'sub-legacy.json'), JSON.stringify(legacy))
      await writeFile(join(archive, 'sub-broken.json'), '{broken')
      const session = join(archive, 'sessions', 'sub-legacy')
      await mkdir(session, { recursive: true })
      const entries = [
        { type: 'session', id: 'native-history', cwd: 'C:/legacy' },
        { type: 'message', id: 'native-call', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'legacy-call', name: 'read', arguments: { path: 'legacy.ts' } }] } },
        { type: 'message', id: 'native-result', message: { role: 'toolResult', toolCallId: 'legacy-call', toolName: 'read', content: [{ type: 'text', text: 'legacy result' }] } },
        { type: 'message', id: 'native-final', message: { role: 'assistant', model: 'gpt-6-luna', content: [{ type: 'text', text: '旧记录最终回复' }] } }
      ]
      const native = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      await writeFile(join(session, 'session.jsonl'), native)
      const old = restarted()
      await old.loadHistory()
      ok(old.list().length === 1 && old.get('sub-legacy')?.transcript[0].toolCalls[0].output === 'legacy result', '旧版摘要从本任务 pi 会话补回工具结果，损坏的其他摘要不遮掉历史')
      ok(old.get('sub-legacy')?.toolCalls === 1 && old.get('sub-legacy')?.transcript.at(-1).text === '旧记录最终回复', '旧记录恢复调用计数和最终回复')
      ok(old.get('sub-legacy')?.model === 'gpt-6-luna', '旧记录模型从原生助手消息恢复，不猜测提供商')
      ok(await readFile(join(session, 'session.jsonl'), 'utf8') === native, '兼容恢复不改写原生会话')
      await writeFile(join(archive, 'sub-interrupted.json'), JSON.stringify({ ...legacy, id: 'sub-interrupted', status: 'running', transcript: [], toolCalls: 0 }))
      await mkdir(join(archive, 'sessions', 'sub-interrupted'), { recursive: true })
      await writeFile(join(archive, 'sessions', 'sub-interrupted', 'session.jsonl'), native)
      const interrupted = restarted()
      await interrupted.loadHistory()
      ok(interrupted.get('sub-interrupted')?.status === 'error' && interrupted.get('sub-interrupted')?.endReason === 'exited', '异常退出的旧运行如实显示中断，不误报正在执行')
      ok(interrupted.get('sub-interrupted')?.transcript[0].toolCalls[0].output === 'legacy result' && interrupted.get('sub-interrupted')?.toolCalls === 1, '中断时空快照也从原生会话恢复，不继承过期调用计数')
      ok(interrupted.runningCount === 0 && restoredRpc === 0 && restoredNotifications === 0, '旧记录和中断记录均不重新执行或通知')
    } finally { await rm(archive, { recursive: true, force: true }) }
  }
  {
    const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-start-save-'))
    try {
      for (const blockWrite of [1, 2]) {
        const factory = makeRpcFactory()
        let release, blocked = false, spawns = 0, prompts = 0
        const gate = new Promise(resolve => { release = resolve })
        const ctrl = new SubagentController({ cwd: 'C:/save-race', archiveDir: archive, prepare: fakePrepare, onChange: () => {},
          createRpc: opts => {
            const rpc = factory.createRpc(opts), spawn = rpc.spawn, command = rpc.command
            rpc.spawn = () => { spawns++; spawn() }
            rpc.command = async type => { if (type === 'prompt') prompts++; return command(type) }
            return rpc
          } })
        const save = ctrl.history.save.bind(ctrl.history)
        let writes = 0
        ctrl.history.save = async (...args) => {
          const wait = ++writes === blockWrite
          await save(...args)
          if (wait) { blocked = true; await gate }
        }
        const pending = ctrl.start('保存时停止', undefined, 'controlled-cwd')
        ok(await waitFor(() => blocked), '起始快照保存后的 await 边界可以接收停止')
        const id = ctrl.list()[0].id
        await ctrl.stop(id)
        release()
        const started = await pending
        ok(!started.ok && ctrl.get(id)?.status === 'cancelled' && spawns === blockWrite - 1 && prompts === 0, `第 ${blockWrite} 次保存期间停止后不再拉起进程或继续派活`)
        const restored = new SubagentController({ cwd: 'C:/other', archiveDir: archive, onChange: () => {} })
        await restored.loadHistory()
        ok(restored.get(id)?.status === 'cancelled', '停止快照不会被迟到的起始写入盖回运行状态')
      }
    } finally { await rm(archive, { recursive: true, force: true }) }
  }

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
    const pending = Array.from({ length: 25 }, (_, i) => ctrl.start(`任务 ${i + 1}`))
    ok(ctrl.runningCount === 24, '准备期间预占24个名额')
    release()
    const results = await Promise.all(pending)
    const accepted = results.filter((r) => r.ok)
    const rejected = results.filter((r) => !r.ok)
    ok(accepted.length === 24, '并发启动时24个通过（槽位在准备隔离区前就占住）', `通过=${accepted.length}`)
    ok(rejected.length === 1, '第25个并发请求被拒绝', `拒绝=${rejected.length}`)
    ok(/最多 24 个/.test(rejected[0]?.error ?? ''), '拒绝理由说明并发上限', JSON.stringify(rejected[0]?.error))
    await ctrl.stop(accepted[0].run.id)
    ok((await ctrl.start('释放后补位')).ok && ctrl.runningCount === 24, '停止后可补回一个名额')
    await ctrl.stopAll()
    ok(ctrl.runningCount === 0, '停止全部后名额归零')
  }

  {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({ cwd: 'C:/staggered', onChange: () => {}, prepare: fakePrepare,
      createRpc: opts => {
        const rpc = factory.createRpc(opts), command = rpc.command
        rpc.command = async type => { if (type === 'get_state') await gate; return command(type) }
        return rpc
      } })
    const first = Array.from({ length: 5 }, () => ctrl.start('第一批'))
    try {
      ok(await waitFor(() => factory.created.length === 5 && ctrl.list().length === 5), '第一批已进入启动等待')
      ok(ctrl.runningCount === 5, '已登记的启动任务不再重复计入准备名额')
      const second = Array.from({ length: 19 }, () => ctrl.start('第二批'))
      ok(!(await ctrl.start('超额')).ok, '交错启动仍拒绝第25个任务')
      release()
      ok((await Promise.all([...first, ...second])).every(result => result.ok) && ctrl.runningCount === 24, '两批共24个均可启动')
    } finally {
      release()
      await Promise.all(first)
      await ctrl.stopAll()
    }
  }

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

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    ctrl.setContext({ cwd: 'C:/proj-a', parentSessionId: '01a14877-aaaa', parentRunId: 'r1', parentGeneration: 3, parentMessageId: 'm1', projectId: 'p1' })
    ctrl.setContext({ cwd: 'C:/proj-b' })
    const res = await ctrl.start('没有父会话的派发')
    ok(res.ok === true, '无父会话上下文也能派发', res.error ?? '')
    ok(res.run?.parentSessionId === undefined, '上一次的父会话不残留到新派发', res.run?.parentSessionId)
    ok(res.run?.parentRunId === undefined && res.run?.parentGeneration === undefined, '上一次的父 runner 与代次不残留')
    ok(res.run?.parentMessageId === undefined && res.run?.projectId === undefined, '上一次的消息与项目归属不残留')
    await ctrl.stopAll()
  }

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
    ok(args.includes('--session-dir') && !args.includes('--no-session'), '子代理使用独立原生会话目录', JSON.stringify(args))
    ok(args.includes('--no-skills'), '子代理关闭用户 Skill 自动发现', JSON.stringify(args))
    const at = args.indexOf('--tools')
    ok(at >= 0, '只读子代理把工具白名单交给 pi（--tools）', JSON.stringify(args))
    ok(args[at + 1] === 'read,grep,find,ls', '白名单只含只读工具', args[at + 1])
    ok(!args.includes('write') && !args.includes('edit') && !args.includes('bash'), '白名单里没有写入类工具')
    await ctrl.stopAll()
  }

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

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('统计用量', undefined, 'controlled-cwd')
    const id = res.run?.id
    const rpc = factory.created[0]
    const usage = (input, output) => ({
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { total: 0 }
    })
    rpc.emit('event', { type: 'message_start', message: { role: 'assistant', content: [], usage: usage(10, 5) } })
    rpc.emit('event', { type: 'message_update', message: { role: 'assistant', content: [], usage: usage(100, 50) } })
    rpc.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: usage(100, 50) }
    })
    const run = ctrl.get(id)
    ok(run?.usage?.input === 100 && run?.usage?.output === 50, '流式→final 只算 final，不翻倍', JSON.stringify(run?.usage))
    ok(run?.usage?.reportedMessages === 1, 'reportedMessages 为消息数')

    rpc.emit('event', { type: 'message_start', message: { role: 'assistant', content: [], usage: usage(7, 3) } })
    rpc.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok2' }], usage: usage(7, 3) }
    })
    ok(ctrl.get(id)?.usage?.input === 107, '不同消息相加')
    await ctrl.stopAll()
  }

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({ cwd: 'C:/proj-a', createRpc: factory.createRpc, onChange: () => {}, prepare: fakePrepare })
    const res = await ctrl.start('上下文快照', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    const command = rpc.command.bind(rpc)
    let releaseOld
    let queries = 0
    rpc.command = async type => {
      if (type !== 'get_session_stats') return command(type)
      queries++
      if (queries === 1) return new Promise(resolve => { releaseOld = resolve })
      return { success: true, data: { contextUsage: { tokens: 2000, contextWindow: 8000 } } }
    }
    const end = () => rpc.emit('event', { type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'snapshot' }],
      usage: { input: 50_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 50_100, cost: { total: 0 } }
    } })
    end()
    end()
    ok(await waitFor(() => ctrl.get(res.run.id)?.contextUsage?.tokens === 2000), '助手结束后采集 pi 原生上下文快照')
    ok(ctrl.get(res.run.id)?.usage?.totalTokens === 100_200, '上下文占用不取累计调用 token')
    releaseOld({ success: true, data: { contextUsage: { tokens: 7000, contextWindow: 8000 } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    ok(ctrl.get(res.run.id)?.contextUsage?.tokens === 2000, '迟到的旧上下文响应不覆盖新值')
    ok(ctrl.get(res.run.id)?.contextUsage?.percent === 25, '上下文快照携带窗口占比')
    rpc.command = async type => type === 'get_session_stats' ? { success: false, error: 'unsupported' } : command(type)
    end()
    await new Promise(resolve => setTimeout(resolve, 0))
    ok(ctrl.get(res.run.id)?.contextUsage?.tokens === 2000, '原生查询失败保留最后快照，不用累计值替代')
    await ctrl.stopAll()
  }

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
      message: { role: 'assistant', id: 'm1', content: [], stopReason: 'error', errorMessage: 'WebSocket closed 1012' }
    })
    rpc.emit('event', { type: 'agent_settled' })
    await new Promise((r) => setTimeout(r, 20))
    const resuming = ctrl.get(res.run?.id)
    ok(resuming?.status === 'running' && resuming?.recovery?.resumed === true, '暂态错误且未重试时先自动续跑一次', JSON.stringify({ status: resuming?.status, recovery: resuming?.recovery }))
    rpc.emit('event', {
      type: 'message_end',
      message: { role: 'assistant', id: 'm2', content: [], stopReason: 'error', errorMessage: 'WebSocket closed 1012' }
    })
    rpc.emit('event', { type: 'agent_settled' })
    const run = ctrl.get(res.run?.id)
    ok(run?.status === 'error', '模型报错时终态是 error（不是 done）', String(run?.status))
    ok(run?.latestActivity === '自动续跑 1 次后仍失败', '续跑后仍失败的终态文案', String(run?.latestActivity))
    ok(/服务重启/.test(run?.error ?? '') && /WebSocket closed 1012/.test(run?.error ?? ''), '子代理错误保留服务商原文与可读原因', JSON.stringify(run?.error))
    ok(run?.latestActivity !== '已完成', '列表里的活动也不是「已完成」', String(run?.latestActivity))
    await ctrl.stopAll()
  }

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
    const run = ctrl.list().find((r) => r.task === 'pi 起不来')
    ok(run?.status === 'error', 'run 停在 error（不留在「运行中」）', String(run?.status))
    ok(created[0]?.closed === true, '起不来的进程也被 close 掉')
    await ctrl.stopAll()
  }

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    process.env.YAN_SUBAGENT_TIMEOUT_MS = '200'
    process.env.YAN_SUBAGENT_GRACE_MS = '150'
    const res = await ctrl.start('挂着不动', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    let timedOut = false
    try {
      timedOut = await waitFor(() => {
        const r = ctrl.get(res.run?.id ?? '')
        return r?.status === 'error' && /运行超时/.test(r.error ?? '')
      }, 5000)
    } finally {
      delete process.env.YAN_SUBAGENT_TIMEOUT_MS
      delete process.env.YAN_SUBAGENT_GRACE_MS
    }
    const finalRun = ctrl.get(res.run?.id ?? '')
    ok(timedOut, '收尾宽限内没有结束：转 error 且原因写着运行超时', String(finalRun?.error))
    ok(finalRun?.endReason === 'timeout', '结束原因记为 timeout（界面据此区分超时与其他失败）', String(finalRun?.endReason))
    ok(!/10 分钟|30 分钟/.test(finalRun?.error ?? ''), '提示报的是覆盖后的上限（不是写死的分钟数）')
    ok(rpc?.closed === true, '超时后 pi 子进程被收掉（不留僵尸）')
    await ctrl.stopAll()
  }

  {
    const factory = makeRpcFactory()
    const steers = []
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: (opts) => {
        const rpc = factory.createRpc(opts)
        const inner = rpc.command
        rpc.command = async (type, payload) => {
          if (type === 'steer') steers.push(payload)
          return inner(type, payload)
        }
        return rpc
      },
      onChange: () => {},
      prepare: fakePrepare
    })
    process.env.YAN_SUBAGENT_TIMEOUT_MS = '150'
    process.env.YAN_SUBAGENT_GRACE_MS = '4000'
    const res = await ctrl.start('干到一半', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    const id = res.run?.id ?? ''
    try {
      ok(await waitFor(() => steers.length > 0, 3000), '到点后发出收尾指令（steer）')
      ok(ctrl.get(id)?.status === 'running' && ctrl.get(id)?.wrapUp?.reason === 'timeout', '收尾期间仍在运行并标着 wrapUp', JSON.stringify(ctrl.get(id)?.wrapUp))
      ok(/立刻|不要再调用/.test(String(steers[0]?.message ?? '')), '收尾指令要求立刻交结论')
      rpc.emit('event', { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '已确认 A 一致；B 没来得及核实。' }] } })
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已确认 A 一致；B 没来得及核实。' }], stopReason: 'stop' } })
      rpc.emit('event', { type: 'agent_settled' })
      ok(await waitFor(() => ctrl.get(id)?.status === 'done', 5000), '收尾交出结论后按完成落')
      const done = ctrl.get(id)
      ok(done?.endReason === 'timeout', '结束原因仍是 timeout（不伪装成正常完成）', String(done?.endReason))
      ok(/B 没来得及核实/.test(done?.result?.summary ?? ''), '摘要取收尾时的那段话')
    } finally {
      delete process.env.YAN_SUBAGENT_TIMEOUT_MS
      delete process.env.YAN_SUBAGENT_GRACE_MS
    }
    await ctrl.stopAll()
  }

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: factory.createRpc,
      onChange: () => {},
      prepare: fakePrepare
    })
    process.env.YAN_SUBAGENT_IDLE_MS = '300'
    process.env.YAN_SUBAGENT_GRACE_MS = '200'
    const res = await ctrl.start('慢但有进展', undefined, 'controlled-cwd')
    const rpc = factory.created[0]
    const id = res.run?.id ?? ''
    try {
      ok(ctrl.runs.get(id).totalMs === undefined, '默认没有总时长上限')
      ctrl.runs.get(id).startedAt = Date.now() - 40 * 60_000
      for (let i = 0; i < 4; i += 1) {
        await new Promise((r) => setTimeout(r, 150))
        rpc.emit('event', { type: 'tool_execution_start', toolName: 'read' })
      }
      ok(ctrl.get(id)?.status === 'running' && !ctrl.get(id)?.wrapUp, '持续有动静时不算空闲超时（共 600ms > 300ms 上限）')
      ok(ctrl.get(id)?.toolCalls === 4, '记下已发起的工具调用次数', String(ctrl.get(id)?.toolCalls))
      ctrl.onWatch(ctrl.runs.get(id))
      ok(!ctrl.get(id)?.wrapUp, '持续进展超过旧30分钟期限也不会被截断')
      ok(await waitFor(() => !!ctrl.get(id)?.wrapUp, 3000), '停止输出后进入停滞超时收尾')
      ok(ctrl.get(id)?.status === 'running' && !rpc.closed, '收尾期间保留子进程交出已有结论')
      ok(/停滞超时/.test(ctrl.get(id)?.progressWarning ?? ''), '收尾说明实际停滞原因')
      rpc.emit('event', { type: 'tool_execution_update', toolName: 'read' })
      ok(ctrl.get(id)?.wrapUp?.reason === 'timeout', '迟到工具更新不撤销超时收尾')
      ok(await waitFor(() => rpc.closed), '迟到进展不延长收尾宽限，仍会停止进程')
      ok(ctrl.get(id)?.endReason === 'timeout' && /停滞超时/.test(ctrl.get(id)?.error ?? ''), '停止后保留停滞原因与timeout身份')
    } finally {
      delete process.env.YAN_SUBAGENT_IDLE_MS
      delete process.env.YAN_SUBAGENT_GRACE_MS
    }
    await ctrl.stopAll()
  }

  {
    const factory = makeRpcFactory()
    process.env.YAN_SUBAGENT_IDLE_MS = '1000'
    process.env.YAN_SUBAGENT_TIMEOUT_MS = '250'
    process.env.YAN_SUBAGENT_GRACE_MS = '70'
    const ctrl = new SubagentController({ cwd: 'C:/proj-a', createRpc: factory.createRpc, onChange: () => {}, prepare: fakePrepare })
    try {
      const res = await ctrl.start('工具静默，但总时长仍有效', undefined, 'controlled-cwd', { timeoutMinutes: 15 })
      const id = res.run.id
      ok(await waitFor(() => ctrl.get(id)?.status === 'error'), '显式总期限仍能先于停滞期限终止任务')
      ok(/运行超时/.test(ctrl.get(id)?.error ?? '') && factory.created[0].closed, '终止原因是总时长，且清理子进程')
    } finally {
      delete process.env.YAN_SUBAGENT_IDLE_MS
      delete process.env.YAN_SUBAGENT_TIMEOUT_MS
      delete process.env.YAN_SUBAGENT_GRACE_MS
      await ctrl.stopAll()
    }
  }

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({ cwd: 'C:/events', createRpc: factory.createRpc, onChange: () => {}, prepare: fakePrepare })
    const started = await ctrl.start('事件边界', undefined, 'controlled-cwd')
    const run = ctrl.runs.get(started.run.id)
    try {
      ok(run.idleMs === 10 * 60_000 && run.graceMs === 75_000, '默认停滞10分钟、收尾75秒')
      run.lastProgressAt = Date.now() - run.idleMs - 1
      const stale = run.lastProgressAt
      factory.created[0].emit('event', { type: 'response', success: true })
      ok(run.lastProgressAt === stale, '状态响应不能冒充模型或工具进展')
      factory.created[0].emit('event', { type: 'message_update', message: { role: 'assistant', content: [] } })
      ctrl.onWatch(run)
      ok(!run.wrapUp && run.lastProgressAt > stale, '模型流式输出重置停滞时钟')
      run.lastProgressAt = Date.now() - run.idleMs - 1
      ctrl.onWatch(run)
      ok(run.wrapUp?.reason === 'timeout' && /10 分钟/.test(run.progressWarning), '默认10分钟停滞触发实际超时收尾')
    } finally { await ctrl.stopAll() }
  }

  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({ cwd: 'C:/events', createRpc: factory.createRpc, onChange: () => {}, prepare: fakePrepare })
    const started = await ctrl.start('长命令', undefined, 'controlled-cwd')
    const run = ctrl.runs.get(started.run.id)
    try {
      const rpc = factory.created[0]
      rpc.emit('event', { type: 'tool_execution_start', toolName: 'bash', toolCallId: 't1' })
      run.lastProgressAt = Date.now() - run.idleMs - 1
      ctrl.onWatch(run)
      ok(!run.wrapUp, '工具仍在执行时，超过基础停滞期限不收尾')
      run.lastProgressAt = Date.now() - run.idleMs * 6 - 1
      ctrl.onWatch(run)
      ok(run.wrapUp?.reason === 'timeout', '工具执行也有放宽后的兜底期限')
    } finally { await ctrl.stopAll() }
  }

  {
    const factory = makeRpcFactory()
    const steers = []
    const ctrl = new SubagentController({
      cwd: 'C:/proj-a',
      createRpc: (opts) => {
        const rpc = factory.createRpc(opts)
        const inner = rpc.command
        rpc.command = async (type, payload) => {
          if (type === 'steer') steers.push(payload)
          return inner(type, payload)
        }
        return rpc
      },
      onChange: () => {},
      prepare: fakePrepare
    })
    const res = await ctrl.start('只许查五次', undefined, 'controlled-cwd', { goal: '只许查五次', maxToolCalls: 5 })
    const rpc = factory.created[0]
    const id = res.run?.id ?? ''
    for (let i = 0; i < 350; i += 1) rpc.emit('event', { type: 'tool_execution_start', toolName: 'read' })
    ok(steers.length === 0 && !ctrl.get(id)?.wrapUp, '超过旧参数和旧300次上限也不被宿主收尾')
    ok(ctrl.get(id)?.toolCalls === 350, '统计所有调用供用户查看')
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => ctrl.get(id)?.status === 'done', 5000) && ctrl.get(id)?.endReason === 'completed', '自主结束标为正常完成', String(ctrl.get(id)?.endReason))
    await ctrl.stopAll()
  }

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

      await ctrl.stopAll()
      const after = ctrl.get(run.id)
      ok(after?.review === 'archived', '退出时把未审阅的 worktree 归档', after?.review)
      ok(after?.diff?.files === 1, '归档摘要记录了改动文件', JSON.stringify(after?.diff))
      ok(!!after?.resultPath && existsSync(after.resultPath), '退出后保留可追溯的补丁', after?.resultPath)
      ok(!existsSync(run.cwd), '退出后临时 worktree 已删除')

      await ctrl.stopAll()
      ok(ctrl.get(run.id)?.review === 'archived', '重复退出保持归档状态')
      const history = new SubagentController({ cwd: 'C:/unrelated-current-project', archiveDir: archive, onChange: () => {} })
      await history.loadHistory()
      ok(history.get(run.id)?.review === 'archived' && history.get(run.id)?.diff?.files === 1, '重启后保留归档补丁与审阅状态')
      const merged = await history.merge(run.id)
      ok(merged.ok && existsSync(join(root, 'new.txt')), '历史合并应用到原 rootCwd，不使用当前项目或旧 worktree')
      ok((await history.merge(run.id)).ok, '历史合并审阅状态持久化且重复操作不重复套补丁')
      await history.discard(run.id)
      ok(existsSync(join(root, 'new.txt')) && history.get(run.id)?.review === 'discarded', '历史放弃不清理旧 cwd 或删除原项目，调用快照仍保留')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  {
    const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-emit-'))
    const factory = makeRpcFactory()
    let throwing = true
    const ctrl = new SubagentController({
      cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
      onChange: () => { if (throwing) throw new Error('推送处理器崩了') }
    })
    try {
      const started = await ctrl.start('推送失败不影响运行', undefined, 'controlled-cwd')
      ok(started.ok, '推送回调抛错不打断启动', started.error)
      throwing = false
      const rpc = factory.created[0]
      rpc.command = async (type, payload, options) => {
        if (type === 'abort') {
          ok(options?.timeoutMs === 5_000, 'abort 带 5 秒超时，不会按默认 30 秒挂住退出')
          return { success: true }
        }
        return { success: true }
      }
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } }
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第一版结论' }], usage } })
      ok(ctrl.get(started.run.id)?.result?.summary.includes('第一版结论'), '结果摘要来自最后一条助手消息')
      ok(ctrl.get(started.run.id)?.toolCalls === 0, '推送回调抛错后仍继续处理事件')
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '第二版结论' }], usage } })
      ok(ctrl.get(started.run.id)?.result?.summary.includes('第二版结论'), '摘要缓存随新消息失效')
      const stopStarted = Date.now()
      ok((await ctrl.stop(started.run.id)).ok && Date.now() - stopStarted < 2_000, 'abort 立即返回时停止很快结束')

      const liveFactory = makeRpcFactory()
      const live = new SubagentController({ cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: liveFactory.createRpc, onChange: () => {} })
      const liveRun = await live.start('收尾期间放弃改动', undefined, 'controlled-cwd')
      liveFactory.created[0].emit('event', { type: 'agent_settled', aborted: false })
      const discarded = await live.discard(liveRun.run.id)
      ok(discarded.ok, '收尾期间放弃改动不抛错', discarded.error)
      ok(await waitFor(() => live.get(liveRun.run.id)?.review === 'discarded'), '放弃标记不被收尾覆盖', live.get(liveRun.run.id)?.review)

      const stale = { id: 'sub-1234abcd', task: '旧记录', cwd: archive, rootCwd: archive, startedAt: 1_000, status: 'done',
        isolation: 'shared-cwd', review: 'none', transcript: [], toolCalls: 0, schemaVersion: 1, hidden: false,
        limits: { totalMs: 1_000, stallTimeoutMs: 2_000, graceMs: 3_000 }, patchPath: join(archive, 'old.patch') }
      await writeFile(join(archive, 'sub-1234abcd.json'), JSON.stringify(stale), 'utf8')
      const reloaded = new SubagentController({ cwd: archive, archiveDir: archive, onChange: () => {} })
      await reloaded.loadHistory()
      const loaded = reloaded.get('sub-1234abcd')
      ok(!!loaded && loaded.status === 'done', '历史记录可读回')
      ok(!('limits' in loaded) && !('patchPath' in loaded) && !('schemaVersion' in loaded), '读回的历史不带写入专用字段', Object.keys(loaded).join(','))
    } finally {
      await rm(archive, { recursive: true, force: true })
    }
  }
}
