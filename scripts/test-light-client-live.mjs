import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve('.')
const electron = process.env.YAN_LIGHT_EXE || createRequire(import.meta.url)('electron')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-light-live-'))
const evidence = resolve(process.env.YAN_LIGHT_EVIDENCE || `.local-docs/evidence/light-client-${Date.now()}`)
await mkdir(evidence, { recursive: true })
try {
  for (const [name, theme, size] of [['light', 'light', '1440x1000'], ['dark', 'dark', '1440x1000'], ['narrow', 'dark', '940x900']]) {
    const base = join(temp, name), data = join(base, 'data'), pi = join(base, 'pi'), user = join(base, 'user')
    await Promise.all([data, pi, user].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd: base, theme, lang: 'zh-CN', onboardingDone: true, workspaceMode: 'daily', showSpaces: true, defaultWorkMode: 'clarify', appUpdate: { enabled: false }, remoteAccess: { enabled: false } }))
    await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false, packages: [] }))
    await writeFile(join(pi, 'auth.json'), '{}')
    if (process.env.YAN_LIGHT_INVALID_HISTORY === '1') {
      await mkdir(join(pi, 'sessions', 'invalid-fixture'), { recursive: true })
      await writeFile(join(pi, 'sessions', 'invalid-fixture', 'broken.jsonl'), '{invalid history}\n')
      await mkdir(join(data, 'attachments'), { recursive: true })
      await writeFile(join(data, 'attachments', 'ux-preserve.txt'), 'UX fixture: must survive rejected cleanup')
    }
    if (process.env.YAN_LIGHT_FIXTURE_SESSIONS === '1') {
      const sessions = join(pi, 'sessions', 'browser-fixture')
      await mkdir(sessions, { recursive: true })
      for (const [index, label] of ['A', 'B', 'C'].entries()) {
        const id = `00000000-0000-4000-8000-00000000000${index + 1}`
        const timestamp = new Date(Date.now() - index * 1000).toISOString()
        const rows = [
          { type: 'session', version: 3, id, timestamp, cwd: base },
          { type: 'message', id: `user-${label}`, parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: `Browser fixture ${label}` }], timestamp: Date.now() } }
        ]
        if (process.env.YAN_LIGHT_SCROLL_FIXTURES === '1') {
          const count = label === 'A' ? 40 : 240
          for (let n = 1; n < count; n++) rows.push({ type: 'message', id: `msg-${label}-${n}`, parentId: n === 1 ? `user-${label}` : `msg-${label}-${n - 1}`, timestamp,
            message: { role: 'user', content: [{ type: 'text', text: `Scroll fixture ${label} message ${n}\n` + '会话切换应保留阅读位置。'.repeat(30) }], timestamp: Date.now() } })
        }
        await writeFile(join(sessions, `${label}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      }
    }
    const legacy = '{"legacy":"preserve second-round history"}\n'
    await writeFile(join(data, 'goals.json'), legacy)
    // Retired retry state remains readable data; startup must not migrate or delete it.
    await writeFile(join(data, 'auto-continue.json'), legacy)
    const receipt = join(evidence, `${name}.txt`)
    const env = { ...process.env, YAN_USER_DATA: user, YAN_DATA_DIR: data, YAN_PI_DIR: pi, YAN_WIN: size,
      YAN_PROBE: resolve(process.env.YAN_LIGHT_PROBE || join(root, 'scripts/probe/light-client.js')), YAN_PROBE_DELAY: '3500', YAN_PROBE_OUT: receipt,
      YAN_PROBE_SHOT: join(evidence, `${name}.png`), YAN_PROBE_SHOT_DELAY: '6500', YAN_PROBE_SHOT_INTERVAL: '1000' }
    for (const key of Object.keys(env)) if (/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDECODE$|^YAN_CLI_|^YAN_SESSION_ID$|^YAN_PROJECT_ID$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete env[key]
    const result = await new Promise((resolveRun, reject) => {
      const child = spawn(electron, process.env.YAN_LIGHT_EXE ? [] : [join(root, 'out/main/index.js')], { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} timed out`)) }, 45000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); resolveRun({ code, output }) })
    })
    await writeFile(join(evidence, `${name}.log`), result.output)
    const text = await readFile(receipt, 'utf8').catch(() => '')
    if (result.code !== 0 || !text || text.includes('✗')) throw new Error(`${name} failed:\n${text}\n${result.output.slice(-2000)}`)
    for (const file of ['goals.json', 'auto-continue.json']) {
      if (await readFile(join(data, file), 'utf8') !== legacy) throw new Error(`Historical ${file} was modified`)
    }
    if (process.env.YAN_LIGHT_INVALID_HISTORY === '1' && await readFile(join(data, 'attachments', 'ux-preserve.txt'), 'utf8') !== 'UX fixture: must survive rejected cleanup') throw new Error('Rejected cleanup changed fixture attachment')
    console.log(`${name}: ${text.split('✓').length - 1} checks passed`)
  }
  console.log(`PASS: isolated Electron light/dark/narrow; evidence ${evidence}`)
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
