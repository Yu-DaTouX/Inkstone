import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTest, runSuite } from './lib/test-suite.mjs'

const META = `export const meta = { name: 't', description: 'd', phases: ['一', '二'] }\n`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeController({ answer, external = 0 } = {}) {
  let live = external
  let maxLive = external
  let counter = 0
  let clock = 1000
  const runs = new Map()
  const listeners = new Set()
  const started = []
  const sent = []
  const stopped = []
  const fake = { gate: null }
  const snapshot = (run) => ({ ...run, transcript: [...run.transcript] })
  const finish = (run, status, text, error) => {
    if (run.status !== 'running') return
    live -= 1
    run.status = status
    run.endedAt = ++clock
    if (text !== undefined) run.transcript.push({ role: 'assistant', text })
    if (error) run.error = error
    for (const fn of [...listeners]) fn(run)
    fake.gate?.notify()
  }
  const schedule = (run) => {
    const plan = answer ? answer(run) : { text: `答:${run.params.task}` }
    if (plan === 'hang') return
    setTimeout(() => finish(run, plan.status ?? 'done', plan.text, plan.error), plan.delay ?? 3)
  }
  Object.assign(fake, {
    running: () => live,
    maxLive: () => maxLive,
    started,
    sent,
    stopped,
    host: {
      start: async (params) => {
        if (fake.refuse && fake.refuse() === true) throw new Error('同时最多运行 24 个子 Agent（当前 24 个），先等一个结束或停掉它')
        live += 1
        maxLive = Math.max(maxLive, live)
        const run = { id: `sub-${++counter}`, params, status: 'running', transcript: [], sends: 0 }
        runs.set(run.id, run)
        started.push(run)
        schedule(run)
        return run.id
      },
      send: async (id, message) => {
        const run = runs.get(id)
        sent.push({ id, message })
        run.status = 'running'
        run.sends += 1
        live += 1
        maxLive = Math.max(maxLive, live)
        schedule(run)
      },
      stop: async (id) => {
        stopped.push(id)
        const run = runs.get(id)
        if (run) finish(run, 'cancelled')
      },
      waitFinished: (id, after, signal) => new Promise((resolve) => {
        const run = runs.get(id)
        if (run && run.status !== 'running' && run.endedAt > after) return resolve(snapshot(run))
        const fn = (changed) => {
          if (changed.id !== id || !(changed.endedAt > after)) return
          listeners.delete(fn)
          resolve(snapshot(changed))
        }
        listeners.add(fn)
        signal.addEventListener('abort', () => {
          listeners.delete(fn)
          resolve(null)
        }, { once: true })
      })
    }
  })
  return fake
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { WorkflowRunner } = await compile('src/main/workflows/runner.ts')
  const { SlotGate } = await compile('src/main/workflows/slots.ts')
  const { readJournal } = await compile('src/main/workflows/journal.ts')
  const { checkWorkflowScript } = await compile('src/main/workflows/script.ts')
  const dir = await mkdtemp(join(tmpdir(), 'yan-workflow-runner-'))
  const workerPath = join(dir, 'workflow-worker.mjs')
  await buildTest('src/main/workflows/worker.ts', workerPath)

  let journals = 0
  const start = ({ body, fake, slots, previous = new Map(), attempt = 1, concurrency = 8, journalFile, argsJson, schemaRetries }) => {
    const checked = checkWorkflowScript(META + body)
    if (!checked.ok) throw new Error(checked.error)
    const file = journalFile ?? join(dir, `journal-${++journals}.jsonl`)
    const gate = slots ?? new SlotGate({ capacity: 24, running: fake.running, pollMs: 20 })
    fake.gate = gate
    let finish
    const outcome = new Promise((resolve) => (finish = resolve))
    const runner = new WorkflowRunner({
      workerPath,
      code: checked.code,
      argsJson,
      journalFile: file,
      attempt,
      concurrency,
      previous,
      host: fake.host,
      slots: gate,
      schemaRetries,
      requeueDelayMs: 5,
      onChange: () => undefined,
      onFinish: (result) => finish(result)
    })
    runner.start()
    return { runner, outcome, file, gate }
  }
  const journalOf = async (file) => readJournal(await readFile(file, 'utf8').catch(() => ''))

  try {
    {
      const fake = fakeController()
      const { outcome, runner, file } = await start({ fake, body: `phase('一')\nconst a = await agent('A', { label: '甲', readOnly: true })\nphase('二')\nconst rest = await parallel([agent('B'), agent('C')])\nreturn [a, ...rest]` })
      const result = await outcome
      ok(result.status === 'done' && JSON.parse(result.json).join() === '答:A,答:B,答:C', '跑通：结果按脚本 return 返回', JSON.stringify(result))
      ok(fake.started[0].params.title === '甲' && fake.started[0].params.readOnly === true, '选项映射成子代理启动参数')
      ok(runner.agents.map((agent) => agent.phase).join() === '一,二,二' && runner.agents.every((agent) => agent.status === 'done' && agent.subagentId), '记录每个调用的阶段、状态与子代理 ID', JSON.stringify(runner.agents))
      const journal = await journalOf(file)
      const first = journal.get(0)
      ok(journal.size === 3 && first.status === 'done' && first.result === '答:A' && first.subagentId === 'sub-1' && /^[0-9a-f]{16}$/.test(first.hash) && first.label === '甲' && first.phase === '一', 'journal 记录序号、哈希、子代理 ID、状态与结果', JSON.stringify(first))
    }

    {
      const fake = fakeController({ answer: () => ({ text: 'x', delay: 15 }) })
      const { outcome } = await start({ fake, concurrency: 3, body: `return (await parallel(Array.from({ length: 10 }, (_, i) => () => agent('t' + i)))).length` })
      const result = await outcome
      ok(result.status === 'done' && result.json === '10' && fake.maxLive() <= 3 && fake.maxLive() === 3, `单次运行并发按设置封顶（最多同时 ${fake.maxLive()} 个）`)
    }

    {
      const fake = fakeController({ answer: () => ({ text: 'x', delay: 8 }), external: 5 })
      const gate = new SlotGate({ capacity: 24, running: fake.running, pollMs: 20 })
      const body = `return (await parallel(Array.from({ length: 40 }, (_, i) => () => agent('t' + i)))).filter(Boolean).length`
      const one = start({ fake, slots: gate, concurrency: 24, body })
      const two = start({ fake, slots: gate, concurrency: 24, body })
      const [a, b] = await Promise.all([one.outcome, two.outcome])
      ok(a.status === 'done' && b.status === 'done' && a.json === '40' && b.json === '40', '两个工作流各 40 个代理全部跑完')
      ok(fake.maxLive() <= 24, `和其他子代理共用 24 个名额，最多同时 ${fake.maxLive()} 个（含 5 个外部子代理）`)
      ok(fake.maxLive() >= 20, '名额能用满，没有过度保守', String(fake.maxLive()))
    }

    {
      const fake = fakeController()
      let refusals = 2
      fake.refuse = () => refusals-- > 0
      const { outcome, runner } = await start({ fake, body: `return await agent('A')` })
      const result = await outcome
      ok(result.status === 'done' && fake.started.length === 1 && runner.agents[0].status === 'done', '启动时撞上名额上限会重新排队，不算失败', JSON.stringify(result))
    }

    {
      const answers = ['没有代码块', '```json\n{"score": "高"}\n```', '说明\n```json\n{"score": 3, "tags": ["a"]}\n```']
      const fake = fakeController({ answer: (run) => ({ text: answers[run.sends] }) })
      const { outcome, runner } = await start({ fake, body: `return await agent('评分', { schema: { type: 'object', required: ['score'], properties: { score: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } })` })
      const result = await outcome
      ok(result.status === 'done' && JSON.parse(result.json).score === 3, 'schema：校验不过时续接同一子代理，通过后返回 JSON', JSON.stringify(result))
      ok(fake.started.length === 1 && fake.sent.length === 2 && fake.sent.every((item) => item.id === 'sub-1'), '续接的是同一个子代理，没有重派')
      ok(/没有 ```json|JSON 代码块/.test(fake.sent[0].message) && /\$\.score 应为 integer/.test(fake.sent[1].message), '续接说明里写了具体错误', fake.sent.map((item) => item.message.split('\n')[0]).join(' | '))
      ok(runner.agents[0].retries === 2, '记录续接次数')
    }

    {
      const fake = fakeController({ answer: () => ({ text: '```json\n{"bad": true}\n```' }) })
      const { outcome } = await start({ fake, body: `const r = await parallel([agent('评分', { schema: { type: 'object', required: ['score'] } })])\nreturn r` })
      const result = await outcome
      ok(result.status === 'done' && result.json === '[null]' && fake.sent.length === 3, 'schema：最多续接 3 次，仍不合格就算失败（parallel 里是 null）', JSON.stringify(result))
    }

    {
      const fake = fakeController({ answer: (run) => (run.params.task === 'B' ? { status: 'error', error: '模型报错' } : { text: `答:${run.params.task}` }) })
      const { outcome } = await start({ fake, body: `const a = await agent('A')\nconst b = await agent('B')\nreturn [a, b]` })
      const result = await outcome
      ok(result.status === 'failed' && /模型报错/.test(result.error), '直接 await 的子代理失败让运行失败', JSON.stringify(result))
    }

    {
      const body = `return await parallel([agent('A'), agent('B'), agent('C'), agent('D')])`
      const fake = fakeController({ answer: (run) => (run.params.task === 'B' ? { status: 'error', error: 'B 挂了' } : { text: `答:${run.params.task}` }) })
      const first = start({ fake, body })
      const r1 = await first.outcome
      ok(r1.status === 'done' && r1.json === '["答:A",null,"答:C","答:D"]', '续跑例子：第一次 B 失败，其余完成', r1.json)
      const previous = await journalOf(first.file)
      const again = fakeController()
      const second = start({ fake: again, body, previous, attempt: 2, journalFile: first.file })
      const r2 = await second.outcome
      ok(r2.status === 'done' && r2.json === '["答:A","答:B","答:C","答:D"]', '续跑后结果完整', r2.json)
      ok(again.started.map((run) => run.params.task).join() === 'B,C,D', 'A 直接返回保存的结果，B、C、D 重跑', again.started.map((run) => run.params.task).join())
      ok(second.runner.agents[0].status === 'cached' && second.runner.agents[0].subagentId === 'sub-1', '复用的调用标记为 cached 并保留原子代理 ID')

      const reordered = `return await parallel([agent('A'), agent('C'), agent('B'), agent('D')])`
      const third = fakeController()
      const r3run = start({ fake: third, body: reordered, previous: await journalOf(first.file), attempt: 3, journalFile: first.file })
      const r3 = await r3run.outcome
      ok(r3.status === 'done' && third.started.map((run) => run.params.task).join() === 'C,B,D', '改成 A、C、B、D：A 直接返回，C、B、D 重跑', third.started.map((run) => run.params.task).join())
      const fourth = fakeController()
      const r4 = await start({ fake: fourth, body: reordered, previous: await journalOf(first.file), attempt: 4, journalFile: first.file }).outcome
      ok(r4.status === 'done' && fourth.started.length === 0 && r4.json === '["答:A","答:C","答:B","答:D"]', '再续跑同一脚本：全部直接返回（旧记录被分叉标记作废，不会误用）', JSON.stringify({ started: fourth.started.length, json: r4.json }))
    }

    {
      const body = `phase('一')\nconst a = await agent('A')\nphase('二')\nreturn [a, ...(await parallel([agent('B'), agent('C')]))]`
      const fake = fakeController({ answer: (run) => (run.params.task === 'A' ? { text: '答:A' } : 'hang') })
      const first = start({ fake, body })
      while (first.runner.agents.filter((agent) => agent?.status === 'running').length < 2) await delay(5)
      await first.runner.stop()
      const r1 = await first.outcome
      ok(r1.status === 'stopped' && fake.stopped.length === 2 && first.runner.agents.slice(1).every((agent) => agent.status === 'stopped'), '停止时停掉在跑的子代理并记为 stopped', JSON.stringify(first.runner.agents))
      const journal = await journalOf(first.file)
      ok(journal.get(1).status === 'stopped' && journal.get(2).status === 'stopped', 'journal 记下被停的调用')
      const again = fakeController()
      const r2 = await start({ fake: again, body, previous: journal, attempt: 2, journalFile: first.file }).outcome
      ok(r2.status === 'done' && again.started.map((run) => run.params.task).join() === 'B,C', '停止后续跑：运行中被停的调用重跑', again.started.map((run) => run.params.task).join())
    }

    {
      const fake = fakeController({ answer: () => ({ text: 'x', delay: 20 }) })
      const run = start({ fake, concurrency: 1, body: `const out = []\nfor (const t of ['a', 'b', 'c']) out.push(await agent(t))\nreturn out.length` })
      while (fake.started.length < 1) await delay(2)
      run.runner.pause()
      await delay(80)
      const pausedCount = fake.started.length
      run.runner.resume()
      const result = await run.outcome
      ok(pausedCount === 1 && result.status === 'done' && result.json === '3', '暂停时不再派新的子代理，继续后跑完', `${pausedCount} ${JSON.stringify(result)}`)
    }

    {
      const fake = fakeController({ answer: () => 'hang' })
      const { outcome } = await start({ fake, body: `agent('不等它')\nreturn 'early'` })
      const result = await outcome
      ok(result.status === 'done' && result.json === '"early"' && fake.stopped.length === 1, '脚本先结束时，没等的子代理会被停掉', JSON.stringify({ result, stopped: fake.stopped }))
    }

    {
      const fake = fakeController()
      const { outcome, runner } = await start({ fake, body: `while (true) {}` })
      const raced = await Promise.race([outcome, delay(150).then(() => 'still-running')])
      ok(raced === 'still-running', '死循环的脚本只卡住自己的 worker，不卡宿主事件循环')
      await runner.stop()
      ok((await outcome).status === 'stopped', '死循环的脚本可以停掉')
    }

    {
      const fake = fakeController()
      const { outcome } = await start({ fake, body: `return Date.now()` })
      const result = await outcome
      ok(result.status === 'failed' && /Date\.now\(\)/.test(result.error), 'worker 里 Date.now() 同样让运行失败')
    }

    {
      const fake = fakeController()
      const { outcome } = await start({ fake, body: `return args.items.length`, argsJson: JSON.stringify({ items: [1, 2] }) })
      const result = await outcome
      ok(result.status === 'done' && result.json === '2', 'args 经 workerData 传进脚本')
    }

    {
      const fake = fakeController()
      const { outcome, runner } = await start({ fake, body: `log('第一句')\nawait agent('A')\nlog('第二句')\nreturn 1` })
      await outcome
      ok(runner.logs.join('|') === '第一句|第二句', 'log() 记在运行上')
    }

  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
