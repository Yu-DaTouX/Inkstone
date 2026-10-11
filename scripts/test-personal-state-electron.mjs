/** Isolated component integration: actual preload/IPC, React hook and sandbox DOM bridge; not the full app UI. */
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const root = await mkdtemp(join(tmpdir(), 'inkstone-interaction-electron-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-interaction-electron-'))
const electron = createRequire(import.meta.url)('electron')
const env = { ...process.env, YAN_USER_DATA: join(root, 'electron'), YAN_DATA_DIR: join(root, 'data'), YAN_PI_DIR: join(root, 'pi'), YAN_SESSIONS_DIR: join(root, 'sessions') }
delete env.ELECTRON_RUN_AS_NODE
for (const key of Object.keys(env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete env[key]
try {
  for (const key of ['YAN_USER_DATA', 'YAN_DATA_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR']) await mkdir(env[key])
  await build({ entryPoints: ['scripts/fixtures/reliability/interaction-main.ts'], outfile: join(compiled, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['src/preload/index.ts'], outfile: join(compiled, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['scripts/fixtures/reliability/interaction-renderer.tsx'], outfile: join(compiled, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; frame-src \'self\' about:; connect-src \'none\'"></head><body><h1>Interaction IPC component fixture</h1><div id="root"></div><script src="renderer.js"></script></body></html>')
  let total = 0
  for (const phase of ['write', 'restart']) {
    const result = await new Promise((done, reject) => {
      const child = spawn(electron, [join(compiled, 'main.cjs')], { env: { ...env, INTERACTION_TEST_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('Electron fixture timeout')) }, 60000)
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, output }) })
    })
    console.log(result.output)
    assert.equal(result.code, 0, `${phase} phase failed`)
    const report = result.output.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.phase === phase && value.passed)
    assert.ok(report, 'structured result missing')
    total += report.checks
  }
  console.log(`personal-state-electron: ${total} checks passed (formal preload/IPC, process restart, actual sandbox iframe; component harness only)`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(compiled, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
