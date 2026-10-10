/**
 * 可视化回答的真实模型验收（显式 --real 才会请求模型）。
 *
 *   node scripts/test-visual-answer-live.mjs --real --model haiku     # claude-bridge/claude-haiku-5-5 · low（本机已装 pi-claude-bridge）
 *   node scripts/test-visual-answer-live.mjs --real --model luna      # openai-codex/gpt-6-luna · low（只复制这一项 OAuth）
 *   node scripts/test-visual-answer-live.mjs --real --model deepseek  # commandcode/deepseek-v4.1-flash（只复制这一项 key）
 *   node scripts/test-visual-answer-live.mjs --real --model sol       # openai-codex/gpt-6.1-sol · low（只复制这一项 OAuth）
 *
 * 隔离数据目录启动完整 Electron；探针确认模型与档位后才发送；截图与日志存新的本地证据目录。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (!process.argv.includes('--real') && !process.argv.includes('--real-haiku')) throw new Error('Real model calls require --real')
const preset = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'haiku'
const PRESETS = {
  haiku: { provider: 'claude-bridge', model: 'claude-haiku-5-5', thinking: 'low', auth: null },
  luna: { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'low', auth: 'openai-codex' },
  sol: { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low', auth: 'openai-codex' },
  deepseek: { provider: 'commandcode', model: 'deepseek-v4.1-flash', thinking: process.env.YAN_DEEPSEEK_THINKING || 'any', auth: 'commandcode' }
}
const target = PRESETS[preset]
if (!target) throw new Error('Unknown --model ' + preset)

const root = resolve('.')
const temp = await mkdtemp(join(tmpdir(), `inkstone-visual-${preset}-`))
const evidence = join(root, '.local-docs/evidence', `visual-answer-${preset}-${Date.now()}`)
await mkdir(evidence, { recursive: true })
const data = join(temp, 'data'), pi = join(temp, 'pi'), user = join(temp, 'electron'), cwd = join(temp, 'work')
await Promise.all([data, pi, user, cwd].map((p) => mkdir(p, { recursive: true })))
await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd, theme: 'dark', lang: 'zh-CN', locale: 'zh-CN', onboardingDone: true, appUpdate: { enabled: false }, remoteAccess: { enabled: false } }))

/* 只复制所需的那一项凭证；Claude 订阅走本机 Claude Code 登录，不复制任何凭证 */
const auth = {}
if (target.auth) {
  const source = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8'))
  if (!source[target.auth]) throw new Error(`本机 pi 没有 ${target.auth} 凭证`)
  auth[target.auth] = source[target.auth]
}
await writeFile(join(pi, 'auth.json'), JSON.stringify(auth))
const packages = []
if (preset === 'haiku') {
  const bridge = process.env.YAN_CC_TEST_BRIDGE || join(homedir(), '.pi/agent/npm/node_modules/pi-claude-bridge')
  if (!existsSync(join(bridge, 'package.json'))) throw new Error('pi-claude-bridge not found: ' + bridge)
  packages.push(bridge)
  await writeFile(join(pi, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: '2026-10-08', askClaude: { enabled: false }, provider: { plan: 'pro', longContextExtraUsage: false, strictMcpConfig: true, pathToClaudeCodeExecutable: process.env.YAN_CC_TEST_EXECUTABLE || join(homedir(), '.local/bin/claude.exe') } }))
}
await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false, packages, defaultProvider: target.provider, defaultModel: target.model, ...(target.thinking !== 'any' ? { defaultThinkingLevel: target.thinking } : {}), compaction: { enabled: false } }))

const probeSource = (await readFile(join(root, 'scripts/probe/visual-answer.js'), 'utf8')).replaceAll('__MODEL__', target.model).replaceAll('__THINKING__', target.thinking)
const probe = join(temp, 'visual-answer-probe.js')
await writeFile(probe, probeSource)
const env = { ...process.env, YAN_DATA_DIR: data, YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_USER_DATA: user,
  YAN_PROBE: probe, YAN_PROBE_DELAY: '5000', YAN_WIN: process.env.YAN_WIN || '1440x1000',
  YAN_PROBE_OUT: join(evidence, 'probe.log'), YAN_PROBE_SHOT: join(evidence, 'shot.png'), YAN_PROBE_SHOT_DELAY: '8000', YAN_PROBE_SHOT_INTERVAL: '3000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: '0' }
for (const key of Object.keys(env)) if (/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDE_CODE_OAUTH_TOKEN$|^CLAUDECODE$|^YAN_CLI_|^YAN_REMOTE_|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete env[key]
const child = spawn(createRequire(import.meta.url)('electron'), [join(root, 'out/main/index.js')], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', (c) => { output += c }); child.stderr.on('data', (c) => { output += c })
const timer = setTimeout(() => child.kill(), 330000)
await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
clearTimeout(timer)
await writeFile(join(evidence, 'electron.log'), output)
const result = await readFile(join(evidence, 'probe.log'), 'utf8').catch(() => '(no probe output)\n' + output.slice(-3000))
console.log(result)
console.log('Evidence: ' + evidence)
