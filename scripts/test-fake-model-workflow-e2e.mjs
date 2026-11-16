import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildTest, runSuite } from './lib/test-suite.mjs'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

function piCli() {
  const roots = [process.env.YAN_E2E_PI_RUNTIME, resolve('resources', 'pi-runtime')].filter(Boolean)
  try {
    const main = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').find((line) => line.startsWith('worktree '))?.slice(9).trim()
    if (main) roots.push(join(main, 'resources', 'pi-runtime'))
  } catch {
  }
  for (const root of roots) {
    if (!existsSync(join(root, 'current.json'))) continue
    const cli = join(selectedPiRuntime(root), 'dist', 'bundle', 'cli.js')
    if (existsSync(cli)) return cli
  }
  throw new Error('找不到 pi 运行时（resources/pi-runtime）；设 YAN_E2E_PI_RUNTIME 指向它')
}

function startFakeOpenAI() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let json = {}
      try { json = JSON.parse(body) } catch {}
      const messages = Array.isArray(json.messages) ? json.messages : []
      const textOf = (message) => (typeof message?.content === 'string' ? message.content : (message?.content ?? []).map((part) => part.text ?? '').join(''))
      const user = textOf([...messages].reverse().find((m) => m.role === 'user'))
      const system = textOf(messages.find((m) => m.role === 'system' || m.role === 'developer'))
      requests.push({ url: req.url, model: json.model, system, user, auth: String(req.headers.authorization ?? '') })
      if (user.includes('FAILAUTH')) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided: fake-key', type: 'invalid_request_error', code: 'invalid_api_key' } }))
        return
      }
      const answer = /JSON Schema/.test(user) ? '```json\n{"en":"Hello","ok":true}\n```' : `EN:${user.trim()}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: json.model }
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      for (let i = 0; i < answer.length; i += 8) send({ ...base, choices: [{ index: 0, delta: { content: answer.slice(i, i + 8) }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      send({ ...base, choices: [], usage: { prompt_tokens: 20 + user.length, completion_tokens: answer.length, total_tokens: 20 + user.length + answer.length } })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port, requests })))
}

function runCli(args, env, cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve('resources/yan-cli/yan.mjs'), ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
}

await runSuite(import.meta.url, async (ok, compile) => {
  const cli = piCli()
  console.log(`  pi：${cli}`)
  const { callModel } = await compile('src/main/model-call.ts')
  const { runModelAsk } = await compile('src/main/model-ask.ts')
  const { CapabilityServer } = await compile('src/main/capability-server.ts')
  const { WorkflowRunner } = await compile('src/main/workflows/runner.ts')
  const { SlotGate } = await compile('src/main/workflows/slots.ts')
  const { readJournal, readModelJournal } = await compile('src/main/workflows/journal.ts')
  const { checkWorkflowScript } = await compile('src/main/workflows/script.ts')
  const base = mkdtempSync(join(tmpdir(), 'yan-model-e2e-'))
  const workerPath = join(base, 'workflow-worker.mjs')
  await buildTest('src/main/workflows/worker.ts', workerPath)
  const fake = await startFakeOpenAI()
  const piDir = join(base, 'pi-agent')
  const dataDir = join(base, 'yan-data')
  const project = join(base, 'project')
  for (const dir of [piDir, dataDir, join(project, 'segments'), join(project, '.git')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(piDir, 'models.json'), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${fake.port}/v1`,
        api: 'openai-completions',
        apiKey: 'fake-key',
        models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
      }
    }
  }))
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model', retry: { enabled: false } }))
  for (let i = 0; i < 10; i++) writeFileSync(join(project, 'segments', `${String(i).padStart(3, '0')}.txt`), `第 ${i} 段：你好，世界`, 'utf8')
  const runtime = { cwd: dataDir, piBin: cli, env: { PI_CODING_AGENT_DIR: piDir, YAN_DATA_DIR: dataDir } }
  const call = (req) => callModel(req, runtime)
  const server = new CapabilityServer({ opsDir: join(dataDir, 'ops'), onlyCommands: ['model.ask'], handlers: { run: (command, params, _ctx, signal) => runModelAsk(params, { cwd: project, model: 'fake/fake-model' }, { call }, signal) } })

  const script = [
    `export const meta = { name: 'e2e-translate', description: '10 段 → model() → writeText' }`,
    `const files = await listFiles('segments', '*.txt')`,
    `const done = await pipeline(files, async (file) => {`,
    `  const text = await readText(file)`,
    `  const en = await model(text, { system: '你是译者，只输出译文', label: file })`,
    `  await writeText('out/' + file.slice('segments/'.length), en)`,
    `  return file`,
    `})`,
    `const shaped = await model('给出 JSON', { schema: { type: 'object', required: ['en'], properties: { en: { type: 'string' }, ok: { type: 'boolean' } } } })`,
    `let authError = null`,
    `try { await model('FAILAUTH 这段会被拒', { label: 'auth' }) } catch (e) { authError = e.message }`,
    `return { files: files.length, ok: done.filter(Boolean).length, shaped, authError }`
  ].join('\n')
  const checked = checkWorkflowScript(script)
  if (!checked.ok) throw new Error(checked.error)
  const journalFile = join(base, 'journal.jsonl')
  const run = (attempt, previous, previousModels) => {
    let finish
    const outcome = new Promise((done) => (finish = done))
    const runner = new WorkflowRunner({
      workerPath,
      code: checked.code,
      journalFile,
      attempt,
      concurrency: 8,
      previous,
      previousModels,
      host: { start: async () => { throw new Error('这个场景不派子代理') }, send: async () => undefined, stop: async () => undefined, waitFinished: async () => null },
      slots: new SlotGate({ capacity: 24, running: () => 0 }),
      modelHost: { call },
      defaultModel: 'fake/fake-model',
      modelConcurrency: 4,
      root: project,
      onChange: () => undefined,
      onFinish: (result) => finish(result)
    })
    runner.start()
    return { runner, outcome }
  }

  try {
    const started = Date.now()
    const first = run(1, new Map(), new Map())
    const result = await first.outcome
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const value = result.status === 'done' ? JSON.parse(result.json) : null
    ok(result.status === 'done' && value.files === 10 && value.ok === 10, `工作流跑完：10 段全部完成（${seconds}s）`, JSON.stringify(result))
    ok(readFileSync(join(project, 'out', '007.txt'), 'utf8') === 'EN:第 7 段：你好，世界', '译文经 writeText 写到 out/')
    ok(value.shaped?.en === 'Hello' && value.shaped.ok === true, 'schema 调用返回校验过的 JSON', JSON.stringify(value.shaped))
    ok(/Incorrect API key provided/.test(value.authError ?? ''), `模型的鉴权报错原样带回脚本：${value.authError}`)
    const translations = fake.requests.filter((r) => /第 \d 段/.test(r.user))
    ok(translations.length === 10 && translations.every((r) => r.model === 'fake-model' && r.system.includes('你是译者') && r.auth === 'Bearer fake-key'), '假模型收到 10 次翻译请求，带系统提示词与隔离目录里的凭据', JSON.stringify(translations[0]))
    const journalText = readFileSync(journalFile, 'utf8')
    const lines = journalText.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const models = lines.filter((line) => line.kind === 'model')
    const done = models.filter((line) => line.status === 'done')
    ok(done.length === 11 && done.every((line) => line.usage?.totalTokens > 0 && line.stopReason === 'stop' && line.model === 'fake/fake-model'), 'journal：11 个完成的 model() 带用量、stopReason 与实际模型', JSON.stringify(done[0]))
    ok(models.some((line) => line.status === 'failed' && line.label === 'auth' && /Incorrect API key/.test(line.error)), 'journal：鉴权失败记为 failed 并带原始报错')
    ok(lines.filter((line) => line.kind === 'io' && line.op === 'read').length === 10 && lines.filter((line) => line.kind === 'io' && line.op === 'write').length === 10 && lines.some((line) => line.kind === 'io' && line.op === 'list' && line.count === 10), 'journal：10 次读、10 次写、1 次列目录')
    ok(first.runner.models.done === 11 && first.runner.models.failed === 1, '运行卡计数：完成 11、失败 1', JSON.stringify(first.runner.models))

    const before = fake.requests.length
    const second = run(2, readJournal(journalText), readModelJournal(journalText))
    const again = await second.outcome
    const replayed = fake.requests.slice(before)
    ok(again.status === 'done' && JSON.parse(again.json).ok === 10, '续跑结果一致')
    ok(replayed.length === 1 && replayed[0].user.includes('FAILAUTH'), `续跑只重调失败的那次（实际请求 ${replayed.length} 次）`, JSON.stringify(replayed.map((r) => r.user.slice(0, 20))))
    ok(second.runner.models.cached === 11, '续跑沿用 11 个已完成调用', JSON.stringify(second.runner.models))

    const bound = await server.start({ sessionId: 'e2e', projectId: 'e2e-project' })
    const env = { YAN_CLI_URL: bound.url, YAN_CLI_TOKEN: bound.token, YAN_SESSION_ID: 'e2e', YAN_PROJECT_ID: 'e2e-project' }
    writeFileSync(join(project, 'req.json'), JSON.stringify({ promptFile: 'segments/003.txt', system: '你是译者', outFile: 'out/ask.txt' }), 'utf8')
    const asked = await runCli(['model', 'ask', '--request-file', 'req.json'], env, project)
    const payload = JSON.parse(asked.stdout || '{}')
    ok(asked.code === 0 && payload.ok && payload.summary.kind === 'model' && payload.summary.preview === 'EN:第 3 段：你好，世界' && payload.summary.usage?.totalTokens > 0, 'yan model ask：stdout 回摘要', asked.stdout + asked.stderr)
    const full = JSON.parse(readFileSync(payload.resultFile, 'utf8'))
    ok(full.text === 'EN:第 3 段：你好，世界' && full.model === 'fake/fake-model' && full.outFile === 'out/ask.txt', 'yan model ask：resultFile 有全文与模型', JSON.stringify(full))
    ok(readFileSync(join(project, 'out', 'ask.txt'), 'utf8') === 'EN:第 3 段：你好，世界', 'yan model ask：outFile 写进项目')
    writeFileSync(join(project, 'bad.json'), JSON.stringify({ prompt: 'x', outFile: '../escape.txt' }), 'utf8')
    const escaped = await runCli(['model', 'ask', '--request-file', 'bad.json'], env, project)
    ok(escaped.code === 1 && /路径不在项目目录内/.test(escaped.stdout) && !existsSync(join(base, 'escape.txt')), 'yan model ask：outFile 越界被拒', escaped.stdout)
    writeFileSync(join(project, 'auth.json'), JSON.stringify({ prompt: 'FAILAUTH 第二意见' }), 'utf8')
    const denied = await runCli(['model', 'ask', '--request-file', 'auth.json'], env, project)
    ok(denied.code === 1 && /Incorrect API key provided/.test(denied.stdout), 'yan model ask：模型报错原样带回', denied.stdout)
  } finally {
    server.stop()
    fake.server.close()
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  }
})
