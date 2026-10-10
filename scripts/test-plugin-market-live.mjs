import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-market-live-'))
const evidence = join(root, '.local-docs/evidence', `plugin-market-${Date.now()}`)
await mkdir(evidence, { recursive: true })
try {
  for (const [name, theme, size] of [['dark', 'dark', '1440x1000'], ['light', 'light', '1440x1000'], ['narrow', 'dark', '940x900']]) {
    const base = join(temp, name), data = join(base, 'data'), pi = join(base, 'pi'), user = join(base, 'electron')
    await Promise.all([data, pi, user].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd: base, theme, locale: 'zh-CN', onboardingDone: true, appUpdate: { enabled: false }, remoteAccess: { enabled: false } }))
    await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false, packages: [] }))
    await writeFile(join(pi, 'auth.json'), '{}')
    const env = { ...process.env, YAN_DATA_DIR: data, YAN_PI_DIR: pi, YAN_USER_DATA: user,
      YAN_PROBE: join(root, 'scripts/probe/plugin-market.js'), YAN_PROBE_DELAY: '500', YAN_WIN: size,
      YAN_PROBE_OUT: join(evidence, `${name}.log`), YAN_PROBE_SHOT: join(evidence, `${name}.png`),
      YAN_PROBE_SHOT_DELAY: '2000', YAN_PROBE_SHOT_INTERVAL: '1500' }
    for (const key of Object.keys(env)) if (/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDECODE$|^YAN_CLI_|^YAN_REMOTE_|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete env[key]
    let output = ''
    const child = spawn(process.env.YAN_LIGHT_EXE || createRequire(import.meta.url)('electron'), process.env.YAN_LIGHT_EXE ? [] : [join(root, 'out/main/index.js')], { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), 45000)
    await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject) })
    clearTimeout(timer)
    const checks = await readFile(join(evidence, `${name}.log`), 'utf8').catch(() => output)
    if (checks.includes('FAIL ') || !checks.includes('PASS 搜索支持键盘焦点')) throw Error(`${name}: ${checks}`)
    const shots = (await readdir(evidence)).filter(file => file.startsWith(name + '-') && file.endsWith('.png'))
    if (shots.length < 2) throw Error(`${name}: screenshots missing`)
    console.log(`${name}: ${checks.split('\n').filter(line => line.startsWith('PASS ')).length} checks passed; ${shots.length} screenshots`)
  }
  console.log('Evidence: ' + evidence)
} finally { await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }) }
