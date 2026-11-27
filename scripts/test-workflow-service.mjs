import './lib/test-isolate.mjs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTest, runSuite } from './lib/test-suite.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const barrier = () => {
  let release
  const done = new Promise((resolve) => { release = resolve })
  return { done, release }
}

function fakeSubagents(service) {
  const runs = new Map()
  let counter = 0
  let clock = 5000
  const fake = {
    runs,
    contexts: [],
    hang: false,
    finish(id, status = 'done', text) {
      const run = runs.get(id)
      if (!run || (run.status !== 'running' && run.status !== 'starting')) return
      run.status = status
      run.endedAt = ++clock
      if (text !== undefined) run.transcript.push({ role: 'assistant', text })
      service()?.onSubagentFinished({ ...run, transcript: [...run.transcript] })
    },
    running: () => [...runs.values()].filter((run) => run.status === 'running').length,
    command: async (command, params, context) => {
      fake.contexts.push({ command, context })
      if (command === 'subagent.start') {
        const run = { id: `sub-${++counter}`, task: params.task, parentSessionId: context.parentSessionId, parentRunId: context.parentRunId, parentMessageId: context.parentMessageId, status: 'running', transcript: [], startedAt: ++clock, isolation: params.isolation === 'worktree' ? 'worktree' : 'shared-cwd', review: params.isolation === 'worktree' ? 'pending' : 'none', diff: params.isolation === 'worktree' ? { files: 1, additions: 2, deletions: 0 } : undefined }
        runs.set(run.id, run)
        if (!fake.hang) setTimeout(() => fake.finish(run.id, 'done', `答:${params.task.split('\n')[0]}`), 5)
        return { data: run, summary: { kind: 'subagent', action: 'start', id: run.id } }
      }
      if (command === 'subagent.stop') {
        fake.finish(params.id, 'cancelled')
        return { summary: { id: params.id } }
      }
      if (command === 'subagent.send') return { summary: { id: params.id } }
      throw new Error(`unexpected ${command}`)
    }
  }
  return fake
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { WorkflowService } = await compile('src/main/workflows/service.ts')
  const dir = await mkdtemp(join(tmpdir(), 'yan-workflow-service-'))
  const workerPath = join(dir, 'workflow-worker.mjs')
  await buildTest('src/main/workflows/worker.ts', workerPath)
  const root = join(dir, 'runs')
  const project = join(dir, 'project')
  const sent = []
  const pushes = []
  let busy = false
  const target = { getState: () => ({ isAgentRunning: busy }), holdsNotices: () => false, send: async (text, _images, mode) => (sent.push({ text, mode }), { ok: true }) }
  let service
  const fake = fakeSubagents(() => service)
  let lookup = async (id) => fake.runs.get(id)
  const modelCalls = []
  let modelGate
  const make = () => new WorkflowService({
    root,
    workerPath,
    subagentCommand: fake.command,
    getSubagent: (id) => lookup(id),
    modelHost: { call: async (req) => {
      modelCalls.push(req.prompt)
      if (modelGate) await modelGate.done
      return { text: req.prompt, model: req.model, stopReason: 'stop', durationMs: 1 }
    } },
    runningSubagents: fake.running,
    findTarget: (view) => (view.sessionId === 's1' ? target : null),
    push: (view) => pushes.push(view),
    waitPollMs: 50,
    slotPollMs: 20,
    noticePollMs: 10,
    pushDelayMs: 5
  })
  service = make()
  const ctx = { cwd: project, parentSessionId: 's1', parentRunId: 'run-1', parentGeneration: 1, parentMessageId: 'a7' }
  const other = { cwd: project, parentSessionId: 's2', parentRunId: 'run-2', parentGeneration: 1 }
  const waitFor = async (check, label, ms = 20000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await check()) return true
      await delay(10)
    }
    throw new Error(`等待超时：${label}`)
  }
  const fails = async (promise, pattern) => {
    try {
      await promise
      return false
    } catch (error) {
      return pattern.test(String(error?.message ?? error))
    }
  }

  try {
    await writeFile(join(dir, 'placeholder'), '')
    await mkdir(project, { recursive: true })
    const script = `export const meta = { name: '三阶段', description: '测试', phases: ['甲', '乙'] }
phase('甲')
const a = await agent('A', { label: 'a' })
phase('乙')
const rest = await parallel([agent('B'), agent('C', { isolation: 'worktree' })])
return { a, rest }
`
    await writeFile(join(project, 'wf.js'), script)

    ok(await fails(service.run('workflow.run', {}, ctx), /--file/), '缺 --file 报错')
    await writeFile(join(project, 'bad.js'), `const x = 1`)
    ok(await fails(service.run('workflow.run', { file: 'bad.js' }, ctx), /首条语句/), 'meta 不合法时不启动')
    ok(await fails(service.run('workflow.run', { file: 'wf.js', args: '{bad' }, ctx), /--args/), 'args 不是 JSON 时报错')
    ok(await fails(service.run('workflow.run', { file: 'wf.js', concurrency: 25 }, ctx), /concurrency/), 'concurrency 超过 24 报错')

    const started = await service.run('workflow.run', { file: 'wf.js' }, ctx)
    const id = started.summary.id
    ok(/^wf-[0-9a-f]{8}$/.test(id) && started.summary.status === 'running' && started.summary.concurrency === 8 && /不要 sleep/.test(started.summary.note), '启动后立刻返回运行 ID，默认并发 8', JSON.stringify(started.summary))
    const runDir = join(root, 's1', id)
    ok(started.summary.dir === runDir && (await readdir(runDir)).includes('script.js'), '运行目录在 <根>/<会话ID>/<运行ID>/ 并保存脚本')

    await waitFor(() => sent.length === 1, '完成通知')
    const view = (await service.list()).find((item) => item.id === id)
    ok(view.status === 'done' && view.agents.length === 3 && view.agents.every((agent) => agent.status === 'done'), '运行完成，三个子代理都完成', JSON.stringify(view))
    ok(view.parentMessageId === 'a7' && view.sessionId === 's1', '运行记录挂在发起它的会话与消息上')
    ok(fake.contexts.filter((item) => item.command === 'subagent.start').every((item) => item.context.parentMessageId === `workflow:${id}` && item.context.parentSessionId === 's1'), '子代理以工作流锚点启动，归属仍是发起会话')
    ok(service.owns({ parentMessageId: `workflow:${id}` }) && !service.owns({ parentMessageId: 'a7' }), '能区分工作流的子代理')
    const notice = sent[0]
    ok(notice.mode === 'followUp' && notice.text.startsWith('[砚宿主通知：工作流已完成]') && notice.text.includes('答:A') && notice.text.includes(runDir), '完成通知带最终答案和运行目录，投给发起它的会话')
    ok(/sub-3「/.test(notice.text) && notice.text.includes('yan subagent merge --id sub-3'), '通知列出 worktree 子代理待处置')
    const result = JSON.parse(await readFile(join(runDir, 'result.json'), 'utf8'))
    ok(result.ok === true && result.result.a === '答:A', 'result.json 保存最终结果')
    const journal = (await readFile(join(runDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    ok(journal.filter((line) => line.status === 'done').length === 3, 'journal.jsonl 记录每次调用')
    ok(pushes.some((item) => item.id === id && item.status === 'running') && pushes.at(-1).status === 'done', '运行状态推给界面')

    const got = await service.run('workflow.get', { id }, ctx)
    ok(got.summary.status === 'done' && got.summary.done === 3 && got.summary.phases.map((phase) => `${phase.title}:${phase.done}/${phase.total}`).join() === '甲:1/1,乙:2/2' && /答:A/.test(got.summary.result), 'get 返回阶段进度和结果摘要', JSON.stringify(got.summary))
    ok(got.data.result.a === '答:A', 'get 的结果文件里有完整结果')
    ok((await service.run('workflow.list', {}, ctx)).summary.count === 1 && (await service.run('workflow.list', {}, other)).summary.count === 0, 'list 只列本会话的工作流')
    ok(await fails(service.run('workflow.get', { id }, other), /找不到当前会话的工作流/), '别的会话看不到这个工作流')
    ok(await fails(service.run('workflow.get', { id: 'nope' }, ctx), /合法的工作流 id/), '非法 ID 报错')
    ok(await fails(service.run('workflow.pause', { id }, ctx), /没有在运行/), '已结束的运行不能暂停')

    const startsBefore = fake.contexts.filter((item) => item.command === 'subagent.start').length
    const resumed = await service.run('workflow.resume', { id }, ctx)
    ok(resumed.summary.attempt === 2 && resumed.summary.savedResults === 3, '已完成的运行也能按记录重放', JSON.stringify(resumed.summary))
    await waitFor(() => sent.length === 2, '重放后的通知')
    ok(fake.contexts.filter((item) => item.command === 'subagent.start').length === startsBefore, '重放时序号和提示词没变的调用全部直接返回')

    fake.hang = true
    await writeFile(join(project, 'slow.js'), `export const meta = { name: '慢', description: '会被停' }\nconst r = await parallel([agent('X'), agent('Y')])\nreturn r\n`)
    const slow = (await service.run('workflow.run', { file: join(project, 'slow.js') }, ctx)).summary.id
    await waitFor(async () => (await service.list()).find((item) => item.id === slow)?.agents.filter((agent) => agent.status === 'running').length === 2, '两个子代理在跑')
    const paused = await service.control(slow, 'pause')
    ok(paused.ok && paused.run.status === 'paused', '界面暂停')
    ok((await service.control(slow, 'resume')).ok, '界面继续')
    const stopped = await service.run('workflow.stop', { id: slow }, ctx)
    ok(stopped.summary.status === 'stopped', 'stop 结束运行')
    const slowView = (await service.list()).find((item) => item.id === slow)
    ok(slowView.status === 'stopped' && slowView.agents.every((agent) => agent.status === 'stopped'), '停止后子代理都记为停止')
    await delay(40)
    ok(sent.length === 2, '停止的运行不发完成通知')
    ok((await service.control(slow, 'resume')).ok === false, '界面上的继续不能重启已停止的运行（交给主会话续跑）')

    fake.hang = false
    const resumedSlow = await service.run('workflow.resume', { id: slow }, ctx)
    ok(resumedSlow.summary.savedResults === 0, '被停的调用没有可复用的结果')
    await waitFor(() => sent.length === 3, '续跑完成通知')
    ok(sent[2].text.includes('答:X') && sent[2].text.includes('答:Y'), '停止后续跑把被停的调用重跑完')

    fake.hang = true
    const third = (await service.run('workflow.run', { file: 'slow.js' }, ctx)).summary.id
    await waitFor(async () => (await service.list()).find((item) => item.id === third)?.agents.filter((agent) => agent.status === 'running').length === 2, '第三次运行在跑')
    await waitFor(async () => JSON.parse(await readFile(join(root, 's1', third, 'run.json'), 'utf8')).view.agents.filter((agent) => agent.status === 'running').length === 2, '运行状态写盘')

    const crashed = service
    for (const runner of crashed.runners.values()) {
      runner.finished = true
      runner.abort.abort()
      await runner.worker?.terminate()
    }
    crashed.runners.clear()
    service = make()
    const reloaded = (await service.list()).find((item) => item.id === third)
    ok(reloaded.status === 'interrupted' && /没有自动续跑/.test(reloaded.error), '宿主重启后运行停在原地（interrupted），不自动续跑')
    ok(fake.contexts.filter((item) => item.command === 'subagent.start').length === startsBefore + 6, '重启后没有派新的子代理')
    ok(await fails(service.run('workflow.resume', { id: third }, ctx), /还没退出/), '上次的子代理还在跑时拒绝续跑')
    for (const run of fake.runs.values()) if (run.status === 'running') fake.finish(run.id, 'cancelled')
    fake.hang = false
    await service.run('workflow.resume', { id: third }, ctx)
    await waitFor(() => sent.length === 4, '重启后手动续跑完成')
    ok(sent[3].text.includes('工作流已完成'), '重启后手动续跑能完成并通知')

    busy = true
    await writeFile(join(project, 'quick.js'), `export const meta = { name: '快', description: '忙时完成' }\nreturn await agent('Q')\n`)
    await service.run('workflow.run', { file: 'quick.js', args: { n: 1 } }, ctx)
    await delay(150)
    ok(sent.length === 4, '主会话忙时通知排队')
    busy = false
    await waitFor(() => sent.length === 5, '空闲后投递')
    ok(sent[4].text.includes('答:Q'), '空闲后补投完成通知')

    const pending = { cwd: project, parentSessionId: 'pending:run-9', parentRunId: 'run-9', parentGeneration: 2 }
    const early = (await service.run('workflow.run', { file: 'quick.js' }, pending)).summary.id
    ok(join(root, 'pending_run-9', early) === (await service.list()).find((item) => item.id === early).dir, '会话 ID 未定时按运行实例归档')
    service.adoptSessions([{ runId: 'run-9', generation: 2, sessionId: 's1' }])
    await waitFor(() => (service.retryNotices(), sent.length === 6), '会话确定后投递')
    ok((await service.run('workflow.get', { id: early }, ctx)).summary.id === early, '会话确定后归属转给真实会话')

    fake.hang = true
    const entered = barrier()
    const readGate = barrier()
    lookup = async (subagentId) => {
      entered.release()
      await readGate.done
      return fake.runs.get(subagentId)
    }
    const firstResume = service.run('workflow.resume', { id: early, file: 'slow.js' }, ctx)
    await entered.done
    const rejected = await fails(service.run('workflow.resume', { id: early, file: 'slow.js' }, ctx), /正在准备续跑/)
    readGate.release()
    ok((await firstResume).summary.attempt === 2 && rejected, '并发 resume 仅一个请求取得同 ID 的启动权')
    lookup = async (subagentId) => fake.runs.get(subagentId)
    await waitFor(() => fake.running() === 2, '唯一一个续跑派出两个子代理')
    ok((await service.control(early, 'stop')).run.status === 'stopped' && fake.running() === 0, '停止后同 ID 不遗留被覆盖 runner 的子代理')

    const enteredAgain = barrier()
    const readAgain = barrier()
    lookup = async (subagentId) => {
      enteredAgain.release()
      await readAgain.done
      return fake.runs.get(subagentId)
    }
    const cancelled = fails(service.run('workflow.resume', { id: early }, ctx), /续跑已被停止/)
    await enteredAgain.done
    const stoppingResume = service.control(early, 'stop')
    await delay(0)
    readAgain.release()
    ok(await cancelled && (await stoppingResume).run.attempt === 2 && fake.running() === 0, 'stop 取消尚在读档的续跑，不派活、不增加 attempt')
    lookup = async (subagentId) => fake.runs.get(subagentId)
    fake.hang = false

    const resultWrite = service.writeResult.bind(service)
    const finishing = barrier()
    const writeGate = barrier()
    service.writeResult = async (record, payload) => {
      service.writeResult = resultWrite
      finishing.release()
      await writeGate.done
      await resultWrite(record, payload)
    }
    const handoff = (await service.run('workflow.run', { file: 'quick.js' }, ctx)).summary.id
    await finishing.done
    const duringFinish = service.run('workflow.resume', { id: handoff }, ctx)
    const secondDuringFinish = await fails(service.run('workflow.resume', { id: handoff }, ctx), /正在准备续跑/)
    writeGate.release()
    const resumedHandoff = await duringFinish
    ok(secondDuringFinish && resumedHandoff.summary.attempt === 2 && resumedHandoff.summary.savedResults === 1, '终态写完再交接给唯一的续跑者')
    await waitFor(async () => (await service.list()).find((item) => item.id === handoff)?.status === 'done', '交接后的续跑完成')

    await writeFile(join(project, 'paid.js'), `export const meta = { name: 'paid', description: '仅假模型' }\nreturn await model('paid', { model: 'fake/model' })`)
    const get = (runId) => service.run('workflow.get', { id: runId }, ctx)
    const resume = (runId) => service.run('workflow.resume', { id: runId }, ctx)
    const faultGate = barrier()
    modelGate = faultGate
    const failedRun = (await service.run('workflow.run', { file: 'paid.js' }, ctx)).data
    await waitFor(() => modelCalls.length === 1, '假模型已经派出，等终态写入')
    const journalFile = join(failedRun.dir, 'journal.jsonl')
    const beforeFailure = await readFile(journalFile)
    await rm(journalFile)
    await mkdir(journalFile)
    modelGate = undefined
    faultGate.release()
    const failureSaved = await waitFor(async () => {
      const saved = JSON.parse(await readFile(join(failedRun.dir, 'run.json'), 'utf8'))
      return saved.view.status === 'failed' && saved.view.resumeError
    }, 'journal 写失败的终态已落盘')
    const failedPayload = JSON.parse(await readFile(join(failedRun.dir, 'result.json'), 'utf8'))
    const failedGet = await get(failedRun.id)
    ok(failureSaved && failedPayload.ok === false && /不可恢复/.test(failedPayload.error) && !failedGet.data.hasResult, '调用虽返回但无法写 journal 时不报告成功，终态含失败原因')
    await rm(journalFile, { recursive: true })
    await writeFile(journalFile, beforeFailure)
    service = make()
    ok(await fails(resume(failedRun.id), /不可恢复/) && modelCalls.length === 1, '日志路径恢复并重启后仍拒绝静默重放')

    for (const corruption of ['missing', 'unreadable', 'truncated']) {
      const paid = (await service.run('workflow.run', { file: 'paid.js' }, ctx)).data
      await waitFor(async () => (await get(paid.id)).data.status === 'done', '故障注入前已完成')
      const path = join(paid.dir, 'journal.jsonl')
      const raw = await readFile(path, 'utf8')
      if (corruption === 'truncated') await writeFile(path, raw.slice(0, raw.indexOf('\n') + 1))
      else {
        await rm(path)
        if (corruption === 'unreadable') await mkdir(path)
      }
      const before = modelCalls.length
      const refused = await fails(resume(paid.id), /不可恢复/)
      const result = await get(paid.id)
      ok(refused && result.data.status === 'failed' && result.data.attempt === 1 && modelCalls.length === before, `日志 ${corruption} 时不启动付费调用且明确失败`, JSON.stringify(result.summary))
    }
  } finally {
    service = null
    await rm(dir, { recursive: true, force: true })
  }
})
