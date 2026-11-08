import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectCdp, launchApp, holdProbe, killTree } from './lib/app.mjs'
import { freePort, newRunDir, sleep } from './lib/env.mjs'
import { startFakeModel } from './lib/fake-model.mjs'
import { createSandbox, sandboxEnv } from './lib/sandbox.mjs'
import { importUserData } from './lib/user-data.mjs'
import { demoEnv, initializeDemo, prepareDemo } from './lib/demo.mjs'
import { initializeCards, prepareCards } from './lib/card-gallery.mjs'
import { scenarioContext } from './lib/scenario-context.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const [scriptArg, outArg] = args.filter((arg, i) => !arg.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && ['timeout-min', 'days', 'real-model', 'include-sessions', 'env'].includes(args[i - 1].slice(2))))
if (!scriptArg || !outArg) {
  console.log('用法：node debug/review.mjs <审查脚本.mjs> <截图目录> [--demo] [--cards] [--no-user-data] [--days 7] [--include-sessions 片段,片段] [--timeout-min 8] [--real-model commandcode/deepseek/deepseek-v4.1-flash]')
  process.exit(1)
}
const script = resolve(scriptArg)
const out = resolve(outArg)
mkdirSync(out, { recursive: true })
const timeoutMin = Number(value('timeout-min', 8))
const t0 = Date.now()
const at = (label) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s] ${label}`)

delete process.env.ELECTRON_RUN_AS_NODE
const fake = await startFakeModel()
const runDir = newRunDir(`review-${basename(script, '.mjs')}`)
const box = createSandbox(runDir, { fakePort: fake.port, samples: [], demo: flag('demo') })
const sandboxProject = box.project
if (!flag('no-user-data')) at('真实数据副本 ' + JSON.stringify(importUserData(box, { days: Number(value('days', 7)), include: String(value('include-sessions', '')).split(',').filter(Boolean) })))
if (flag('demo')) { prepareDemo(box); at('演示仓库就绪') }
if (flag('cards')) { prepareCards(box); at('卡片会话就绪') }
const realModel = value('real-model', null)
const realEnv = {}
args.forEach((arg, i) => { if (args[i - 1] === '--env' && arg.includes('=')) realEnv[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1) })
const REAL_MODELS = { 'commandcode/deepseek/deepseek-v4.1-flash': 'commandcode', 'anthropic/claude-haiku-5-5': 'anthropic', 'openai-codex/gpt-6-luna': 'openai-codex' }
if (realModel) {
  const provider = REAL_MODELS[realModel]
  if (!provider) { console.log('--real-model 只允许：' + Object.keys(REAL_MODELS).join('、')); process.exit(1) }
  const entry = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'))[provider]
  if (!entry) { console.log('本机没有 ' + provider + ' 凭据'); process.exit(1) }
  if (provider === 'commandcode') realEnv.COMMANDCODE_API_KEY = entry.key
  else writeFileSync(join(box.piDir, 'auth.json'), JSON.stringify({ [provider]: provider === 'anthropic' ? { ...entry, refresh: 'disabled-in-sandbox' } : entry }))
  realEnv.YAN_TEST_MODEL = realModel
  at(`真实模型 ${realModel}（凭据只进实例环境变量或隔离目录，结束即删）`)
}
const cdpPort = await freePort()
const app = launchApp({ ...sandboxEnv(box, { fake: true, cdpPort, probe: holdProbe }), ...demoEnv(box), ...realEnv })
at(`实例 pid ${app.child.pid} cdp ${cdpPort} 运行目录 ${runDir}`)

const report = { script, out, runDir, realModel, startedAt: new Date().toISOString(), sandboxProject, demoProject: box.demo?.project ?? null, checks: [], timings: {}, log: [] }
let cdp
let finished = false
const finish = async (code) => {
  if (finished) return
  finished = true
  try { await cdp?.evaluate('window.__probeDone && window.__probeDone(1)') } catch {}
  try { cdp?.close() } catch {}
  await sleep(500)
  report.mainLogTail = app.log().slice(-4000)
  killTree(app.child.pid)
  await sleep(1500)
  try { rmSync(join(box.piDir, 'auth.json'), { force: true }) } catch {}
  fake.server.close()
  writeFileSync(resolve(out, `run-${basename(script, '.mjs')}.json`), JSON.stringify(report, null, 2))
  at(`${code === 0 ? '完成' : '失败'}，报告 ${resolve(out, `run-${basename(script, '.mjs')}.json`)}`)
  process.exit(code)
}
const watchdog = setTimeout(() => { report.fatal = `超过 ${timeoutMin} 分钟总时限，强制结束`; at(report.fatal); void finish(2) }, timeoutMin * 60000)
process.on('SIGINT', () => void finish(130))

try {
  cdp = await connectCdp(cdpPort, { shotDir: out })
  at('CDP 已连接')
  if (box.cards) { await initializeCards(cdp, box); at('卡片会话初始化') }
  if (box.demo) { await initializeDemo(cdp, box); at('演示数据初始化') }
  const ctx = scenarioContext({ cdp, fake, box, runDir, report })
  if (!(await ctx.until('true', 30000))) throw new Error('渲染端没有暴露 __yanStore')
  if (!(await ctx.until('s.conn === "ready"', 60000))) at('警告：60 秒内 conn 未 ready')
  at('store 就绪')
  cdp.evaluate('window.yan.win.maximize()').catch(() => {})
  await ctx.until('innerWidth >= screen.availWidth - 40', 5000)
  let last = ''
  let steady = 0
  for (let i = 0; i < 40 && steady < 7; i++) {
    await sleep(250)
    const now = await cdp.evaluate('`${innerWidth}x${innerHeight}@${devicePixelRatio}`')
    steady = now === last ? steady + 1 : 0
    last = now
  }
  const layout = await cdp.evaluate(`({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, screen: [screen.availWidth, screen.availHeight], theme: document.documentElement.dataset.theme ?? document.documentElement.className, settings: (() => { const st = window.__yanStore.getState().settings ?? {}; return { theme: st.theme, lang: st.lang, density: st.density, sidebarLayout: st.sidebarLayout } })() })`)
  at('布局 ' + JSON.stringify(layout))
  report.layout = layout
  const shot = (name) => cdp.shot(name, out)
  const live = async (text, opts) => {
    const cwd = await ctx.state('s.session?.cwd')
    if (cwd !== box.project && cwd !== sandboxProject && cwd !== box.demo?.project && cwd !== box.demo?.second) await ctx.newSession(sandboxProject)
    return ctx.turn(text, opts)
  }
  const mod = await import(pathToFileURL(script).href)
  await mod.default({ ...ctx, shot, out, sandboxProject, live, at })
  const errors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'))
  report.consoleErrors = errors.map((event) => (event.params.exceptionDetails?.exception?.description ?? event.params.args?.map((arg) => arg.value ?? arg.description).join(' ') ?? '').slice(0, 300))
  clearTimeout(watchdog)
  await finish(0)
} catch (error) {
  report.fatal = String(error?.stack ?? error)
  at('FATAL ' + report.fatal)
  try { await cdp?.shot('fatal', out) } catch {}
  clearTimeout(watchdog)
  await finish(1)
}
