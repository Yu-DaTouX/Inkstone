import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTest, runSuite } from './lib/test-suite.mjs'

const META = `export const meta = { name: 't', description: 'd' }\n`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function agentHost() {
  let counter = 0
  const runs = new Map()
  const started = []
  const host = {
    start: async (params) => {
      const run = { id: `sub-${++counter}`, params, status: 'running', transcript: [], endedAt: 0 }
      runs.set(run.id, run)
      started.push(run)
      setTimeout(() => {
        run.status = 'done'
        run.endedAt = Date.now() + counter
        run.transcript.push({ role: 'assistant', text: `答:${params.task}` })
      }, 3)
      return run.id
    },
    send: async () => undefined,
    stop: async () => undefined,
    waitFinished: async (id, after, signal) => {
      for (;;) {
        if (signal.aborted) return null
        const run = runs.get(id)
        if (run.status !== 'running' && run.endedAt > after) return { ...run, transcript: [...run.transcript] }
        await delay(2)
      }
    }
  }
  return { host, started }
}

function modelHost(answer = (req) => ({ text: `译:${req.prompt}` })) {
  let live = 0
  let maxLive = 0
  const calls = []
  const quotaChecks = []
  const fake = {
    calls,
    quotaChecks,
    maxLive: () => maxLive,
    quotaPlan: null,
    host: {
      call: async (req) => {
        calls.push(req)
        live += 1
        maxLive = Math.max(maxLive, live)
        try {
          const plan = await answer(req, calls.filter((c) => c.prompt === req.prompt).length)
          if (plan.hang) {
            await new Promise((resolve) => req.signal.addEventListener('abort', resolve, { once: true }))
            const error = new Error('已取消')
            error.kind = 'cancelled'
            throw error
          }
          await delay(plan.delay ?? 2)
          if (plan.error) {
            const error = new Error(plan.error)
            error.kind = plan.kind ?? 'model'
            throw error
          }
          return { text: plan.text, model: req.model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: 'stop', durationMs: 2 }
        } finally {
          live -= 1
        }
      },
      quota: async (model) => {
        quotaChecks.push(model)
        return fake.quotaPlan ? fake.quotaPlan(quotaChecks.length) : null
      }
    }
  }
  return fake
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { WorkflowRunner } = await compile('src/main/workflows/runner.ts')
  const { SlotGate } = await compile('src/main/workflows/slots.ts')
  const { readJournal, readModelJournal } = await compile('src/main/workflows/journal.ts')
  const { checkWorkflowScript } = await compile('src/main/workflows/script.ts')
  const { normalizeModelCall, modelPromptHash } = await compile('src/main/workflows/model-options.ts')
  const dir = await mkdtemp(join(tmpdir(), 'yan-workflow-model-'))
  const workerPath = join(dir, 'workflow-worker.mjs')
  await buildTest('src/main/workflows/worker.ts', workerPath)

  let journals = 0
  const start = ({ body, model, agents = agentHost(), slots, previous = new Map(), previousModels = new Map(), attempt = 1, journalFile, modelConcurrency, maxModels, root, defaultModel = 'fake/default' }) => {
    const checked = checkWorkflowScript(META + body)
    if (!checked.ok) throw new Error(checked.error)
    const file = journalFile ?? join(dir, `journal-${++journals}.jsonl`)
    let finish
    const outcome = new Promise((resolve) => (finish = resolve))
    const runner = new WorkflowRunner({
      workerPath,
      code: checked.code,
      journalFile: file,
      attempt,
      concurrency: 8,
      previous,
      previousModels,
      host: agents.host,
      slots: slots ?? new SlotGate({ capacity: 24, running: () => 0, pollMs: 20 }),
      requeueDelayMs: 5,
      modelHost: model.host,
      defaultModel,
      ...(modelConcurrency ? { modelConcurrency } : {}),
      ...(maxModels ? { maxModels } : {}),
      root: root ?? dir,
      modelBackoffMs: 5,
      onChange: () => undefined,
      onFinish: (result) => finish(result)
    })
    runner.start()
    return { runner, outcome, file }
  }
  const lines = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))

  try {
    {
      const call = normalizeModelCall(' 翻译这段 ', { label: '段1', model: 'a/b', system: '你是译者', thinking: 'HIGH', timeoutMinutes: 10, retries: 2, schema: { type: 'object' } })
      ok(call.prompt === '翻译这段' && call.options.thinking === 'high' && call.options.timeoutMinutes === 10 && call.options.retries === 2 && call.options.system === '你是译者', '选项归一化')
      const bad = [
        [[''], /prompt/],
        [['x', { nope: 1 }], /不认识的选项/],
        [['x', { timeoutMinutes: 31 }], /1–30/],
        [['x', { timeoutMinutes: 0 }], /1–30/],
        [['x', { retries: 6 }], /0–5/],
        [['x', { thinking: 'ultra' }], /thinking/],
        [['x', { schema: { minItems: 1 } }], /schema/],
        [['x', { readOnly: true }], /不认识的选项/],
        [['x', []], /选项对象/]
      ]
      for (const [args, pattern] of bad) {
        let message = ''
        try { normalizeModelCall(...args) } catch (error) { message = error.message }
        ok(pattern.test(message), `非法选项被拒：${JSON.stringify(args)}`, message)
      }
      const a = modelPromptHash('p', { label: 'x', timeoutMinutes: 3, retries: 1, model: 'a/b' })
      const b = modelPromptHash('p', { label: 'y', timeoutMinutes: 9, retries: 0, model: 'a/b' })
      const c = modelPromptHash('p', { model: 'a/c' })
      ok(a === b && a !== c && /^[0-9a-f]{16}$/.test(a), '提示词哈希不受 label / timeoutMinutes / retries 影响，受模型影响')
    }

    {
      const model = modelHost()
      const full = new SlotGate({ capacity: 24, running: () => 24, pollMs: 20 })
      const { outcome, runner, file } = await start({ model, slots: full, body: `phase('译')\nreturn await model('你好', { system: '译成英文', thinking: 'low', timeoutMinutes: 2, label: '甲' })` })
      const result = await outcome
      ok(result.status === 'done' && JSON.parse(result.json) === '译:你好', 'model() 返回文本', JSON.stringify(result))
      const req = model.calls[0]
      ok(req.model === 'fake/default' && req.system === '译成英文' && req.thinking === 'low' && req.timeoutMs === 120_000 && req.signal instanceof AbortSignal, '不传 model 时用发起会话的模型；system / thinking / 超时传给直接调用', JSON.stringify({ ...req, signal: undefined }))
      ok(full.available() <= 0, '子代理名额已满时 model() 照样执行：不占 24 个名额')
      ok(runner.models.done === 1 && runner.models.total === 1 && runner.agents.length === 0, 'model() 计数单独统计，不进 agent 列表', JSON.stringify(runner.models))
      ok(runner.models.phases?.length === 1 && runner.models.phases[0].title === '译' && runner.models.phases[0].done === 1, 'model() 按阶段计数', JSON.stringify(runner.models.phases))
      const journal = await lines(file)
      const entry = journal.find((line) => line.kind === 'model')
      ok(entry?.status === 'done' && entry.result === '译:你好' && entry.seq === 0 && /^[0-9a-f]{16}$/.test(entry.hash) && entry.label === '甲' && entry.phase === '译' && entry.usage?.totalTokens === 15 && entry.model === 'fake/default', 'journal 记下 model() 的序号、哈希、结果与用量', JSON.stringify(entry))
    }

    {
      const model = modelHost()
      const { outcome } = await start({ model, defaultModel: null, body: `return await model('x')` })
      const result = await outcome
      ok(result.status === 'failed' && /模型/.test(result.error) && model.calls.length === 0, '没有可用模型时失败并说明', JSON.stringify(result))
    }

    {
      const model = modelHost((req) => ({ text: req.prompt, delay: 15 }))
      const { outcome } = await start({ model, modelConcurrency: 3, body: `return (await parallel(Array.from({ length: 20 }, (_, i) => () => model('t' + i)))).length` })
      const result = await outcome
      ok(result.status === 'done' && result.json === '20' && model.maxLive() === 3, `model() 并发按 --model-concurrency 封顶（最多同时 ${model.maxLive()} 个）`)
      const fresh = modelHost((req) => ({ text: req.prompt, delay: 15 }))
      const second = await start({ model: fresh, body: `return (await parallel(Array.from({ length: 30 }, (_, i) => () => model('t' + i)))).length` }).outcome
      ok(second.status === 'done' && fresh.maxLive() === 8, `默认并发 8（实际 ${fresh.maxLive()}）`)
    }

    {
      const model = modelHost()
      const { outcome } = await start({ model, maxModels: 3, body: `const out = []\nfor (let i = 0; i < 4; i++) out.push(await model('t' + i))\nreturn out` })
      const result = await outcome
      ok(result.status === 'failed' && /最多 3 个 model\(\)/.test(result.error) && model.calls.length === 3, '超过单次运行 model() 上限时运行失败', JSON.stringify(result))
    }

    {
      const model = modelHost((req, n) => (req.prompt === 'slow' && n === 1 ? { error: '模型调用超时', kind: 'timeout' } : req.prompt === 'rate' ? { error: '429 Rate limit reached for requests per minute' } : req.prompt === 'auth' ? { error: '401 Incorrect API key provided' } : req.prompt.startsWith('boom') && n === 1 ? { error: '503 Service Unavailable' } : { text: `ok:${req.prompt}` }))
      const { outcome, runner } = await start({ model, body: `return await parallel([model('slow'), model('rate'), model('auth'), model('boom'), model('rate', { retries: 0, label: 'r0' }), model('boom0', { retries: 0 })])` })
      const result = await outcome
      const values = JSON.parse(result.json)
      const count = (prompt) => model.calls.filter((c) => c.prompt === prompt).length
      ok(values[0] === 'ok:slow', '超时后按 retries（默认 1）重试成功', result.json)
      ok(values[1] === null && values[2] === null && values[3] === 'ok:boom', '限流两次都失败算失败；鉴权错误不重试；5xx 重试成功', result.json)
      ok(count('rate') === 3 && count('auth') === 1, `限流共调 ${count('rate')} 次（含 retries:0 的 1 次），鉴权只调 ${count('auth')} 次`)
      ok(values[5] === null && count('boom0') === 1, 'retries:0 时不重试')
      ok(runner.models.failed >= 3 && runner.models.done >= 2, '失败计数进运行卡统计', JSON.stringify(runner.models))
    }

    {
      const model = modelHost((req) => ({ error: '401 Incorrect API key provided' }))
      const { outcome } = await start({ model, body: `return await model('x')` })
      const result = await outcome
      ok(result.status === 'failed' && /401 Incorrect API key provided/.test(result.error), '直接 await 的 model() 失败时原样带回模型错误', JSON.stringify(result))
    }

    {
      const key = 'AIza' + 'Q'.repeat(35)
      const model = modelHost(() => ({ error: `401 Incorrect API key provided: ${key} for https://x.test/v1?client_secret=hush123` }))
      const { outcome } = await start({ model, body: `try { await model('x') } catch (e) { return String(e.message) }` })
      const result = await outcome
      const seen = JSON.parse(result.json)
      ok(result.status === 'done' && /401 Incorrect API key provided/.test(seen) && !seen.includes(key) && !seen.includes('hush123') && seen.includes('[redacted]'), '交给脚本的 model() 错误保留原意、去掉密钥形态', seen)
    }

    {
      const model = modelHost((req) => ({ text: req.prompt.startsWith('good') ? '说明\n```json\n{"zh":"你好","n":1}\n```' : req.prompt.startsWith('wrong') ? '```json\n{"zh":1}\n```' : '不是 JSON' }))
      const schema = `{ type: 'object', required: ['zh'], properties: { zh: { type: 'string' }, n: { type: 'integer' } } }`
      const { outcome, file } = await start({ model, body: `const S = ${schema}\nreturn await parallel([model('good', { schema: S }), model('wrong', { schema: S }), model('plain', { schema: S })])` })
      const result = await outcome
      const values = JSON.parse(result.json)
      ok(values[0]?.zh === '你好' && values[1] === null && values[2] === null, 'schema：合格返回对象，不合格按失败', result.json)
      ok(/JSON Schema/.test(model.calls[0].prompt) || /JSON Schema/.test(model.calls[0].system ?? ''), 'schema 要求附在请求里')
      const failed = (await lines(file)).filter((line) => line.kind === 'model' && line.status === 'failed')
      ok(failed.length === 2 && failed.every((line) => /schema|JSON/.test(line.error)), 'schema 失败原因写进 journal', JSON.stringify(failed.map((line) => line.error)))
      ok(model.calls.length === 3, 'schema 不合格不自动重试（retries 只管超时、限流与 5xx）')
    }

    {
      let quotaHits = 0
      const model = modelHost((req) => (req.prompt === 'q' && quotaHits++ === 0 ? { error: 'You have hit your usage limit. Resets at 5pm.' } : { text: 'ok' }))
      model.quotaPlan = (n) => (n === 1 ? { ready: false, resetAt: Date.now() + 40, nextCheckAt: Date.now() + 40 } : { ready: true, nextCheckAt: Date.now() })
      const { outcome } = await start({ model, body: `return await model('q', { retries: 0 })` })
      const result = await outcome
      ok(result.status === 'done' && JSON.parse(result.json) === 'ok' && model.quotaChecks.length >= 2 && model.calls.length === 2, '额度用尽且 30 分钟内重置：排队等额度恢复后再调，不消耗 retries', JSON.stringify({ result, checks: model.quotaChecks.length, calls: model.calls.length }))
    }

    {
      const model = modelHost(() => ({ error: 'You have hit your usage limit.' }))
      model.quotaPlan = () => ({ ready: false, resetAt: Date.now() + 3 * 60 * 60_000, nextCheckAt: Date.now() + 60_000 })
      const { outcome } = await start({ model, body: `return await model('q')` })
      const result = await outcome
      ok(result.status === 'failed' && /usage limit/.test(result.error) && /30 分钟/.test(result.error) && model.calls.length === 1, '额度重置超过 30 分钟：不等，失败并带原始错误', JSON.stringify(result))
    }

    {
      const model = modelHost(() => ({ error: 'insufficient_balance: 余额不足，请充值' }))
      model.quotaPlan = () => ({ ready: false, resetAt: Date.now() + 40, nextCheckAt: Date.now() + 40 })
      const { outcome } = await start({ model, body: `return await model('q')` })
      const result = await outcome
      ok(result.status === 'failed' && /余额不足/.test(result.error) && model.quotaChecks.length === 0 && model.calls.length === 1, '余额不足不等也不重试，直接失败', JSON.stringify(result))
    }

    {
      const model = modelHost(() => ({ error: 'You have hit your usage limit.' }))
      const { outcome } = await start({ model, body: `return await model('q')` })
      const result = await outcome
      ok(result.status === 'failed' && /usage limit/.test(result.error) && /查不到/.test(result.error), '查不到额度信息时不排队，失败并带原始错误', JSON.stringify(result))
    }

    {
      const body = `const a = await agent('A')\nconst m = await parallel([model('x1'), model('x2'), model('FAIL')])\nconst b = await agent('B ' + m[0])\nreturn [a, m, b]`
      const first = modelHost((req) => (req.prompt === 'FAIL' ? { error: '401 Incorrect API key provided' } : { text: `译:${req.prompt}` }))
      const agents1 = agentHost()
      const r1 = await start({ model: first, agents: agents1, body })
      const out1 = await r1.outcome
      ok(out1.status === 'done' && JSON.parse(out1.json)[1][2] === null && agents1.started.length === 2, '混用：第一次 FAIL 失败、两个 agent 完成', out1.json)
      const text = await readFile(r1.file, 'utf8')
      const previous = readJournal(text)
      const previousModels = readModelJournal(text)
      ok(previous.size === 2 && previousModels.size === 3 && [...previous.values()].every((entry) => entry.kind !== 'model'), 'agent 与 model() 的记录分开读取', `${previous.size}/${previousModels.size}`)
      const second = modelHost((req) => ({ text: `译:${req.prompt}` }))
      const agents2 = agentHost()
      const r2 = await start({ model: second, agents: agents2, body, previous, previousModels, attempt: 2, journalFile: r1.file })
      const out2 = await r2.outcome
      const values = JSON.parse(out2.json)
      ok(out2.status === 'done' && values[1].join() === '译:x1,译:x2,译:FAIL' && values[2] === '答:B 译:x1', '续跑结果完整', out2.json)
      ok(second.calls.length === 1 && second.calls[0].prompt === 'FAIL', '续跑只重调失败的 model()，已完成的直接返回保存结果', JSON.stringify(second.calls.map((c) => c.prompt)))
      ok(agents2.started.length === 0, 'model() 失败不让后面的 agent() 重跑：agent 记录照常重放', String(agents2.started.length))
      ok(r2.runner.models.cached === 2 && r2.runner.models.done === 1, '续跑计数：2 个沿用、1 个新完成', JSON.stringify(r2.runner.models))
    }

    {
      const body = `return await parallel([model('p1'), model('p2')])`
      const first = modelHost((req) => (req.prompt === 'p2' ? { hang: true } : { text: req.prompt }))
      const r1 = start({ model: first, body })
      while (first.calls.length < 2) await delay(5)
      await delay(20)
      await r1.runner.stop()
      const out1 = await r1.outcome
      const text = await readFile(r1.file, 'utf8')
      const stopped = text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((line) => line.kind === 'model' && line.status === 'stopped')
      ok(out1.status === 'stopped' && stopped?.seq === 1, '停止时在跑的 model() 被取消并记为 stopped', JSON.stringify({ out1, stopped }))
      const second = modelHost((req) => ({ text: req.prompt }))
      const r2 = start({ model: second, body, previous: readJournal(text), previousModels: readModelJournal(text), attempt: 2, journalFile: r1.file })
      const out2 = await r2.outcome
      ok(out2.status === 'done' && out2.json === '["p1","p2"]' && second.calls.map((c) => c.prompt).join() === 'p2', '续跑只重调被停的那个', JSON.stringify(second.calls.map((c) => c.prompt)))
    }

    {
      const model = modelHost((req) => ({ text: req.prompt, delay: 5 }))
      const { outcome, runner } = start({ model, modelConcurrency: 1, body: `return (await parallel([model('a'), model('b'), model('c')])).join()` })
      while (model.calls.length < 1) await delay(1)
      runner.pause()
      await delay(40)
      const during = model.calls.length
      runner.resume()
      const result = await outcome
      ok(during === 1 && result.json === '"a,b,c"', '暂停时不再发起新的 model()，继续后跑完', `${during} ${result.json}`)
    }

    {
      const root = join(dir, 'project')
      await mkdir(join(root, 'segments'), { recursive: true })
      for (let i = 0; i < 5; i++) await writeFile(join(root, 'segments', `${String(i).padStart(3, '0')}.txt`), `段落${i}`, 'utf8')
      const model = modelHost((req) => ({ text: req.prompt.replace('段落', 'Paragraph '), delay: 10 - Number(req.prompt.slice(-1)) * 2 }))
      const body = [
        `const files = await listFiles('segments', '*.txt')`,
        `const out = await pipeline(files, async (file) => {`,
        `  const text = await readText(file)`,
        `  const done = await model(text, { label: file })`,
        `  await writeText(file.replace('segments/', 'out/'), done)`,
        `  return file`,
        `})`,
        `return { files, out }`
      ].join('\n')
      const { outcome, file } = await start({ model, root, body })
      const result = await outcome
      const value = JSON.parse(result.json)
      ok(result.status === 'done' && value.files.length === 5 && value.files[0] === 'segments/000.txt', 'listFiles 返回项目相对路径、按名称排序', result.json)
      ok((await readFile(join(root, 'out', '003.txt'), 'utf8')) === 'Paragraph 3', 'readText → model() → writeText 写出结果（自动建父目录）')
      const journal = await lines(file)
      const models = journal.filter((line) => line.kind === 'model').sort((a, b) => a.seq - b.seq)
      ok(models.map((line) => line.label).join() === value.files.join(), 'pipeline 里 readText 后的 model() 序号与文件顺序一致（续跑可重放）', models.map((line) => line.label).join())
      const io = journal.filter((line) => line.kind === 'io')
      ok(io.filter((line) => line.op === 'read').length === 5 && io.filter((line) => line.op === 'write').length === 5 && io.some((line) => line.op === 'list' && line.count === 5), 'readText / writeText / listFiles 记进 journal', JSON.stringify(io.slice(0, 3)))
      ok(io.every((line) => !('text' in line) && !('content' in line)), 'journal 不另存读写全文')
      const escape = await start({ model, root, body: `try { await readText('../journal-1.jsonl'); return 'leak' } catch (e) { return e.message }` }).outcome
      ok(escape.status === 'done' && /项目目录/.test(JSON.parse(escape.json)), '脚本里的越界读取被拒，错误可被捕获', escape.json)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
