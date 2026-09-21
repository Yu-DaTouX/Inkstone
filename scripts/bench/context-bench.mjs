/*
 * N21-9 A/B 跑批器（实施-06 S2 后半）。
 *
 * ════════════════════════════════════════════════════════════
 * 它做什么、现在还差什么
 * ════════════════════════════════════════════════════════════
 * 对**四组策略 × 合成任务集**各跑一遍，收交付物 → 逐条判分 → 交给
 * `compareStrategies` 出「该策略在当前实现下的收益成立 / 不成立 / 数据不足」。
 * 口径与任务集分别在 `src/shared/context-bench.ts` 与 `scripts/bench/context-tasks.mjs`
 * （口径已冻、有 63 条单测；这里只做**编排**）。
 *
 * ⚠️ 两种模式的区别**必须看清楚**：
 *
 *   · `--mock`（默认）—— 假 provider（`scripts/lib/mock-provider.mjs`），**cost 0**。
 *     它证明的是**装置能跑通**（pi 起得来、`YAN_CONTEXT_POLICY` 真的传到了产品扩展、
 *     交付物收得到、判分与对比出得来）。**不要把它当基准结论** —— 假模型不会
 *     因为上下文被压就丢掉约束，四组的 LCR 必然相同。
 *   · `--live` —— 真实模型。**要额度**（TESTING：默认免费档已退役 403，cost 1
 *     场景固定 `deepseek/deepseek-v4.1-flash`）。本文件写下时它**还没有在真模型上跑过**，
 *     第一次跑的人要按下面的顺序来：
 *       ① 先 `--mock` 确认装置没坏（不花钱）；
 *       ② 再 `--live --tasks=1 --strategies=A,C` 跑最小一组，看交付物是不是真在回答；
 *       ③ 确认无误再放开到全量（4 × 3 = 12 次）。
 *
 * 用法：
 *   node scripts/bench/context-bench.mjs [--mock|--live] [--tasks=magic-style,naming-format]
 *                                       [--strategies=A,B,C,D] [--out=路径.json] [--timeout=180]
 *
 * 运行环境：必须 `env -u ELECTRON_RUN_AS_NODE`（外层可能带着它，带着就会当纯 Node 跑）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from '../../node_modules/esbuild/lib/main.js'
import { BENCH_TASKS } from './context-tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PI_CLI = join(REPO, 'resources/pi-runtime/dist/bundle/cli.js')
const CONTEXT_EXT = join(REPO, 'resources/pi-extensions/context.js')
const MOCK_PROVIDER = join(REPO, 'scripts/lib/mock-provider.mjs')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const LIVE = hasFlag('live')
const ONLY_TASKS = arg('tasks', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ONLY_STRATEGIES = arg('strategies', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const OUT_PATH = arg('out', join(REPO, 'out', `context-bench-${LIVE ? 'live' : 'mock'}.json`))
const PER_RUN_TIMEOUT_MS = Number(arg('timeout', '240')) * 1000
/**
 * 每组重复几次。
 *
 * 口径要的是「**每组多次**」：单次跑批的 LCR 波动很大（同一组两个任务可以一个全守住、
 * 一个丢一半），只跑一次很容易把随机波动读成策略差异。报告里会把重复次数写清楚 ——
 * 样本量不够时不能声称「差异显著」。
 */
const REPEATS = Math.max(1, Number(arg('repeats', '1')))
/** live 模式的模型：与其它 cost 1 场景同一个默认（免费档已 403） */
const LIVE_MODEL = process.env.YAN_TEST_MODEL || 'deepseek/deepseek-v4.1-flash'
/** 工作集压到很小，几轮就能触发压缩 —— 否则要几十万 token 才到线 */
const LIVE_POLICY_EXTRA = { workingSetCap: 6000, triggerRatios: { sweep: 0.7, fold: 0.85, compact: 1 } }

/* 口径模块是 TS：用 esbuild 现场编译一份（与单测同一条路，避免依赖 out/test 是否新鲜） */
buildSync({
  entryPoints: [join(REPO, 'src/shared/context-bench.ts')],
  outfile: join(REPO, 'out/test/context-bench-bench.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent'
})
const bench = await import(`file://${join(REPO, 'out/test/context-bench-bench.mjs').replace(/\\/g, '/')}`)

const tasks = BENCH_TASKS.filter((t) => (ONLY_TASKS.length ? ONLY_TASKS.includes(t.id) : true))
const strategies = bench.BENCH_STRATEGIES.filter((s) => (ONLY_STRATEGIES.length ? ONLY_STRATEGIES.includes(s.id) : true))
if (!tasks.length || !strategies.length) {
  console.error('筛选后没有可跑的任务或策略 —— 检查 --tasks / --strategies')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()

/**
 * 把一个任务拼成一次 `--print` 调用。
 *
 * 结构按「用户在长会话里只提过一次约定，后面全靠模型自己记」来编排：
 *
 *   【执行清单】第 1 条就是一条 `echo`，把约定打出来 —— 也就是说约束出现在**工具输出**里，
 *              不是用户消息里；接着一整串与交付无关的大输出把它淹没；
 *   【最后一步】只说要什么产物，**不点名**那几条约定。
 *
 * ⚠️ 为何把约定改成「工具输出里一次」（2026-09-19 第二次校准后）：
 *   前一版把约定写成用户消息里的「【背景】…记一下」，结果两边校准 A 组丢失率只有
 *   10% / 8.3% —— 因为用户显式交代的约定会被压缩摘要**当成核心要求保留**。
 *   真实丢失场景是「在一次命令输出 / 一次探索里看到过」，而且那正是产品里
 *   `tool-sweep` / `recall` 这两个阶段要救的东西 —— 测不到它们的差异，就是把策略
 *   放在了一个与它无关的赛道上。
 *
 * ⚠️ `echo` 里不能出现变量、反引号或 `$`（约束文案是数据，将来改文案时别引入这些）。
 */
function buildPrompt(task) {
  const conventions = task.constraints.map((c) => c.text).join('；')
  const lines = [
    '【执行清单】依次执行下面每一条命令（把输出读完，它们与最终交付无关）。',
    `1. echo "背景约定（只此一次）：${conventions}"`,
    ...task.filler.map((f, i) => `${i + 2}. ${f}`),
    '',
    `【最后一步】${task.deliverable}`,
    '',
    '直接给出交付内容。'
  ]
  return lines.join('\n')
}

/** 起假 provider（mock 模式） */
async function startMock(port, reqLog, toolCommand) {
  const child = spawn(process.execPath, [MOCK_PROVIDER, String(port), reqLog, 'block'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, S1_TOOL_COMMAND: toolCommand }
  })
  await sleep(400)
  return child
}

/** 跑一组（一个策略 × 一个任务）；返回 StrategyRun 形状 */
async function runOne(strategy, task, index) {
  const root = mkdtempSync(join(tmpdir(), `yan-bench-${strategy.id}-`))
  const work = join(root, 'work')
  const agentDir = join(root, 'agent')
  const sessionDir = join(root, 'sessions')
  for (const d of [work, agentDir, sessionDir]) mkdirSync(d, { recursive: true })

  const port = 40100 + (index % 200)
  const reqLog = join(root, 'requests.jsonl')
  writeFileSync(reqLog, '')
  let mock = null
  let model = LIVE_MODEL

  if (!LIVE) {
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          benchmock: {
            name: 'Bench Mock',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            models: [{ id: 'mock', name: 'Mock', contextWindow: 200000, maxTokens: 4096 }]
          }
        }
      })
    )
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ benchmock: { type: 'api_key', key: 'dummy' } }))
    mock = await startMock(port, reqLog, task.filler[0])
    model = 'benchmock/mock'
  }

  const policy = LIVE ? { ...bench.benchPolicyPatch(strategy.id), ...LIVE_POLICY_EXTRA } : bench.benchPolicyPatch(strategy.id)
  const extLog = join(root, 'context-ext.jsonl')
  writeFileSync(extLog, '')

  const env = { ...process.env, PI_SKIP_VERSION_CHECK: '1' }
  /* 两层环境注入都要清掉：外层砚实例注入的变量会把这个子进程引到真实实例上 */
  for (const k of ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) delete env[k]
  Object.assign(env, {
    YAN_CONTEXT_POLICY: JSON.stringify(policy),
    YAN_CONTEXT_EXT_LOG: extLog,
    YAN_DATA_DIR: join(root, 'data'),
    YAN_SESSION_ID: `bench-${strategy.id}-${task.id}`,
    ...(LIVE ? {} : { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' })
  })
  mkdirSync(env.YAN_DATA_DIR, { recursive: true })

  const args = [
    PI_CLI,
    '--print',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--session-dir',
    sessionDir,
    '--extension',
    CONTEXT_EXT,
    '--model',
    model,
    '--tools',
    'bash,read',
    buildPrompt(task)
  ]

  const started = Date.now()
  const child = spawn(process.execPath, args, {
    cwd: work,
    /* stdin 必须断开：默认 pipe 会让 --print 一直等 stdin（加载完就静默卡住） */
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const killer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }, PER_RUN_TIMEOUT_MS)
  const code = await new Promise((r) => child.on('exit', (c) => r(c)))
  clearTimeout(killer)
  if (mock) mock.kill()

  /* 压缩发生过没有 —— 没发生过的话「四组有差异」这件事根本无从谈起 */
  let folds = 0
  try {
    folds = readFileSync(extLog, 'utf8')
      .split('\n')
      .filter((l) => /compact|fold|sweep/i.test(l)).length
  } catch {
    /* 日志不存在 → 0 */
  }

  const deliverable = stdout.trim()
  const outcomes = bench.judgeConstraints(deliverable, task.constraints)

  /*
   * 诊断材料：交付物开头 + 每条**没守住**的约束**到底匹配到了什么**。
   *
   * 为什么必须存这两样：2026-09-19 第一轮就是拿不出原文，才把「模型写“不要用 git reset”」
   * 误读成「策略丢了约束」。禁止类约束的**假阳性**只能靠命中片段人工辨认，
   * 报告里没有它就无法事后追查。
   */
  const findHit = (text, check) => {
    try {
      if (check.kind === 'must-include' || check.kind === 'must-exclude') {
        const i = text.indexOf(check.needle)
        return i < 0 ? null : { at: i, snippet: text.slice(Math.max(0, i - 70), i + 70) }
      }
      const m = new RegExp(check.pattern, check.flags ?? '').exec(text)
      return m ? { at: m.index, snippet: text.slice(Math.max(0, m.index - 70), m.index + 70) } : null
    } catch {
      return null
    }
  }
  const lostHits = outcomes
    .filter((o) => !o.kept)
    .map((o) => {
      const spec = task.constraints.find((c) => c.id === o.constraintId)
      return {
        id: o.constraintId,
        text: spec?.text ?? '',
        check: spec?.check ?? null,
        hit: spec ? findHit(deliverable, spec.check) : null
      }
    })

  const run = {
    strategyId: strategy.id,
    taskId: task.id,
    success: deliverable.length >= 20,
    outcomes,
    /* 诊断字段（不参与判分，但报告里要看得到） */
    exitCode: code,
    ms: Date.now() - started,
    stdoutChars: deliverable.length,
    deliverableSample: deliverable.slice(0, 240),
    lostHits,
    stderrTail: stderr.trim().split('\n').slice(-3).join(' | '),
    contextDiagnostics: folds,
    requests: existsSync(reqLog) ? readFileSync(reqLog, 'utf8').trim().split('\n').filter(Boolean).length : 0
  }
  rmSync(root, { recursive: true, force: true })
  return run
}

/* ------------------------------------------------------------------ 主流程 */

const plan = {
  mode: LIVE ? 'live' : 'mock',
  repeats: REPEATS,
  tasks: tasks.map((t) => t.id),
  strategies: strategies.map((s) => s.id)
}
const totalRuns = tasks.length * strategies.length * REPEATS
console.log(`▸ N21-9 跑批：${plan.mode === 'mock' ? '假 provider（装置校验，cost 0）' : `真实模型 ${LIVE_MODEL}（要额度）`}`)
console.log(
  `  任务 ${plan.tasks.join(' / ')} ｜ 策略 ${plan.strategies.join(' / ')} ｜ 每组 ${REPEATS} 次 ｜ 共 ${totalRuns} 次`
)
if (plan.mode === 'mock') console.log('  ⚠️ mock 模式的结论**不是基准结论** —— 它只证明装置能跑通')

const runs = []
let i = 0
for (const task of tasks) {
  for (const strategy of strategies) {
    for (let rep = 1; rep <= REPEATS; rep += 1) {
      i += 1
      process.stdout.write(
        `  [${i}/${totalRuns}] ${strategy.id} × ${task.id}${REPEATS > 1 ? ` #${rep}` : ''} … `
      )
      const run = await runOne(strategy, task, i)
      run.repeat = rep
      runs.push(run)
      console.log(
        `exit=${run.exitCode} ${run.ms}ms 出字=${run.stdoutChars} 守住=${run.outcomes.filter((o) => o.kept).length}/${run.outcomes.length} 诊断=${run.contextDiagnostics}`
      )
    }
  }
}

const byStrategy = (id) => runs.filter((r) => r.strategyId === id)
const summary = strategies.map((s) => {
  const list = byStrategy(s.id)
  return {
    id: s.id,
    title: s.title,
    kinds: s.kinds,
    lcr: bench.lostConstraintRate(list),
    success: bench.successRate(list),
    runs: list.length,
    hasSignal: bench.hasSignal(list)
  }
})

/* 主判据：最该看清的两组对照 —— A→C（State-First 值不值）与 C→D（Trace 值不值） */
const comparisons = []
const pick = (id) => byStrategy(id)
for (const [baseId, candId] of [
  ['A', 'C'],
  ['C', 'D']
]) {
  if (!strategies.some((s) => s.id === baseId) || !strategies.some((s) => s.id === candId)) continue
  comparisons.push(bench.compareStrategies(pick(baseId), pick(candId), { baselineId: baseId, candidateId: candId }))
}

console.log('')
console.log('▸ 各组结果')
for (const s of summary) {
  console.log(
    `  ${s.id} ${s.title.padEnd(18, ' ')} LCR ${bench.pct(s.lcr).padStart(6)}  成功率 ${bench.pct(s.success).padStart(6)}  ${s.hasSignal ? '' : '（无可判条次）'}`
  )
}
console.log('')
console.log('▸ 主判据')
for (const c of comparisons) {
  console.log(`  ${c.baselineId} → ${c.candidateId}：${c.verdict}`)
  for (const r of c.reasons) console.log(`      · ${r}`)
}

const report = {
  at: now(),
  mode: plan.mode,
  model: LIVE ? LIVE_MODEL : 'benchmock/mock',
  plan,
  /** mock 模式的报告自带这条警告，防止有人把它当结论引用 */
  caveat: LIVE ? null : 'mock 装置校验：四组跑的是同一个假模型，LCR 差异没有研究意义',
  summary,
  comparisons,
  runs
}
mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8')
console.log('')
console.log(`报告已写入 ${OUT_PATH}`)
process.exit(0)
