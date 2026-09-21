/*
 * 钩子与安全点实测（实施-05 S1）。
 *
 * ── 它回答什么问题 ──
 * 实施-05 §4 / §6 有两处**不能靠读代码下结论**的可行性问题：
 *   ① `tool_call` 返回 `{block:true}` 到底拦不拦得住工具？（只读门禁要不要靠它）
 *   ② 钩子能不能「阻止下一个 provider 请求」，以及能不能在钩子里做压缩？
 *
 * 两者都涉及「第几个请求发没发出」「工具副作用有没有发生」—— 只有把模型换成
 * 假 provider（`scripts/lib/mock-provider.mjs`）才看得到。整个跑法不联网、不花钱。
 *
 * ── 用法 ──
 *   node scripts/hook-probe.mjs <mode> [--repo <path>]
 *     plain    不拦任何东西：第 1 个请求回文本，工具不执行（对照）
 *     payload  before_provider_request 返回改过的 payload：替换是否真的生效
 *
 * 另外三种专测**工作模式的工具门禁**（实施-05 S3，扩展是 resources/pi-extensions/work-mode.js）：
 *   workmode          clarify + 命令写文件 → 应被拦（marker 不出现 + tool_result blocked）
 *   workmode-standard standard + 同一条命令 → 应执行（marker 出现，对照）
 *   workmode-allow    clarify + 命令是 `yan goal status` → 应被**放行**（形状白名单）
 *     block    tool_call 返回 {block:true}：工具应当**不执行**，循环继续
 *     abort    before_provider_request 第 2 次调 ctx.abort()：第 2 个请求应当**不发出**
 *     compact  tool_call 里调 ctx.compact()：看它返回什么、当前 run 会怎样
 *
 * 另有两种专测**请求前预算门**（实施-05 S4，扩展是 resources/pi-extensions/context.js，
 * 完全走产品代码与产品的 `YAN_CONTEXT_POLICY` 通道）：
 *   budget       把输出预留拉到几乎等于窗口（装不下的线降到 ~5k）+
 *                工具产出 40 万字符 → 第 2 个请求应当**不发**（假 provider 只收到 1 个）
 *   budget-soft  把工作集上限降到 1000 → 第 2 个请求应当**照发**（只标 soft、不 abort，对照）
 *
 * 输出：假 provider 收到的请求清单 + 钩子时序 + 会话 JSONL + marker 文件是否出现。
 * 结论写进 `docs/plan/证据-05-S1-钩子与安全点.md`（改动后要重跑并更新那份证据）。
 *
 * ⚠️ 两个坑（都实测踩过）：
 *   1. spawn pi 时 **stdin 必须断开**（`stdio: ['ignore', ...]`）—— 默认 'pipe' 会让
 *      `--print` 一直等 stdin，现象是「钩子加载后就静默卡死」；
 *   2. 在 Windows 上必须用隔离的 `PI_CODING_AGENT_DIR` 放 `models.json` + `auth.json`，
 *      否则会把假 provider 写进用户真实目录。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : join(HERE, '..'))
const MODE = process.argv[2] ?? 'plain'
const PORT = 39891 + Math.floor(Math.random() * 50)

const root = mkdtempSync(join(tmpdir(), 's1-run-'))
const work = join(root, 'work')
const agentDir = join(root, 'agent')
const sessionDir = join(root, 'sessions')
for (const d of [work, agentDir, sessionDir]) mkdirSync(d, { recursive: true })

const dataDir = join(root, 'data')
const runnerId = 'probe-runner'
mkdirSync(join(dataDir, 'work-mode'), { recursive: true })
/* 目录要在 mkdtemp 之后建：这里顺带建 data/ */
const reqLog = join(root, 'requests.jsonl')
const extLog = join(root, 'hooks.jsonl')
const marker = join(work, 's1-marker.txt')

writeFileSync(reqLog, JSON.stringify({ at: new Date().toISOString(), event: 'boot', mode: MODE, port: PORT }) + '\n')
writeFileSync(extLog, JSON.stringify({ at: Date.now(), hook: 'boot', mode: MODE }) + '\n')
writeFileSync(
  join(agentDir, 'models.json'),
  JSON.stringify({
    providers: {
      s1mock: {
        name: 'S1 Mock',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        api: 'openai-completions',
        models: [{ id: 'mock', name: 'Mock', contextWindow: 200000, maxTokens: 4096 }]
      }
    }
  })
)
writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ s1mock: { type: 'api_key', key: 'dummy' } }))

/*
 * 预算门实验（实施-05 S4）：加载**真正随包**的 context.js，用它自己的
 * `YAN_CONTEXT_POLICY` 通道调预算。两种模式共用一份窗口（20 万，与 models.json 一致）：
 *   · budget     —— 输出预留 = 195k（safetyMarginMin 降到 1k 保证工作集仍 > 0）
 *                   → 装不下的线 = 200k − 195k = 5k：大工具结果必然超过；
 *   · budget-soft —— 工作集上限压到 1000（输出预留走默认）→ 只到 soft，不 physical。
 * `bodyChars` 会同时出现在假 provider 的请求日志里，用来校准估算。
 */
const BUDGET_MODES = {
  budget: { responseReservePreferred: 195000, responseReserveMin: 195000, safetyMarginMin: 1000 },
  'budget-soft': { workingSetCap: 1000 }
}

/* 门禁实验里「模型要求执行的那条命令」（默认写 marker 文件） */
const TOOL_COMMAND =
  MODE === 'workmode-allow'
    ? 'yan goal status'
    : BUDGET_MODES[MODE]
      ? /* 一个**大产出**的工具调用：让第 2 个请求真的装不下 */
        `node -e "process.stdout.write('x'.repeat(400000))"`
      : undefined

/** 门禁实验：给宿主侧快照写模式（真正的扩展读它决定工具表）。 */
const GATE_MODES = { workmode: 'clarify', 'workmode-standard': 'standard', 'workmode-allow': 'clarify' }
if (GATE_MODES[MODE]) {
  writeFileSync(
    join(dataDir, 'work-mode', `${runnerId}.json`),
    JSON.stringify({ version: 1, runtimeKey: runnerId, mode: GATE_MODES[MODE], revision: 1, at: new Date().toISOString() })
  )
}

const server = spawn(
  process.execPath,
  [
    join(REPO, 'scripts/lib/mock-provider.mjs'),
    String(PORT),
    reqLog,
    /* 只有 plain 不产生工具调用；其余三种都要先有一次工具调用才谈得上「下一次请求」 */
    MODE === 'plain' || MODE === 'payload' ? 'plain' : 'block'
  ],
  { stdio: 'inherit', env: { ...process.env, ...(TOOL_COMMAND ? { S1_TOOL_COMMAND: TOOL_COMMAND } : {}) } }
)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(500)

const args = [
  join(REPO, 'resources/pi-runtime/dist/bundle/cli.js'),
  '--print',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--session-dir',
  sessionDir,
  '--extension',
  join(HERE, 'lib/hook-probe-ext.mjs'),
  /* 门禁实验要加载真正随包的那个扩展（不是复刻它的逻辑） */
  ...(GATE_MODES[MODE] ? ['--extension', join(REPO, 'resources/pi-extensions/work-mode.js')] : []),
  /* 预算门实验同理：加载真正随包的上下文扩展 */
  ...(BUDGET_MODES[MODE] ? ['--extension', join(REPO, 'resources/pi-extensions/context.js')] : []),
  '--model',
  's1mock/mock',
  '--tools',
  /* 门禁实验要**故意多给**写工具：这样「澄清档把它们拿掉」才看得出来 */
  GATE_MODES[MODE] ? 'bash,read,write,edit' : 'bash,read',
  '请执行一次 bash 命令，然后回答 S1-DONE。'
]

const t0 = Date.now()
const child = spawn(process.execPath, args, {
  cwd: work,
  /* ⚠️ stdin 断开：默认 pipe 会让 pi 一直等 stdin（现象是加载完就静默卡住） */
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    S1_LOG: extLog,
    S1_MODE: MODE,
    ...(GATE_MODES[MODE]
      ? {
          YAN_DATA_DIR: dataDir,
          YAN_SESSION_ID: runnerId,
          YAN_WORK_MODE_EXT_LOG: join(root, 'work-mode-ext.jsonl')
        }
      : {}),
    ...(BUDGET_MODES[MODE]
      ? {
          YAN_DATA_DIR: dataDir,
          YAN_SESSION_ID: runnerId,
          YAN_CONTEXT_POLICY: JSON.stringify(BUDGET_MODES[MODE]),
          YAN_CONTEXT_EXT_LOG: join(root, 'context-ext.jsonl')
        }
      : {})
  }
})

let out = ''
let err = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (err += d))
const killer = setTimeout(() => {
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已经退出 */
  }
}, 90_000)
const code = await new Promise((r) => child.on('exit', (c) => r(c)))
clearTimeout(killer)
const elapsed = Date.now() - t0
server.kill()
await wait(200)

const readJsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

console.log(`### mode=${MODE} exit=${code} 用时=${elapsed}ms`)
console.log(`沙箱：${root}`)
console.log('--- pi stdout ---')
console.log(out.trim() || '(空)')
console.log('--- pi stderr ---')
console.log(err.trim().slice(0, 1200) || '(空)')
console.log('--- 假 provider 收到的请求 ---')
for (const r of readJsonl(reqLog)) console.log('  ' + JSON.stringify(r))
console.log('--- 钩子时序 ---')
for (const h of readJsonl(extLog)) console.log('  ' + JSON.stringify(h))
console.log('--- 会话文件 ---')
for (const f of readdirSync(sessionDir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl'))) {
  const lines = readJsonl(join(sessionDir, f))
  console.log(`  ${f}：${lines.length} 条`)
  for (const l of lines) console.log(`    ${l.type ?? l.role ?? '?'} :: ${JSON.stringify(l).slice(0, 240)}`)
}
console.log(`--- marker 文件：${existsSync(marker)} (${marker})`)
const modeLog = join(root, 'work-mode-ext.jsonl')
if (existsSync(modeLog)) {
  console.log('--- 工作模式策略扩展诊断（实施-05 S3 门禁） ---')
  for (const line of readFileSync(modeLog, 'utf8').trim().split('\n').filter(Boolean)) console.log('  ' + line)
}
const budgetLog = join(root, 'context-ext.jsonl')
if (existsSync(budgetLog)) {
  const rows = readFileSync(budgetLog, 'utf8').trim().split('\n').filter(Boolean)
  console.log('--- 请求前预算诊断（实施-05 S4） ---')
  for (const line of rows) {
    const parsed = JSON.parse(line)
    /* 只打预算相关的行：context 扩展平时还会写别的诊断（sweep / boot …） */
    if (/request-budget|budget-abort|sweep-forced-by-budget/.test(parsed.hook ?? '')) console.log('  ' + line)
  }
  const received = readJsonl(reqLog).filter((r) => typeof r.n === 'number' && r.n > 0)
  const abortRows = rows.filter((l) => /"hook":"budget-abort"/.test(l))
  console.log(
    `--- 结论：假 provider 收到 ${received.length} 个请求；预算 abort ${abortRows.length} 次 ` +
      `（physical 期望 1 / 1，soft 期望 2 / 0）---`
  )
}
