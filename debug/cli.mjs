import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildApp, builtAppAge, connectCdp, holdProbe, isAlive, killTree, launchApp, storeHelpers } from './lib/app.mjs'
import { currentFile, debugDir, freePort, newRunDir, parseArgs, runsDir, sleep } from './lib/env.mjs'
import { FAKE_TRIGGERS, startFakeModel } from './lib/fake-model.mjs'
import { createSandbox, sandboxEnv } from './lib/sandbox.mjs'
import { scenarioContext } from './lib/scenario-context.mjs'
import { describeSamples, pickSamples, samplePaths } from './lib/sessions.mjs'

const scenariosDir = join(debugDir, 'scenarios')
const VALUE_FLAGS = new Set(['port', 'samples', 'repeat', 'count', 'min-mb', 'bucket', 'keep'])

const HELP = `砚调试工具：npm run debug -- <命令> [参数]

隔离实例（数据全在 debug/runs/<时间>-<名字>/，不碰真实数据、不抢单实例锁）
  up [--dev] [--build] [--no-fake] [--samples 1,2|all] [--port N]
      起一个隔离实例并保持前台运行，Ctrl+C 或 down 结束
      --dev       用 electron-vite dev（渲染端热更新），默认跑 out/ 构建版
      --build     先 electron-vite build
      --no-fake   不配置假模型（在实例里自己登录模型）
      --samples   把 debug/data 里的大会话样本拷进实例
  ps                   看当前实例
  eval <表达式>        在当前实例渲染端求值；s 是 store 状态，如 eval "s.messages.length"
  shot [名字]          当前实例截图，存到它的运行目录
  down                 结束当前实例（连同子进程）

场景（自动起隔离实例 + 假模型，跑完自动关）
  scenario                           列出场景
  scenario <名字> [--repeat N] [--build] [--dev]
      结果写到 debug/runs/<时间>-<名字>/report.json，失败时退出码非 0

假模型
  fake [--port N]      单独起假模型（openai-responses 协议），打印 models.json 片段
${Object.entries(FAKE_TRIGGERS).map(([key, text]) => `      消息含 ${key.padEnd(9)} ${text}`).join('\n')}
      其他消息回“好的，收到。”

大会话样本（只读拷贝真实 ~/.pi/agent/sessions，存 debug/data/sessions，带 sha256 清单）
  samples                            列出样本
  samples pick [--count 3] [--min-mb 5] [--bucket 目录名]   按体积从大到小拷贝

清理
  clean [--keep 5]     删除 debug/runs 下较旧的运行目录（保留最近 N 个，正在运行的不删）
`

function readCurrent() {
  if (!existsSync(currentFile)) return null
  try {
    const current = JSON.parse(readFileSync(currentFile, 'utf8'))
    return isAlive(current.pid) ? current : null
  } catch { return null }
}

async function startInstance({ label, flags, samples = [], probe = holdProbe }) {
  if (flags.build) buildApp()
  else if (!flags.dev) {
    const age = builtAppAge()
    if (age === null) throw new Error('没有 out/ 构建产物：加 --build 或先 npm run build')
    if (age > 30 * 60 * 1000) console.log(`提示：out/ 构建产物是 ${Math.round(age / 60000)} 分钟前的，改过源码请加 --build`)
  }
  const fake = flags['no-fake'] ? null : await startFakeModel()
  const runDir = newRunDir(label)
  const box = createSandbox(runDir, { fakePort: fake?.port, samples })
  const cdpPort = flags.port ? Number(flags.port) : await freePort()
  const app = launchApp(sandboxEnv(box, { fake: !!fake, cdpPort, probe }), { dev: !!flags.dev })
  return { fake, runDir, box, cdpPort, app }
}

function stopInstance({ app, fake }) {
  killTree(app.child.pid)
  fake?.server.close()
}

async function waitStore(cdp) {
  const { until } = storeHelpers(cdp)
  if (!(await until('true', 30000, 50))) throw new Error('渲染端没有暴露 __yanStore')
  await until('s.conn === "ready"', 60000, 50)
}

async function cmdUp(flags) {
  const current = readCurrent()
  if (current) throw new Error(`已有实例在跑（pid ${current.pid}，${current.runDir}），先 down`)
  const samples = samplePaths(flags.samples)
  const instance = await startInstance({ label: flags.dev ? 'up-dev' : 'up', flags, samples })
  const info = { pid: instance.app.child.pid, cdpPort: instance.cdpPort, fakePort: instance.fake?.port ?? null, runDir: instance.runDir, project: instance.box.project, dev: !!flags.dev, startedAt: new Date().toISOString() }
  writeFileSync(currentFile, JSON.stringify(info, null, 2))
  console.log(JSON.stringify(info, null, 2))
  const logFile = join(instance.runDir, 'main.log')
  const flush = setInterval(() => writeFileSync(logFile, instance.app.log()), 2000)
  const stop = () => { stopInstance(instance); clearInterval(flush); writeFileSync(logFile, instance.app.log()) }
  process.on('SIGINT', () => { stop(); process.exit(0) })
  await new Promise((done) => instance.app.child.on('exit', done))
  stop()
  console.log('实例已退出，日志：' + logFile)
}

async function withCurrentCdp(fn) {
  const current = readCurrent()
  if (!current) throw new Error('没有正在运行的实例：先 npm run debug -- up')
  const cdp = await connectCdp(current.cdpPort, { shotDir: current.runDir, timeoutMs: 10000 })
  try { return await fn(cdp, current) } finally { cdp.close() }
}

async function cmdEval(expr) {
  if (!expr) throw new Error('用法：eval <表达式>')
  const value = await withCurrentCdp((cdp) => cdp.evaluate(`(async () => { const s = window.__yanStore?.getState(); return (${expr}) })()`))
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function cmdDown() {
  const current = readCurrent()
  if (!current) { console.log('没有正在运行的实例'); return }
  killTree(current.pid)
  console.log(`已结束 pid ${current.pid}`)
}

function listScenarios() {
  return readdirSync(scenariosDir).filter((file) => file.endsWith('.mjs')).map((file) => basename(file, '.mjs'))
}

async function runScenarioOnce(name, flags) {
  const mod = await import(pathToFileURL(join(scenariosDir, `${name}.mjs`)).href)
  const need = mod.meta?.samples ?? 0
  const samples = need ? samplePaths('all').slice(0, need) : []
  if (samples.length < need) throw new Error(`场景 ${name} 需要 ${need} 个大会话样本：先 npm run debug -- samples pick`)
  const instance = await startInstance({ label: name, flags: { ...flags, 'no-fake': false }, samples })
  const report = { scenario: name, startedAt: new Date().toISOString(), checks: [], timings: {}, log: [] }
  let cdp
  try {
    cdp = await connectCdp(instance.cdpPort, { shotDir: instance.runDir })
    await waitStore(cdp)
    await mod.default(scenarioContext({ cdp, fake: instance.fake, box: instance.box, runDir: instance.runDir, report }))
    const errors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'))
    report.consoleErrors = errors.map((event) => (event.params.exceptionDetails?.exception?.description ?? event.params.args?.map((arg) => arg.value ?? arg.description).join(' ') ?? '').slice(0, 300))
    report.checks.push({ name: '渲染端无异常', ok: report.consoleErrors.length === 0 })
  } catch (error) {
    report.fatal = String(error?.stack ?? error)
    console.log('FATAL', report.fatal)
    try { await cdp?.shot('fatal') } catch {}
  } finally {
    try { await cdp?.evaluate('window.__probeDone && window.__probeDone(1)') } catch {}
    cdp?.close()
    await sleep(800)
    report.mainLogTail = instance.app.log().slice(-4000)
    stopInstance(instance)
    writeFileSync(join(instance.runDir, 'report.json'), JSON.stringify(report, null, 2))
  }
  const failed = report.checks.filter((check) => !check.ok).map((check) => check.name)
  const ok = !report.fatal && failed.length === 0
  console.log(`${ok ? '通过' : '失败'}  ${name}  ${instance.runDir}${failed.length ? `\n  失败项：${failed.join('；')}` : ''}`)
  return ok
}

async function cmdScenario(name, flags) {
  const all = listScenarios()
  if (!name) {
    for (const scenario of all) {
      const mod = await import(pathToFileURL(join(scenariosDir, `${scenario}.mjs`)).href)
      console.log(`${scenario.padEnd(22)} ${mod.meta?.description ?? ''}`)
    }
    return true
  }
  if (!all.includes(name)) throw new Error(`没有场景 ${name}，可选：${all.join('、')}`)
  if (flags.build) { buildApp(); flags = { ...flags, build: false } }
  const repeat = Math.max(1, Number(flags.repeat ?? 1))
  const results = []
  for (let i = 0; i < repeat; i++) results.push(await runScenarioOnce(name, flags))
  if (repeat > 1) console.log(`${name}：${results.filter(Boolean).length}/${repeat} 通过`)
  return results.every(Boolean)
}

async function cmdFake(flags) {
  const fake = await startFakeModel(flags.port ? Number(flags.port) : 0)
  console.log(`假模型：http://127.0.0.1:${fake.port}/v1（Ctrl+C 结束）`)
  console.log(JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: 'openai-responses', apiKey: 'fake-key', models: [{ id: 'fake-model', name: 'Fake', input: ['text', 'image'], contextWindow: 400000, maxTokens: 32000 }] } } }, null, 2))
  let seen = 0
  setInterval(() => { while (seen < fake.requests.length) console.log('请求', JSON.stringify(fake.requests[seen++])) }, 300)
  await new Promise(() => {})
}

function cmdSamples(sub, flags) {
  if (sub === 'pick') {
    const { added, total } = pickSamples({ count: Number(flags.count ?? 3), minBytes: Number(flags['min-mb'] ?? 0) * 1e6, bucket: typeof flags.bucket === 'string' ? flags.bucket : undefined })
    console.log(`新拷贝 ${added.length} 个，共 ${total} 个样本`)
  }
  const lines = describeSamples()
  console.log(lines.length ? lines.join('\n') : '还没有样本：npm run debug -- samples pick')
}

function cmdClean(flags) {
  if (!existsSync(runsDir)) return
  const keep = Math.max(0, Number(flags.keep ?? 5))
  const current = readCurrent()
  const dirs = readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
  const removed = []
  for (const dir of dirs.slice(keep)) {
    const path = join(runsDir, dir)
    if (current && current.runDir === path) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(dir)
  }
  console.log(removed.length ? `已删除 ${removed.length} 个运行目录` : '没有要删除的运行目录')
}

const { positional, flags } = parseArgs(process.argv.slice(2), VALUE_FLAGS)
const [command, ...rest] = positional
mkdirSync(runsDir, { recursive: true })
try {
  let ok = true
  if (!command || command === 'help' || flags.help) console.log(HELP)
  else if (command === 'up') await cmdUp(flags)
  else if (command === 'ps') console.log(JSON.stringify(readCurrent() ?? '没有正在运行的实例', null, 2))
  else if (command === 'eval') await cmdEval(rest.join(' '))
  else if (command === 'shot') console.log(await withCurrentCdp((cdp) => cdp.shot(rest[0] ?? `shot-${Date.now()}`)))
  else if (command === 'down') cmdDown()
  else if (command === 'scenario') ok = await cmdScenario(rest[0], flags)
  else if (command === 'fake') await cmdFake(flags)
  else if (command === 'samples') cmdSamples(rest[0], flags)
  else if (command === 'clean') cmdClean(flags)
  else { console.log(HELP); ok = false }
  process.exit(ok ? 0 : 1)
} catch (error) {
  console.error(error?.message ?? error)
  process.exit(1)
}
