import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { connectCdp, launchApp, holdProbe, killTree, storeHelpers } from './lib/app.mjs'
import { freePort, newRunDir, sleep } from './lib/env.mjs'
import { startFakeModel } from './lib/fake-model.mjs'
import { createSandbox, sandboxEnv } from './lib/sandbox.mjs'

const REAL_MODELS = { 'commandcode/deepseek/deepseek-v4.1-flash': 'commandcode', 'openai-codex/gpt-6-luna': 'openai-codex' }
const model = process.argv[2]
const out = resolve(process.argv[3] ?? '.')
const provider = REAL_MODELS[model]
if (!provider) { console.log('用法：node debug/live-restart.mjs <deepseek 或 luna 的模型 id> <输出目录>'); process.exit(1) }
mkdirSync(out, { recursive: true })
delete process.env.ELECTRON_RUN_AS_NODE
const subModel = 'commandcode/deepseek/deepseek-v4.1-flash'

const fake = await startFakeModel()
const runDir = newRunDir('live-restart')
const box = createSandbox(runDir, { fakePort: fake.port })
const auth = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'))
const realEnv = { YAN_TEST_MODEL: model }
const authFile = {}
if (auth.commandcode?.key) realEnv.COMMANDCODE_API_KEY = auth.commandcode.key
if (provider === 'openai-codex') authFile['openai-codex'] = auth['openai-codex']
if (Object.keys(authFile).length) writeFileSync(join(box.piDir, 'auth.json'), JSON.stringify(authFile))
writeFileSync(join(box.dataDir, 'desktop.json'), JSON.stringify({ cwd: box.project, recentCwds: box.projects, lang: 'en-US' }))

const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)) }

async function launch() {
  const cdpPort = await freePort()
  const app = launchApp({ ...sandboxEnv(box, { fake: true, cdpPort, probe: holdProbe }), ...realEnv })
  const cdp = await connectCdp(cdpPort, { shotDir: out })
  const helpers = storeHelpers(cdp)
  if (!(await helpers.until('s.conn === "ready"', 60000))) console.log('警告：conn 未 ready')
  return { app, cdp, ...helpers }
}

let current
try {
  current = await launch()
  const { cdp, state, until } = current
  await cdp.evaluate(`(() => { const st = window.__yanStore; window.__autoApprove = st.subscribe((s) => { for (const a of (s.approvals ?? [])) { if (a?.id && a.phase !== 'resolved' && !window.__seen?.has(a.id)) { (window.__seen ??= new Set()).add(a.id); setTimeout(() => void st.getState().answerApproval(a.id, 'session'), 0) } } }) })()`)
  await cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
  await until(`s.session?.cwd === ${JSON.stringify(box.project)}`, 5000)
  const request = { task: 'First create crash0.txt in the project root containing hello-first. Then run the shell command `sleep 90` once (use a timeout of 120 seconds), and only after it returns create crash1.txt in the project root containing the text hello-before-crash. Then report.', title: 'slow write', isolation: 'worktree', model: subModel }
  await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('Write this JSON to sub.json and start a subagent with yan subagent start --request-file sub.json, then end your turn without polling: ' + JSON.stringify(request))})`)
  const running = await until(`s.subagents.some((r) => r.status === 'running')`, 240000)
  check('worktree 子代理开始运行', running)
  await sleep(25000)
  const before = await state('s.subagents.map((r) => ({ id: r.id, status: r.status, isolation: r.isolation, toolCalls: r.toolCalls }))')
  console.log('崩溃前', JSON.stringify(before))
  killTree(current.app.child.pid)
  await sleep(4000)
  try { current.cdp.close() } catch {}

  current = await launch()
  await sleep(8000)
  const after = await current.state('s.subagents.map((r) => ({ id: r.id, status: r.status, isolation: r.isolation, review: r.review, resumable: r.resumable, error: r.error, endReason: r.endReason }))')
  console.log('重启后', JSON.stringify(after))
  const id = after[0]?.id
  check('崩溃的子代理重启后标为已中断但可续接', !!id && after[0].resumable?.ok === true && after[0].isolation === 'worktree', after[0])
  writeFileSync(join(out, 'after-restart.json'), JSON.stringify(after, null, 1))
  if (id) {
    const sessionFile = await current.state('s.session?.sessionFile ?? null')
    console.log('当前会话', sessionFile ? 'restored' : '无')
    await current.cdp.evaluate(`(() => { const st = window.__yanStore; if (window.__autoApprove2) return; window.__autoApprove2 = st.subscribe((s) => { for (const a of (s.approvals ?? [])) { if (a?.id && a.phase !== 'resolved' && !window.__seen2?.has(a.id)) { (window.__seen2 ??= new Set()).add(a.id); setTimeout(() => void st.getState().answerApproval(a.id, 'session'), 0) } } }) })()`)
    if (!(await current.state(`s.session?.cwd === ${JSON.stringify(box.project)}`))) await current.cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
    await current.cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('Subagent ' + id + ' was interrupted when the app restarted. Resume it in place with yan subagent send --id ' + id + ' --message "Continue: skip the sleep, just create crash1.txt containing hello-after-resume, then report." Then end your turn.')})`)
    await sleep(15000)
    const end = Date.now() + 300000
    let runs
    while (Date.now() < end) {
      runs = await current.state(`s.subagents.map((r) => ({ id: r.id, status: r.status, review: r.review, diff: r.diff?.paths }))`)
      if (runs.length && runs.every((r) => r.status !== 'running' && r.status !== 'starting')) break
      await sleep(3000)
    }
    console.log('续接后', JSON.stringify(runs))
    check('续接后子代理跑完并有改动', runs?.[0]?.status === 'done' && (runs[0].diff ?? []).includes('crash1.txt') && runs[0].diff.includes('crash0.txt'), runs?.[0])
    await current.cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('Merge it with yan subagent merge --id ' + id + ' and tell me the content of crash1.txt.')})`)
    await sleep(8000)
    await current.until('!(s.session?.isStreaming || s.session?.isAgentRunning)', 240000)
    await sleep(30000)
    const file = join(box.project, 'crash1.txt')
    check('合并后 crash1.txt 在项目目录', existsSync(file), existsSync(file) ? readFileSync(file, 'utf8').trim() : null)
  }
  const files = []
  const walk = (dir) => { if (!existsSync(dir)) return; for (const name of readdirSync(dir)) { const p = join(dir, name); statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') && files.push(p) } }
  walk(box.sessionsDir)
  const notices = []
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('subagent-notification') && !line.includes('Subagent unfinished')) continue
    try { const j = JSON.parse(line); const text = JSON.stringify(j.message?.content ?? j.content ?? j).slice(0, 1500); notices.push(text) } catch {}
  }
  writeFileSync(join(out, 'subagent-notices-to-model.json'), JSON.stringify(notices, null, 1))
  console.log('发给模型的子代理通知', notices.length)
} catch (error) {
  console.log('FATAL', String(error?.stack ?? error))
} finally {
  writeFileSync(join(out, 'restart-checks.json'), JSON.stringify(checks, null, 1))
  try { current?.cdp.close() } catch {}
  if (current) killTree(current.app.child.pid)
  fake.server.close()
  await sleep(1500)
  rmSync(join(box.piDir, 'auth.json'), { force: true })
  process.exit(0)
}
