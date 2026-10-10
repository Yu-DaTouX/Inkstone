/** Windows isolated startup/idle benchmark. No credentials, extensions or inference. */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { sampleProcessTree as sample } from './lib/process-sample.mjs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

if (process.platform !== 'win32') throw new Error('Process sampling currently requires Windows')
const evidence = resolve(process.env.YAN_MEASURE_OUT || `.local-docs/evidence/light-perf-${Date.now()}.json`)
const root = resolve('.')
const executable = process.env.YAN_LIGHT_EXE || createRequire(import.meta.url)('electron')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-perf-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rows = []
const buildFile = process.env.YAN_LIGHT_EXE ? join(dirname(executable),'resources/app.asar') : join(root,'out/main/index.js')
const buildSha256 = createHash('sha256').update(await readFile(buildFile)).digest('hex')
const scenario = process.env.YAN_MEASURE_SCENARIO || 'empty'
if (!['empty','long'].includes(scenario)) throw Error('Scenario must be empty or long')
try {
  for (let run = 0; run < 3; run++) {
    const base = join(temp, String(run))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^YAN_|^ANTHROPIC_|API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^CLAUDECODE$|^ELECTRON_RUN_AS_NODE$|^ELECTRON_RENDERER_URL$/.test(key)) delete env[key]
    for (const [key, name] of [['YAN_DATA_DIR', 'data'], ['YAN_PI_DIR', 'pi'], ['YAN_USER_DATA', 'user']]) {
      env[key] = join(base, name); await mkdir(env[key], { recursive: true })
    }
    await writeFile(join(env.YAN_DATA_DIR, 'desktop.json'), JSON.stringify({ cwd: base, onboardingDone: true, appUpdate: { enabled: false }, remoteAccess: { enabled: false } }))
    await writeFile(join(env.YAN_PI_DIR, 'settings.json'), JSON.stringify({ packages: [], enableMcp: false }))
    await writeFile(join(env.YAN_PI_DIR, 'auth.json'), '{}')
    const receipt = join(base, 'ready.json'), probe = join(base, 'probe.js')
    const longProbe = scenario === 'long' ? await readFile(join(root,'scripts/probe/measure-long-session.js'),'utf8') : ''
    await writeFile(probe, `${longProbe}\n(async()=>{const start=Date.now(); while(!document.querySelector('.composer-wrap') || !window.__yanStore?.getState().session?.sessionId) {if(Date.now()-start>25000) throw Error('pi/session UI not ready');await new Promise(r=>setTimeout(r,50))} const ready=Date.now(); const long=${scenario === 'long' ? 'await measureLongSession()' : 'null'}; await new Promise(r=>setTimeout(r,16000)); return {ready,sessionReady:true,long}})()`)
    Object.assign(env, { YAN_PROBE: probe, YAN_PROBE_DELAY: '0', YAN_PROBE_OUT: receipt })
    if (scenario === 'empty') env.YAN_PROBE_HIDDEN = '1'
    const started = Date.now()
    const child = spawn(executable, process.env.YAN_LIGHT_EXE ? [] : [join(root, 'out/main/index.js')], { cwd: base, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
    const completion = new Promise((resolveExit, reject) => { child.on('error', reject); child.on('exit', code => resolveExit(code)) })
    const timer = setTimeout(() => { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }, 55000)
    try {
      await sleep(8000)
      const first = sample(child.pid)
      await sleep(3000)
      const second = sample(child.pid)
      const code = await completion
      await writeFile(join(base, 'process.log'), output)
      if (code !== 0) throw new Error(`Benchmark exited ${code}: ${output.slice(-1500)}`)
      const result = JSON.parse(await readFile(receipt, 'utf8').catch(() => { throw Error(`Missing probe receipt; process output: ${output.slice(-3000)}`) }))
      const row = { run: run + 1, startupMs: result.ready - started, workingSetMiB: second.workingSetMiB, idleCpuOneCorePercent: (second.cpuSeconds - first.cpuSeconds) * 100000 / (second.at - first.at), processes: second.count, processSamples: second.processSamples, ...(result.long ? {long:result.long} : {}) }
      rows.push(row); console.log(JSON.stringify(row))
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  }
  const median = key => [...rows].map(row => row[key]).sort((a, b) => a - b)[1]
  await mkdir(resolve(evidence, '..'), { recursive: true })
  await writeFile(evidence, JSON.stringify({ platform: process.platform, logicalCpus: cpus().length, executable, buildFile, buildSha256, scenario: `${scenario} isolated session, ${scenario === 'empty' ? 'hidden window' : 'inactive visible window'}, no inference; long=2000 synthetic messages/120 scroll frames; Chromium test switches disable background/frame-rate limits, not a display FPS estimate; process-tree working-set sum may double-count shared pages; warm filesystem cache; CPU=one core`, rows, median: Object.fromEntries(['startupMs', 'workingSetMiB', 'idleCpuOneCorePercent'].map(key => [key, median(key)])) }, null, 2))
  console.log(`PASS: ${evidence}`)
} finally { await rm(temp, { recursive: true, force: true, maxRetries:10,retryDelay:200 }) }
