/** Python plugin against isolated real Electron + pi. Never sends a model prompt. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runHermesPhoneProbe } from './lib/hermes-phone-probe.mjs'

const root = resolve('.')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-hermes-desktop-'))
let app
let fixtureMain
try {
  const reservation = createServer()
  await new Promise(resolveReady => reservation.listen(0, '127.0.0.1', resolveReady))
  const port = reservation.address().port
  await new Promise(resolveClosed => reservation.close(resolveClosed))
  const token = randomUUID()
  const url = `http://127.0.0.1:${port}`
  const data = join(temp, 'data'), pi = join(temp, 'pi'), user = join(temp, 'user'), sessions = join(pi, 'sessions', 'fixture')
  await Promise.all([data, pi, user, sessions].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(data, 'desktop.json'), JSON.stringify({ cwd: temp, onboardingDone: true, appUpdate: { enabled: false }, remoteAccess: { enabled: false } }))
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ enableMcp: false, packages: [] }))
  await writeFile(join(pi, 'auth.json'), '{}')
  const id = '00000000-0000-4000-8000-000000000021', timestamp = new Date().toISOString()
  await writeFile(join(data, 'remote-devices.json'), JSON.stringify({ version: 1, devices: [{
    id: randomUUID(), name: 'Hermes isolated fixture', kind: 'phone', createdAt: Date.now(),
    lastSeenAt: null, revokedAt: null, tokenHash: createHash('sha256').update(token).digest('hex')
  }] }))
  const approvalResult = join(temp, 'approval-result.json')
  const extension = join(temp, 'approval-fixture.ts')
  await writeFile(extension, `import { writeFileSync } from 'node:fs';
export default function(pi) {
  pi.registerCommand('inkstone-probe', {description:'Harmless phone routing check', handler:async () => {
    writeFileSync(${JSON.stringify(approvalResult + '.send')}, JSON.stringify({received:true}));
  }});
  let started = false;
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(${JSON.stringify(approvalResult + '.debug')}, JSON.stringify({session:ctx.sessionManager.getSessionId(), hasUrl:!!process.env.YAN_CLI_URL}));
    if (started || ctx.sessionManager.getSessionId() !== ${JSON.stringify(id)}) return;
    started = true;
    setTimeout(async () => {
      const results = [];
      try {
        const answer = await ctx.ui.input('Hermes ordinary question fixture', 'Reply with phone-ok');
        writeFileSync(${JSON.stringify(approvalResult + '.question')}, JSON.stringify({answer}));
        for (const label of ['allow', 'deny']) {
          const response = await fetch(process.env.YAN_CLI_URL, {
            method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + process.env.YAN_CLI_TOKEN},
            body: JSON.stringify({apiVersion:1, command:'danger.confirm', sessionId:process.env.YAN_SESSION_ID,
              projectId:process.env.YAN_PROJECT_ID, params:{tool:'bash', detail:'Hermes approval fixture ' + label,
                reasons:['Synthetic confirmation only; no command will execute']}})
          });
          results.push(await response.json());
          writeFileSync(${JSON.stringify(approvalResult)}, JSON.stringify(results));
        }
      } catch (error) { writeFileSync(${JSON.stringify(approvalResult)}, JSON.stringify({error:String(error)})); }
    }, 500);
  });
}`)
  // Production disables automatic extension discovery. Inject only the harmless
  // synthetic extension path into a disposable copy of the compiled entrypoint.
  const main = await readFile(join(root, 'out/main/index.js'), 'utf8')
  const marker = 'return yanThinResourcePath("danger-guard.js");'
  if (main.split(marker).length !== 2) throw Error('Fixture extension injection marker changed')
  fixtureMain = join(root, 'out/main', `hermes-fixture-${randomUUID()}.js`)
  await writeFile(fixtureMain, main.replace(marker, `return ${JSON.stringify(extension)};`)
    .replaceAll('devResourcesDir: join(app.getAppPath(), "resources")', `devResourcesDir: ${JSON.stringify(join(root, 'resources'))}`))
  await writeFile(join(sessions, 'hermes.jsonl'), [
    { type: 'session', version: 3, id, timestamp, cwd: temp },
    { type: 'message', id: 'fixture-user', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Hermes desktop fixture' }], timestamp: Date.now() } }
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const probe = join(temp, 'keep-alive.js')
  await writeFile(probe, 'new Promise(resolve => setTimeout(() => resolve("✓ isolated desktop lifetime complete"), 40000))')
  const config = join(temp, 'connection.json')
  await writeFile(config, JSON.stringify({ url, token }))
  const env = { ...process.env, YAN_USER_DATA: user, YAN_DATA_DIR: data, YAN_PI_DIR: pi,
    YAN_REMOTE_ENABLE: '1', YAN_REMOTE_HOST: '127.0.0.1', YAN_REMOTE_PORT: String(port),
    YAN_PROBE: probe, YAN_PROBE_DELAY: '500', YAN_WIN: '940x900' }
  for (const key of Object.keys(env)) if (/^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDECODE$|^YAN_CLI_|^YAN_SESSION_ID$|^YAN_PROJECT_ID$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete env[key]
  delete env.YAN_REMOTE_TOKEN
  app = spawn(createRequire(import.meta.url)('electron'), [fixtureMain], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  app.stdout.on('data', data => { log += data }); app.stderr.on('data', data => { log += data })
  const exited = new Promise(resolveExit => app.once('exit', resolveExit))
  const until = Date.now() + 15000
  while (true) {
    try { if ((await fetch(url + '/remote/v1/health')).ok) break } catch {}
    if (Date.now() > until) throw Error('Isolated desktop remote endpoint did not start')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', INKSTONE_CONNECTION_FILE: config, INKSTONE_DESKTOP_FIXTURE_ID: id, INKSTONE_DESKTOP_APPROVAL_RESULT: approvalResult }
  delete pythonEnv.INKSTONE_URL; delete pythonEnv.INKSTONE_TOKEN
  const phoneMode = process.argv.includes('--adb')
  const result = phoneMode ? await runHermesPhoneProbe({ root, temp, port, config, id }).then(() => 0) : await new Promise((resolveExit, reject) => {
    const child = spawn(process.env.YAN_TEST_PYTHON || 'python', ['scripts/probe/hermes-plugin-desktop.py'], { cwd: root, env: pythonEnv, windowsHide: true, stdio: 'inherit' })
    child.once('error', reject); child.once('exit', resolveExit)
  })
  await writeFile(join(root, `.local-docs/evidence/hermes-plugin-${phoneMode ? 'phone' : 'desktop'}-${Date.now()}-app.log`), log.replaceAll(token, '[redacted]'))
  if (result !== 0) {
    console.error('Fixture hook:', await readFile(approvalResult + '.debug', 'utf8').catch(() => 'not loaded'))
    console.error('Fixture replies:', await readFile(approvalResult, 'utf8').catch(() => 'still pending'))
    throw Error(`Desktop plugin checks failed (${result})`)
  }
  if (phoneMode) {
    const replies = JSON.parse(await readFile(approvalResult, 'utf8'))
    if (replies[0]?.summary?.allowed !== true || replies[1]?.summary?.allowed !== false) throw Error('Original pi requests did not resume with phone allow/deny')
    console.log('PASS phone decisions resumed original Windows pi requests: allow/deny')
  }
  const question = JSON.parse(await readFile(approvalResult + '.question', 'utf8'))
  if (question.answer !== 'phone-ok') throw Error('Ordinary question did not resume original pi UI request')
  const sent = JSON.parse(await readFile(approvalResult + '.send', 'utf8'))
  if (!sent.received) throw Error('Sent command did not reach original pi session')
  console.log('PASS question reply and explicit task submission reached original pi session')
  await exited
  console.log('PASS: plugin → HTTP → real Electron/RemoteHost/pi; no model prompt')
} finally {
  if (app && app.exitCode === null) {
    const stopped = new Promise(done => app.once('exit', done))
    app.kill()
    await stopped
  }
  if (fixtureMain) await rm(fixtureMain, { force: true })
  await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}
