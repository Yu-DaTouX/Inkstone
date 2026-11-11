import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const job = (id, command, extra = {}) => ({ id, terminalId: `t-${id}`, owners: ['S:/s/a.jsonl', 'sid-a'], command, cwd: 'C:/p', startedAt: 1000, state: 'running', ...extra })

await runSuite(import.meta.url, async (ok, compile) => {
  const flow = await compile('src/renderer/src/features/session/stop-with-background.ts')
  const views = await compile('src/renderer/src/state/terminal-jobs.ts')

  const harness = (jobs, choice) => {
    const calls = []
    return {
      calls,
      deps: {
        jobs: typeof jobs === 'function' ? jobs : () => jobs,
        confirm: async (summary) => {
          calls.push(['confirm', summary])
          return choice
        },
        abortTurn: async () => {
          calls.push(['abort'])
        },
        stopJob: async (id) => {
          calls.push(['stopJob', id])
          return true
        }
      }
    }
  }

  const none = harness([], 'together')
  ok((await flow.runStopFlow(none.deps)) === 'turn' && none.calls.length === 1 && none.calls[0][0] === 'abort', '没有后台命令：只停回合，不弹确认')
  const finished = harness([job('j1', 'a', { state: 'completed' }), job('j2', 'b', { state: 'stopping' }), job('j3', 'c', { state: 'stopped' })], 'together')
  ok((await flow.runStopFlow(finished.deps)) === 'turn' && finished.calls.every((call) => call[0] === 'abort'), '已结束或正在停止的任务不算运行中，不弹确认')
  const broken = harness(() => {
    throw new Error('boom')
  }, 'together')
  ok((await flow.runStopFlow(broken.deps)) === 'turn' && broken.calls.length === 1, '读不到任务表时照常停回合')

  const jobs = [job('j4', 'npm run dev', { startedAt: 4 }), job('j1', 'python -m http.server\n  8000', { startedAt: 1 }), job('j3', 'x'.repeat(200), { startedAt: 3 }), job('j2', 'tail -f log', { startedAt: 2 }), job('j5', 'sleep 99', { startedAt: 5 })]
  const together = harness(jobs, 'together')
  ok((await flow.runStopFlow(together.deps)) === 'together', '确认一起停止：结果为 together')
  const summary = together.calls[0][1]
  ok(summary.count === 5 && summary.more === 2 && summary.commands.length === 3, '确认框给出数量与前三条摘要')
  ok(summary.commands[0] === 'python -m http.server 8000' && summary.commands[1] === 'tail -f log', '摘要按启动顺序并折叠空白')
  ok(summary.commands[2].length === 80 && summary.commands[2].endsWith('…'), '过长命令截断显示')
  const order = together.calls.map((call) => call[0])
  ok(order.join() === 'confirm,abort,stopJob,stopJob,stopJob,stopJob,stopJob', '先停回合，再逐条停后台命令')
  ok(together.calls.filter((call) => call[0] === 'stopJob').map((call) => call[1]).sort().join() === 'j1,j2,j3,j4,j5', '每个运行中的后台命令都被停止')

  const turnOnly = harness(jobs, 'turn')
  ok((await flow.runStopFlow(turnOnly.deps)) === 'turn' && turnOnly.calls.map((call) => call[0]).join() === 'confirm,abort', '只停止回合：不碰后台命令')
  const cancelled = harness(jobs, 'cancel')
  ok((await flow.runStopFlow(cancelled.deps)) === 'cancelled' && cancelled.calls.map((call) => call[0]).join() === 'confirm', '取消：什么都不停')

  const flaky = harness(jobs.slice(0, 2), 'together')
  const stopped = []
  flaky.deps.stopJob = async (id) => {
    stopped.push(id)
    if (id === 'j1') throw new Error('gone')
    return false
  }
  ok((await flow.runStopFlow(flaky.deps)) === 'together' && stopped.length === 2, '某条停止失败不影响其余，也不抛出')

  const mixed = [job('own', 'own cmd'), job('other', 'other cmd', { owners: ['S:/s/b.jsonl', 'sid-b'] }), job('own-old', 'old', { state: 'completed' })]
  const scoped = views.terminalJobsForView(mixed, { peekedSessionId: null, peekedPath: null, session: { sessionId: 'sid-a', sessionFile: 'S:/s/a.jsonl' } })
  const scopedRun = harness(scoped, 'together')
  await flow.runStopFlow(scopedRun.deps)
  ok(scopedRun.calls.filter((call) => call[0] === 'stopJob').map((call) => call[1]).join() === 'own', '只停止归属于该会话的后台命令')

  const seen = []
  const unsubscribe = flow.subscribeStopConfirm(() => seen.push(flow.stopConfirmSummary()))
  const first = flow.requestStopConfirm({ ids: ['a'], count: 1, commands: ['a'], more: 0 })
  ok(flow.stopConfirmSummary()?.count === 1, '确认请求挂起时可读到摘要')
  const second = flow.requestStopConfirm({ ids: ['b', 'c'], count: 2, commands: ['b', 'c'], more: 0 })
  ok((await first) === 'cancel', '又发起一次停止时，上一次的确认按取消处理')
  flow.answerStopConfirm('together')
  ok((await second) === 'together' && flow.stopConfirmSummary() === null, '回答后确认请求结束')
  const third = flow.requestStopConfirm({ ids: ['d'], count: 1, commands: ['d'], more: 0 })
  flow.answerStopConfirm('cancel')
  ok((await third) === 'cancel', 'Esc 或关闭对应取消')
  flow.answerStopConfirm('together')
  ok(seen.length >= 5, '订阅者在每次变化时被通知')
  unsubscribe()

  const dir = await mkdtemp(join(tmpdir(), 'stop-bg-test-'))
  try {
    const entry = join(dir, 'entry.ts')
    const source = (file) => resolve(file).replace(/\\/g, '/')
    await writeFile(entry, `export * from '${source('src/main/background-bash.ts')}'\nexport * from '${source('src/main/terminal-jobs.ts')}'\n`)
    const host = await compile(entry)
    const owners = { keys: ['S:/s/a.jsonl', 'sid-a'] }
    const notices = []
    const makeContext = (keys) => ({
      ownerKeys: () => keys.keys,
      now: () => Date.now(),
      notify: (text, stillOwner, wake) => notices.push({ text, stillOwner, wake })
    })
    const bash = new host.BackgroundBashCommands(makeContext(owners), 5000)
    const watch = (cmds, id, extra = {}) => cmds.run({ action: 'watch', id, command: 'npm run dev', cwd: 'C:/p', ...extra })
    const tableJob = (id) => host.listTerminalJobs().find((item) => item.id === id)

    const pending = watch(bash, 'bg-aaaa1111')
    await sleep(20)
    const row = host.listTerminalJobs().find((item) => item.kind === 'bash')
    ok(!!row && row.state === 'running' && row.command === 'npm run dev' && row.owners.join() === owners.keys.join(), '后台 bash 登记进任务表，归属会话、带命令')
    const started = Date.now()
    ok(host.stopBackgroundBash(row.id) === true, '按任务编号发出停止')
    const answer = await pending
    ok(answer.summary.stop === true && Date.now() - started < 1000, '挂起的监视立刻收到停止指令')
    ok(tableJob(row.id).state === 'stopping', '任务表标成正在停止')
    const ended = await bash.run({ action: 'end', id: 'bg-aaaa1111', exitCode: 1, notice: '[砚宿主通知：后台终端命令]\n状态：stopped' })
    ok(ended.summary.stopped === true && tableJob(row.id).state === 'stopped' && tableJob(row.id).endedAt !== undefined, '结束后任务表标成已停止')
    ok(notices.length === 1 && notices[0].wake === false, '用户停掉的命令只留通知，不叫醒模型')
    ok(notices[0].stillOwner() === true, '会话没变时通知仍归当前会话')
    owners.keys = ['S:/s/other.jsonl', 'sid-other']
    ok(notices[0].stillOwner() === false, '会话换了通知作废')
    owners.keys = ['S:/s/a.jsonl', 'sid-a']
    ok(host.stopBackgroundBash(row.id) === false, '结束后的任务不能再停')

    notices.length = 0
    const gapped = new host.BackgroundBashCommands(makeContext(owners), 30)
    const naturalAnswer = await watch(gapped, 'bg-bbbb2222')
    ok(naturalAnswer.summary.stop === false, '没人停止时监视到期返回 stop=false，由扩展续订')
    const naturalJob = host.listTerminalJobs().find((item) => item.kind === 'bash' && item.state === 'running')
    ok(!!naturalJob, '续订间隙任务仍在运行中')
    host.markTerminalJobsStopping('')
    ok(tableJob(naturalJob.id).state === 'running', '终端编号为空的批量停止不会误伤 bash 任务')
    ok(host.stopBackgroundBash(naturalJob.id) === true, '续订间隙里发出的停止也能受理')
    ok(tableJob(naturalJob.id).state === 'stopping', '间隙里的停止先记下，等下一次监视带走')

    const sessionA = new host.BackgroundBashCommands(makeContext(owners), 5000)
    const sessionB = new host.BackgroundBashCommands(makeContext({ keys: ['S:/s/b.jsonl', 'sid-b'] }), 5000)
    const pa = watch(sessionA, 'bg-cccc3333')
    const pb = watch(sessionB, 'bg-dddd4444')
    await sleep(20)
    const rowA = host.listTerminalJobs().find((item) => item.kind === 'bash' && item.state === 'running' && item.owners[0] === 'S:/s/a.jsonl')
    host.stopBackgroundBash(rowA.id)
    ok((await pa).summary.stop === true, '停止 A 会话的后台 bash')
    const rowB = host.listTerminalJobs().find((item) => item.kind === 'bash' && item.owners[0] === 'S:/s/b.jsonl' && item.state === 'running')
    ok(!!rowB, 'B 会话的后台 bash 不受影响')
    sessionB.dispose()
    ok((await pb).summary.stop === false && host.listTerminalJobs().find((item) => item.id === rowB.id).state === 'stopped', '会话关闭时释放它的后台 bash 记录')
    sessionA.dispose()

    const early = new host.BackgroundBashCommands(makeContext(owners), 5000)
    const p1 = watch(early, 'bg-eeee5555')
    await sleep(10)
    const earlyJob = host.listTerminalJobs().find((item) => item.kind === 'bash' && item.state === 'running' && item.cwd === 'C:/p')
    host.stopBackgroundBash(earlyJob.id)
    await p1
    const t0 = Date.now()
    const again = await watch(early, 'bg-eeee5555')
    ok(again.summary.stop === true && Date.now() - t0 < 500, '停止指令在两次监视之间到达时，下一次监视立刻拿到')
    await early.run({ action: 'end', id: 'bg-eeee5555' })
    const before = host.listTerminalJobs().length
    const late = await watch(early, 'bg-eeee5555')
    ok(late.summary.stop === false && host.listTerminalJobs().length === before, '命令已结束后迟到的监视不再登记任务')

    let rejected = 0
    for (const params of [{ action: 'nope' }, { action: 'watch', id: '../x' }]) {
      await bash.run(params).catch(() => {
        rejected++
      })
    }
    ok(rejected === 2, '未知动作与非法编号被拒绝')
    ok(host.stopBackgroundBash('term-job-none') === false, '不存在的任务编号停止失败')
    early.dispose()
    bash.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
