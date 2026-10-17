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

const server = spawn(
  process.execPath,
  [
    join(REPO, 'scripts/lib/mock-provider.mjs'),
    String(PORT),
    reqLog,
    MODE === 'plain' || MODE === 'payload' ? 'plain' : 'block'
  ],
  { stdio: 'inherit', env: { ...process.env } }
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
  '--model',
  's1mock/mock',
  '--tools',
  'bash,read',
  '请执行一次 bash 命令，然后回答 S1-DONE。'
]

const t0 = Date.now()
const child = spawn(process.execPath, args, {
  cwd: work,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    S1_LOG: extLog,
    S1_MODE: MODE
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
const budgetLog = join(root, 'context-ext.jsonl')
if (existsSync(budgetLog)) {
  const rows = readFileSync(budgetLog, 'utf8').trim().split('\n').filter(Boolean)
  console.log('--- 请求前预算诊断（实施-05 S4） ---')
  for (const line of rows) {
    const parsed = JSON.parse(line)
    if (/request-budget|budget-abort|sweep-forced-by-budget/.test(parsed.hook ?? '')) console.log('  ' + line)
  }
  const received = readJsonl(reqLog).filter((r) => typeof r.n === 'number' && r.n > 0)
  const abortRows = rows.filter((l) => /"hook":"budget-abort"/.test(l))
  console.log(
    `--- 结论：假 provider 收到 ${received.length} 个请求；预算 abort ${abortRows.length} 次 ` +
      `（physical 期望 1 / 1，soft 期望 2 / 0）---`
  )
}
