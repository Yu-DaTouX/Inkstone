/** 真实 Electron 窗口中的合成呈现检查；独立数据目录，无凭证与模型请求。 */
import './lib/stdio-guard.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const root = process.cwd()
const temp = await mkdtemp(join(tmpdir(), 'inkstone-subagent-feedback-'))
const evidence = resolve(`.local-docs/evidence/subagent-feedback-${Date.now()}`)
const electron = process.env.YAN_LIGHT_EXE || createRequire(import.meta.url)('electron')
await mkdir(evidence, { recursive: true })
try {
  for (const [name, theme, size] of [['dark', 'dark', '1440x900'], ['light', 'light', '1440x900'], ['narrow', 'dark', '940x900']]) {
    const base = join(temp, name), data = join(base, 'data'), pi = join(base, 'pi'), user = join(base, 'electron')
    await Promise.all([data, pi, user].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd: root, theme, locale: 'zh-CN', workspaceMode: 'coding', onboardingDone: true, remoteAccess: { enabled: false } }))
    await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false, packages: [] }))
    await writeFile(join(pi, 'auth.json'), '{}')
    const shot = join(evidence, `${name}.png`), receipt = join(base, 'result.txt')
    const env = { ...process.env, YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_USER_DATA: user,
      YAN_SESSIONS_DIR: join(pi, 'sessions'), YAN_REMOTE_ENABLE: '0',
      YAN_PROBE: join(root, 'scripts/probe/subagent-feedback.js'), YAN_PROBE_DELAY: '3000', YAN_PROBE_OUT: receipt,
      YAN_PROBE_SHOT: shot, YAN_PROBE_SHOT_DELAY: '3500', YAN_PROBE_SHOT_INTERVAL: '600', YAN_WIN: size }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    for (const key of Object.keys(env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete env[key]
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(electron, process.env.YAN_LIGHT_EXE ? [] : [join(root, 'out/main/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)) }, 45000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); resolveRun({ code, output }) })
    })
    const report = await readFile(receipt, 'utf8').catch(() => '')
    await writeFile(join(evidence, `${name}.log`), result.output + '\n' + report)
    console.log(`${name}: exit=${result.code}\n${report}`)
    if (result.code !== 0 || !report || report.includes('✗')) throw new Error(`${name} failed: ${evidence}`)
    const shots = (await readdir(evidence)).filter(file => file.startsWith(`${name}-`) && file.endsWith('.png')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (!shots.length) throw new Error(`${name}: missing screenshot`)
    await copyFile(join(evidence, shots.at(-1)), shot)
  }
  console.log(`Evidence: ${evidence}`)
} finally {
  // temp 是本脚本 mkdtemp 返回的唯一目录，不触及工作区与真实用户目录。
  await rm(temp, { recursive: true, force: true })
}
