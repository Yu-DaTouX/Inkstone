import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTest, runSuite } from './lib/test-suite.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await runSuite(import.meta.url, async (ok, compile) => {
  const { WorkflowService } = await compile('src/main/workflows/service.ts')
  const { workflowPhaseStats } = await compile('src/shared/workflows.ts')
  const dir = await mkdtemp(join(tmpdir(), 'yan-workflow-model-service-'))
  const workerPath = join(dir, 'workflow-worker.mjs')
  await buildTest('src/main/workflows/worker.ts', workerPath)
  const project = join(dir, 'project')
  await mkdir(join(project, 'in'), { recursive: true })
  for (let i = 0; i < 3; i++) await writeFile(join(project, 'in', `${i}.txt`), `段${i}`, 'utf8')
  const calls = []
  const pushes = []
  const sent = []
  let fail = true
  let live = 0
  let peak = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const target = { getState: () => ({ isAgentRunning: false }), holdsNotices: () => false, send: async (text) => (sent.push(text), { ok: true }) }
  const service = new WorkflowService({
    root: join(dir, 'runs'),
    workerPath,
    subagentCommand: async () => { throw new Error('不应派子代理') },
    getSubagent: async () => undefined,
    runningSubagents: () => 24,
    modelHost: {
      call: async (req) => {
        calls.push(req)
        if (req.prompt.startsWith('并发')) {
          live += 1
          peak = Math.max(peak, live)
          await gate
          live -= 1
          return { text: req.prompt, model: req.model, stopReason: 'stop', durationMs: 1 }
        }
        await delay(5)
        if (fail && req.prompt === '段2') throw Object.assign(new Error('401 Incorrect API key provided'), { kind: 'model' })
        return { text: `EN ${req.prompt}`, model: req.model, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, stopReason: 'stop', durationMs: 5 }
      }
    },
    findTarget: (view) => (view.sessionId === 's1' ? target : null),
    push: (view) => pushes.push(view),
    slotPollMs: 20,
    noticePollMs: 10,
    pushDelayMs: 5
  })
  const ctx = { cwd: project, model: 'fake/session', parentSessionId: 's1', parentRunId: 'run-1', parentGeneration: 1, parentMessageId: 'a1' }
  const script = join(project, 'wf.js')
  await writeFile(script, [
    `export const meta = { name: 'tr', description: '翻译' }`,
    `const files = await listFiles('in')`,
    `const out = await pipeline(files, async (f) => { const t = await model(await readText(f)); await writeText('out/' + f.slice(3), t); return f })`,
    `return out`
  ].join('\n'), 'utf8')
  const waitDone = async (id, attempt) => {
    for (let i = 0; i < 300; i++) {
      const view = (await service.list()).find((run) => run.id === id)
      if (view && view.attempt === attempt && (view.status === 'done' || view.status === 'failed')) return view
      await delay(10)
    }
    throw new Error('等待工作流结束超时')
  }

  try {
    let error
    try {
      await service.run('workflow.run', { file: script, 'model-concurrency': 33 }, ctx)
    } catch (e) {
      error = e
    }
    ok(/model-concurrency 必须是 1–32/.test(error?.message ?? ''), '--model-concurrency 超过 32 被拒', error?.message)

    const started = await service.run('workflow.run', { file: script, 'model-concurrency': 12 }, ctx)
    ok(started.summary.modelConcurrency === 12, '运行摘要带 modelConcurrency', JSON.stringify(started.summary))
    const id = started.summary.id
    const view = await waitDone(id, 1)
    ok(view.status === 'done' && view.modelConcurrency === 12, '子代理名额全满（24/24）时 model() 工作流照样跑完', JSON.stringify({ status: view.status, error: view.error }))
    ok(calls.length === 3 && calls.every((c) => c.model === 'fake/session'), '默认用发起会话的模型', JSON.stringify(calls.map((c) => c.model)))
    ok(view.models?.total === 3 && view.models.done === 2 && view.models.failed === 1 && view.agents.length === 0, '运行视图带 model() 完成/失败计数', JSON.stringify(view.models))
    ok(pushes.some((push) => push.id === id && push.models?.total >= 1), '计数随现有进度推送发给界面')
    const phase = workflowPhaseStats({ ...view, declaredPhases: [] })
    ok(phase.length === 1 && phase[0].total === 3 && phase[0].done === 2 && phase[0].failed === 1, 'model() 计入运行卡的阶段进度条', JSON.stringify(phase))
    ok((await readFile(join(project, 'out', '0.txt'), 'utf8')) === 'EN 段0', '结果写进项目')
    const got = await service.run('workflow.get', { id }, ctx)
    ok(got.summary.models?.done === 2 && got.summary.models.failed === 1, 'workflow get 摘要带 model() 计数', JSON.stringify(got.summary.models))
    const listed = await service.run('workflow.list', {}, ctx)
    ok(listed.summary.runs[0].models === 3 && listed.summary.runs[0].modelsDone === 2 && listed.summary.runs[0].modelsFailed === 1, 'workflow list 带 model() 计数', JSON.stringify(listed.summary.runs[0]))
    for (let i = 0; i < 100 && !sent.length; i++) await delay(10)
    ok(sent.some((text) => /3 个 model\(\) 调用，完成 2，失败或停止 1/.test(text)), '完成通知写明 model() 计数', sent[0]?.slice(0, 200))
    const failedAt = view.models.cells?.indexOf('f') ?? -1
    ok(view.models.cells?.length === 3 && failedAt >= 0 && view.models.cells.replace('f', '') === 'dd', '运行视图带每次调用一格的状态串', view.models.cells)
    ok(view.models.failures?.length === 1 && view.models.failures[0].index === failedAt && /401 Incorrect API key/.test(view.models.failures[0].error), '失败列表带错误原文', JSON.stringify(view.models.failures))
    ok(view.models.latest && view.models.latest.text.startsWith('EN 段') && view.models.latest.text.length <= 121, '最近一条完成的抽查', JSON.stringify(view.models.latest))
    const failedCall = await service.modelCall(id, failedAt)
    ok(failedCall?.status === 'failed' && /401/.test(failedCall.error ?? '') && typeof failedCall.startedAt === 'number' && typeof failedCall.endedAt === 'number', '结束后按序号查单次调用（内存保留）', JSON.stringify(failedCall))
    ok(await service.modelCall(id, 3) === null && await service.modelCall('wf-00000000', 0) === null, '越界序号与未知运行返回空')

    fail = false
    const before = calls.length
    const resumed = await service.run('workflow.resume', { id, 'model-concurrency': 4 }, ctx)
    ok(resumed.summary.savedModelResults === 2, 'resume 摘要写明可沿用的 model() 结果数', JSON.stringify(resumed.summary))
    const again = await waitDone(id, 2)
    ok(again.status === 'done' && calls.length - before === 1 && calls.at(-1).prompt === '段2' && again.modelConcurrency === 4, 'resume 只重调失败的 model()，并接受新的 --model-concurrency', JSON.stringify({ n: calls.length - before, models: again.models }))
    ok(again.models.cached === 2 && again.models.done === 1, '续跑后的计数：沿用 2、新完成 1', JSON.stringify(again.models))
    ok(again.models.cells?.length === 3 && again.models.cells.split('').filter((c) => c === 'c').length === 2 && !again.models.failures, '续跑后状态串：沿用 2 格、无失败', again.models.cells)
    for (let i = 0; i < 200; i++) {
      const saved = JSON.parse(await readFile(join(again.dir, 'run.json'), 'utf8').catch(() => '{}'))
      if (saved.view?.status === 'done' && saved.view.attempt === 2) break
      await delay(10)
    }
    const reloaded = new WorkflowService({ root: join(dir, 'runs'), workerPath, subagentCommand: async () => { throw new Error('不应派子代理') }, getSubagent: async () => undefined, runningSubagents: () => 0, push: () => undefined, findTarget: () => null })
    const fromJournal = await reloaded.modelCall(id, failedAt)
    ok(fromJournal?.status === 'done' && typeof fromJournal.endedAt === 'number', '重启后从 journal 查单次调用', JSON.stringify(fromJournal))
    const journal = (await readFile(join(again.dir, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    ok(journal.filter((line) => line.kind === 'io' && line.op === 'write').length === 5, 'journal 记了两次运行的写入（2 + 3）')

    const tune = join(project, 'tune.js')
    await writeFile(tune, [
      `export const meta = { name: 'tune', description: '调并发' }`,
      `return await pipeline(Array.from({ length: 12 }, (_, i) => i), (i) => model('并发' + i))`
    ].join('\n'), 'utf8')
    const waitLive = async (n) => {
      for (let i = 0; i < 300 && live < n; i++) await delay(10)
      await delay(30)
      return live
    }
    const tuneId = (await service.run('workflow.run', { file: tune, 'model-concurrency': 2 }, ctx)).summary.id
    ok(await waitLive(2) === 2, '按 --model-concurrency 2 同时跑 2 个', String(live))
    await service.run('workflow.pause', { id: tuneId }, ctx)
    let liveError
    try {
      await service.run('workflow.resume', { id: tuneId, file: tune, 'model-concurrency': 5 }, ctx)
    } catch (e) {
      liveError = e
    }
    ok(/--file 和 --args/.test(liveError?.message ?? ''), '运行还在内存里时带 --file 明确报错，不再静默忽略', liveError?.message)
    const unpaused = await service.run('workflow.resume', { id: tuneId, 'model-concurrency': 5 }, ctx)
    ok(unpaused.data.status === 'running' && unpaused.data.modelConcurrency === 5 && await waitLive(5) === 5 && peak === 5, '暂停后 resume 带 --model-concurrency 5 立即生效', JSON.stringify({ live, peak, mc: unpaused.data.modelConcurrency }))
    const retuned = await service.run('workflow.resume', { id: tuneId, 'model-concurrency': 8 }, ctx)
    ok(retuned.data.modelConcurrency === 8 && await waitLive(8) === 8, '运行中 resume 只带并发参数时当场调大', JSON.stringify({ live, mc: retuned.data.modelConcurrency }))
    let runningError
    try {
      await service.run('workflow.resume', { id: tuneId }, ctx)
    } catch (e) {
      runningError = e
    }
    ok(runningError?.code === 'workflow_running' || /正在运行/.test(runningError?.message ?? ''), '运行中不带参数的 resume 照旧拒绝', runningError?.message)
    release()
    const tuned = await waitDone(tuneId, 1)
    ok(tuned.status === 'done' && tuned.models.done === 12 && tuned.modelConcurrency === 8, '调并发后跑完，记录新的并发', JSON.stringify({ status: tuned.status, models: tuned.models, mc: tuned.modelConcurrency }))

    const gapRoot = join(dir, 'gap-runs')
    const gapId = 'wf-0a0b0c0d'
    const gapDir = join(gapRoot, 's9', gapId)
    await mkdir(gapDir, { recursive: true })
    const gapView = { id: gapId, sessionId: 's9', cwd: project, name: 'gap', description: 'gap', declaredPhases: [], status: 'stopped', startedAt: 1, endedAt: 2, attempt: 2, concurrency: 8, agents: [], logs: [], dir: gapDir, models: { total: 6, done: 2, cached: 0, failed: 1, stopped: 3, running: 0, queued: 0, cells: 'dsdsfs' } }
    await writeFile(join(gapDir, 'run.json'), JSON.stringify({ view: gapView, context: { cwd: project } }), 'utf8')
    const longError = 'model() 调用 "c4" 失败：401 Bearer abcdefghijklmnop https://api.example.com/v1?key=supersecret123 sk-abcdefghijkl ' + '错'.repeat(3000)
    const lines = [
      { kind: 'model', seq: 3, index: 0, hash: 'h0', status: 'done', attempt: 1, at: 50, label: 'old-attempt', result: 'x' },
      { kind: 'model', seq: 3, index: 0, hash: 'h0', status: 'done', attempt: 2, at: 100, label: 'c0', result: 'x' },
      { kind: 'model', seq: 7, index: 2, hash: 'h2', status: 'done', attempt: 2, at: 120, label: 'c2', result: 'y' },
      { kind: 'model', seq: 9, index: 4, hash: 'h4', status: 'failed', attempt: 2, at: 130, label: 'c4', error: longError },
      { kind: 'model', seq: 11, hash: 'h5', status: 'done', attempt: 2, at: 140, label: 'no-index', result: 'z' }
    ]
    await writeFile(join(gapDir, 'journal.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
    const gapService = new WorkflowService({ root: gapRoot, workerPath, subagentCommand: async () => { throw new Error('不应派子代理') }, getSubagent: async () => undefined, runningSubagents: () => 0, push: () => undefined, findTarget: () => null })
    const c0 = await gapService.modelCall(gapId, 0)
    const c1 = await gapService.modelCall(gapId, 1)
    const c2 = await gapService.modelCall(gapId, 2)
    const c4 = await gapService.modelCall(gapId, 4)
    const c5 = await gapService.modelCall(gapId, 5)
    ok(c0?.label === 'c0' && c0.endedAt === 100 && c0.status === 'done', '有缺口的 journal：按 index 取本次 attempt 的记录', JSON.stringify(c0))
    ok(c1 === null && c5 === null, '缺口处（停止时排队、没写 journal）与没有 index 的旧记录返回空，不错行', JSON.stringify({ c1, c5 }))
    ok(c2?.label === 'c2' && c4?.label === 'c4' && c4.status === 'failed', '缺口之后的序号仍对得上', JSON.stringify({ c2: c2?.label, c4: c4?.label }))
    ok([...c4.error].length <= 1001 && !/abcdefghijklmnop|supersecret123|sk-abcdefghijkl/.test(c4.error) && c4.error.includes('[redacted]'), 'journal 里的错误截到 1000 字并脱敏', c4.error.slice(0, 160))
    await rm(join(gapDir, 'journal.jsonl'))
    const cachedHit = await gapService.modelCall(gapId, 2)
    ok(cachedHit?.label === 'c2', '第一次读出后整表缓存，之后不再读 journal')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
