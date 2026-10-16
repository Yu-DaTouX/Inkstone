/** Current host -> bundled pi -> loopback-only SSE model. No external models/credentials. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const envBefore = { ...process.env }
const root = await mkdtemp(join(tmpdir(), 'inkstone-loop-rpc-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-loop-rpc-'))
const pushes = [], controls = [], requests = [], plans = []
let agent, checks = 0
const check = (condition, label) => { assert.ok(condition, label); checks++ }
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
const wait = async (condition, label) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (condition()) return; await new Promise(done => setTimeout(done, 20)) }
  throw new Error(`Timeout: ${label}`)
}
const logs = (offset = 0) => pushes.slice(offset).filter(e => e.ch === 'log').flatMap(e => {
  try { const value = JSON.parse(e.payload.text); return value.type === 'stream-loop-guard' ? [value] : [] } catch { return [] }
})
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    const plan = plans.shift() ?? 'hold'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason }] })
    const emit = delta => res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`)
    const finish = () => { if (!res.destroyed) { res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`); res.end() } }
    const control = { emit, finish, closed: false }
    res.on('close', () => { control.closed = true })
    controls.push(control)
    emit({ role: 'assistant', content: plan === 'normal' ? 'EXPLICIT-RECOVERY-OK' : '生成开始。\n' })
    if (plan === 'normal') finish()
  })
})
try {
  const pi = join(root, 'pi'), data = join(root, 'data'), sessions = join(root, 'sessions')
  for (const p of [pi, data, sessions]) await mkdir(p)
  for (const key of Object.keys(process.env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$|^YAN_|^PI_SESSION_|^PI_MODEL$|^PI_PROVIDER$/.test(key)) delete process.env[key]
  delete process.env.ELECTRON_RUN_AS_NODE
  Object.assign(process.env, { YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'model', defaultThinkingLevel: 'off', retry: { enabled: false }, compaction: { enabled: false } }))
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local', models: [{ id: 'model', name: 'model', reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }] } } }))
  const outfile = join(compiled, 'agent.mjs')
  await build({ entryPoints: ['src/main/agent.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
  } }] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  agent = new AgentController({ cwd: root, piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'), push: event => pushes.push(event) })
  agent.maybeGenerateTitle = async () => null
  check(await agent.readStreamLoopAutoContinue(), 'missing setting defaults to auto-continue enabled')
  let autoContinueEnabled = false
  agent.readStreamLoopAutoContinue = async () => autoContinueEnabled
  check((await agent.start()).ok, 'actual bundled pi starts isolated')
  const nativeCommand = agent.rpc.command.bind(agent.rpc)
  let abortCount = 0
  agent.rpc.command = async (command, ...args) => { if (command === 'abort') abortCount++; return nativeCommand(command, ...args) }
  const countedCommand = agent.rpc.command
  const hold = async label => {
    const count = requests.length
    plans.push('hold')
    check((await agent.send(label)).ok, `${label}: accepted`)
    await wait(() => controls.length > count && agent.getState()?.isStreaming, `${label}: stream started`)
    return controls.at(-1)
  }
  const settled = label => wait(() => !agent.getState()?.isAgentRunning && !agent.getState()?.isStreaming, label)
  const repeat = (control, kind = 'text') => control.emit(kind === 'thinking' ? { reasoning_content: '好。\n\n'.repeat(400) } : { content: '好。\n\n'.repeat(400) })

  // Clear/abort are serialized; duplicate text retains original IDs, concurrent manual stop does not abort twice.
  let c = await hold('TEXT-LOOP')
  check((await agent.send('DUPLICATE')).ok, 'first queue item accepted')
  check((await agent.send('DUPLICATE', undefined, 'steer')).ok, 'steering queue accepted')
  const original = agent.queueSnapshot()
  let release, entered = false
  const delay = new Promise(done => { release = done })
  agent.rpc.command = async (command, ...args) => {
    if (command === 'clear_queue') { entered = true; await delay }
    return countedCommand(command, ...args)
  }
  const offset = pushes.length, requestCount = requests.length, beforeAbort = abortCount
  repeat(c)
  await wait(() => entered, 'guard enters queue clear')
  check(agent.getState().isAgentRunning && agent.getState().isStreaming, 'not prematurely marked idle while clearing')
  check(!(await agent.send('BLOCKED-SEND')).ok, 'send rejected during clear phase')
  check(!(await agent.steer('BLOCKED-STEER')).ok, 'steer rejected during clear phase')
  check(!(await agent.followUp('BLOCKED-FOLLOW')).ok, 'follow-up rejected during clear phase')
  const manualStop = agent.abort()
  release()
  await manualStop
  await settled('text guard settles')
  agent.rpc.command = countedCommand
  equal(abortCount - beforeAbort, 1, 'concurrent manual stop and guard issue one native abort')
  equal(requests.length, requestCount, 'queue did not silently trigger a model request')
  const reclaimed = pushes.slice(offset).find(e => e.ch === 'queue-reclaimed')
  equal(reclaimed.payload.items, original.items, 'queue text/order/identity returned once')
  equal(reclaimed.payload.sessionId, agent.getState().sessionId, 'explicit session ownership on recovery')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] }, 'host queue empty after reclamation')
  const guardLogs = logs(offset)
  check(guardLogs.some(e => e.event === 'break-requested' && e.rule === 'text-cycle'), 'text rule triggered')
  check(guardLogs.some(e => e.event === 'settled'), 'authoritative terminal event observed')
  check(!JSON.stringify(guardLogs).includes('好。'), 'structured logs do not retain repeated content')
  await agent.turn.writeTail
  const timingRecords = (await readFile(join(data, 'turn-timing', basename(agent.getState().sessionFile)), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  check(timingRecords.some(record => record.final && record.terminalReason === 'interrupted'), 'persisted guard terminal classified interrupted')

  plans.push('normal')
  check((await agent.send('Explicit recovery')).ok, 'same session accepts explicit recovery')
  await settled('recovery completes')
  check(JSON.stringify(await agent.getMessages()).includes('EXPLICIT-RECOVERY-OK'), 'recovery response persists')

  c = await hold('THINKING-LOOP')
  const thinkingOffset = pushes.length
  repeat(c, 'thinking')
  await settled('thinking guard settles')
  check(logs(thinkingOffset).some(e => e.rule === 'reasoning-cycle' && e.event === 'break-requested'), 'real pi forwards thinking deltas into reasoning detector')

  // Opt-in fixture switch exercises real pi automatic continuation without consuming reclaimed drafts.
  autoContinueEnabled = true
  c = await hold('AUTO-CONTINUE-ONCE')
  check((await agent.send('DO-NOT-AUTO-EXECUTE-DRAFT')).ok, 'auto continuation draft queued')
  const autoOffset = pushes.length, autoRequests = requests.length
  plans.push('normal')
  repeat(c)
  await wait(() => requests.length === autoRequests + 1, 'one automatic native model request')
  await agent.loopGuardContinueTask
  await settled('automatic recovery completes')
  equal(agent.loopGuardAutoContinueCount, 1, 'automatic recovery consumes exactly one allowance')
  equal(requests.length, autoRequests + 1, 'automatic recovery runs once only')
  const autoRequest = requests.at(-1)
  check(JSON.stringify(autoRequest.messages).includes('循环恢复 · 自动继续 1/1'), 'native request contains visible one-shot recovery instruction')
  check(!JSON.stringify(autoRequest.messages).includes('DO-NOT-AUTO-EXECUTE-DRAFT'), 'reclaimed draft not silently included in continuation request')
  check(pushes.slice(autoOffset).some(e => e.ch === 'queue-reclaimed' && e.payload.followUp.includes('DO-NOT-AUTO-EXECUTE-DRAFT')), 'draft remains available for explicit recovery')
  check(logs(autoOffset).some(e => e.event === 'auto-continue-requested'), 'automatic attempt logged once')

  // A second loop in the resumed run must not get another allowance from agent_start.
  c = await hold('AUTO-SECOND-LOOP')
  const limitOffset = pushes.length, limitRequests = requests.length
  plans.push('hold')
  repeat(c)
  await wait(() => requests.length === limitRequests + 1, 'second scenario automatically resumes once')
  await agent.loopGuardContinueTask
  const resumedControl = controls.at(-1)
  repeat(resumedControl)
  await settled('resumed loop stops')
  await agent.loopGuardContinueTask
  equal(requests.length, limitRequests + 1, 'second detected loop produces no third model request')
  equal(agent.loopGuardAutoContinueCount, 1, 'agent_start did not reset one-shot allowance')
  check(logs(limitOffset).some(e => e.event === 'auto-continue-limit'), 'second loop explains one-shot limit')

  // Manual stop while the guard's abort acknowledgement is delayed cancels the pending continuation.
  c = await hold('AUTO-MANUAL-CANCEL')
  let releaseAck, abortAckHeld = false
  const ackDelay = new Promise(done => { releaseAck = done })
  agent.rpc.command = async (command, ...args) => {
    const result = await countedCommand(command, ...args)
    if (command === 'abort') { abortAckHeld = true; await ackDelay }
    return result
  }
  const manualRequests = requests.length
  repeat(c)
  await wait(() => abortAckHeld, 'guard abort acknowledgement held after authoritative end')
  const cancel = agent.abort()
  releaseAck()
  await cancel
  await agent.loopGuardContinueTask
  agent.rpc.command = countedCommand
  equal(requests.length, manualRequests, 'manual stop cancels pending automatic continuation')
  await settled('manual cancel settled')

  // Explicit new input wins over an automatic prompt waiting on the old abort acknowledgement.
  c = await hold('AUTO-USER-WINS')
  let releaseUserAck, userAckHeld = false
  const userAckDelay = new Promise(done => { releaseUserAck = done })
  agent.rpc.command = async (command, ...args) => {
    const result = await countedCommand(command, ...args)
    if (command === 'abort') { userAckHeld = true; await userAckDelay }
    return result
  }
  const userRequests = requests.length, userOffset = pushes.length
  repeat(c)
  await wait(() => userAckHeld && !agent.getState()?.isAgentRunning, 'user override at confirmed end')
  plans.push('normal')
  const explicit = agent.send('USER-INPUT-WINS')
  releaseUserAck()
  check((await explicit).ok, 'new explicit input accepted after authoritative end')
  await agent.loopGuardContinueTask
  agent.rpc.command = countedCommand
  await settled('explicit priority round finishes')
  equal(requests.length, userRequests + 1, 'only explicit input causes a new request')
  check(!logs(userOffset).some(e => e.event === 'auto-continue-requested'), 'explicit input cancels pending auto prompt')
  equal(agent.loopGuardAutoContinueCount, 0, 'explicit new task resets one-shot allowance')

  // Disable at execution time, not only when the original run starts.
  c = await hold('AUTO-TOGGLE-OFF')
  let releaseToggle, toggleHeld = false
  const toggleDelay = new Promise(done => { releaseToggle = done })
  agent.rpc.command = async (command, ...args) => {
    const result = await countedCommand(command, ...args)
    if (command === 'abort') { toggleHeld = true; await toggleDelay }
    return result
  }
  const toggleRequests = requests.length
  repeat(c)
  await wait(() => toggleHeld, 'toggle phase pending')
  autoContinueEnabled = false
  releaseToggle()
  await agent.loopGuardContinueTask
  agent.rpc.command = countedCommand
  equal(requests.length, toggleRequests, 'turning switch off before execution prevents resume')
  await settled('toggle off settled')

  // Rollback switch really bypasses the host detector.
  process.env.YAN_STREAM_LOOP_GUARD = '0'
  c = await hold('GUARD-DISABLED')
  const disabledOffset = pushes.length
  repeat(c)
  c.finish()
  await settled('disabled flow finishes naturally')
  check(logs(disabledOffset).length === 0, 'environment switch disables detection')
  delete process.env.YAN_STREAM_LOOP_GUARD

  // Fenced repeated plain text must finish normally, not just code-looking lines.
  c = await hold('FENCED-REPEAT')
  const fenceOffset = pushes.length
  c.emit({ content: '```text\n' + '好。\n\n'.repeat(600) + '```\n' })
  c.finish()
  await settled('fenced flow finishes naturally')
  check(logs(fenceOffset).length === 0, 'fenced repeats do not trigger automatic stop')

  // Current background recovery cannot preserve image drafts, so do not clear/abort an image queue.
  c = await hold('IMAGE-QUEUE')
  const image = { data: 'YQ==', mimeType: 'image/png' }
  check((await agent.send('KEEP-IMAGE', [image])).ok, 'image queue accepted')
  const imageQueue = agent.queueSnapshot(), imageOffset = pushes.length, imageAbort = abortCount
  repeat(c)
  await wait(() => logs(imageOffset).some(e => e.event === 'stop-failed'), 'image safety warning')
  equal(agent.queueSnapshot(), imageQueue, 'image and original queue identity remain intact')
  equal(abortCount, imageAbort, 'image queue not automatically aborted')
  check(agent.getState().isAgentRunning, 'image warning does not falsely claim stop')
  const stoppedImages = await agent.abort()
  equal(stoppedImages.items, imageQueue.items, 'manual stop can reclaim original image snapshot')
  await settled('manual image stop')

  c = await hold('CLEAR-FAILURE')
  check((await agent.send('KEEP-TEXT')).ok, 'failure queue accepted')
  const failureQueue = agent.queueSnapshot(), failureOffset = pushes.length, failureAbort = abortCount
  agent.rpc.command = async (command, ...args) => command === 'clear_queue' ? { success: false, error: 'injected clear failure' } : countedCommand(command, ...args)
  repeat(c)
  await wait(() => logs(failureOffset).some(e => e.event === 'stop-failed'), 'clear failure reported')
  equal(abortCount, failureAbort, 'clear failure does not abort native run')
  equal(agent.queueSnapshot(), failureQueue, 'clear failure preserves complete host queue')
  check(agent.getState().isAgentRunning, 'clear failure stays running, no false terminal')
  agent.rpc.command = countedCommand
  await agent.abort()
  await settled('manual failure stop')

  // Natural completion while clear response is in-flight still returns cleared texts; never abort a later message.
  c = await hold('NATURAL-END-RACE')
  check((await agent.send('RETURN-ON-RACE')).ok, 'race queue accepted')
  const raceOffset = pushes.length, raceAbort = abortCount
  agent.rpc.command = async (command, ...args) => {
    const result = await countedCommand(command, ...args)
    if (command === 'clear_queue') { c.finish(); await settled('natural finish while clear ack delayed') }
    return result
  }
  repeat(c)
  await wait(() => pushes.slice(raceOffset).some(e => e.ch === 'queue-reclaimed'), 'race returns already cleared queue')
  await agent.loopGuardStopTask
  agent.rpc.command = countedCommand
  equal(abortCount, raceAbort, 'natural end avoids a stale abort')
  check(pushes.slice(raceOffset).find(e => e.ch === 'queue-reclaimed').payload.followUp.includes('RETURN-ON-RACE'), 'natural end does not lose recovered text')

  const offline = new AgentController({ cwd: root, push: () => {} })
  const detectorBundle = join(compiled, 'detector.mjs')
  await build({ entryPoints: ['src/shared/stream-loop-detector.ts'], outfile: detectorBundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { createStreamLoopDetector } = await import(pathToFileURL(detectorBundle).href)
  offline.streamLoopDetector = createStreamLoopDetector()
  offline.streaming = { toolOpen: true }
  offline.checkStreamLoop('text', '好。\n\n'.repeat(600))
  check(!offline.loopGuardTripped && !offline.loopGuardStopTask, 'open tool block suppresses break')
  check(!offline.loopGuardAbortSent, 'open tool block issues no abort')

  // Host-only fault injection for ownership and malformed RPC responses; not remote-model evidence.
  const hit = { rule: 'text-cycle', emittedChars: 288, repeatedChars: 256 }
  const scoped = new AgentController({ cwd: root, push: event => pushes.push(event) })
  scoped.state = { sessionId: 'original-session' }
  scoped.streaming = { id: 'original-message' }
  scoped.turn.runId = 'original-run'
  scoped.queueState = { steering: [], followUp: [{ id: 'q-old', text: 'ORIGINAL-DRAFT' }] }
  let releaseScope, clearStarted = false, staleAborts = 0
  const scopeDelay = new Promise(done => { releaseScope = done })
  scoped.rpc = { command: async command => {
    if (command === 'clear_queue') { clearStarted = true; await scopeDelay; return { success: true, data: { steering: [], followUp: ['ORIGINAL-DRAFT'] } } }
    if (command === 'abort') staleAborts++
    return { success: true }
  } }
  const scopeOffset = pushes.length
  const oldStop = scoped.stopForLoopGuard(hit, 'text')
  await wait(() => clearStarted, 'injected original clear starts')
  scoped.state = { sessionId: 'replacement-session' }
  scoped.turn.runId = 'replacement-run'
  scoped.streaming = { id: 'replacement-message' }
  scoped.queueState = { steering: [], followUp: [{ id: 'q-new', text: 'NEW-DRAFT' }] }
  scoped.loopGuardStopping = false // restart owns the new run's lifecycle
  releaseScope()
  await oldStop
  equal(staleAborts, 0, 'late clear response does not abort replacement run')
  equal(scoped.queueState.followUp[0].id, 'q-new', 'late response does not reset replacement queue')
  const oldRecovery = pushes.slice(scopeOffset).find(e => e.ch === 'queue-reclaimed')
  equal(oldRecovery.payload.sessionId, 'original-session', 'late recovery still belongs to original session')
  check(logs(scopeOffset).every(e => e.sessionId === 'original-session' && e.runId === 'original-run'), 'async guard logs retain captured origin')
  const other = new AgentController({ cwd: root, push: () => {} })
  other.streamLoopDetector = createStreamLoopDetector()
  check(other.streamLoopDetector.onThinking('普通内容，不是循环。') === null && !other.loopGuardTripped, 'another controller has independent detector and stop state')

  for (const failure of ['missing-snapshot', 'abort-failure']) {
    const controller = new AgentController({ cwd: root, push: event => pushes.push(event) })
    controller.state = { sessionId: failure }
    controller.streaming = { id: failure + '-message' }
    controller.turn.runId = failure + '-run'
    let sent = 0
    controller.rpc = { command: async command => {
      if (command === 'abort') { sent++; return { success: false, error: 'injected abort error' } }
      return failure === 'missing-snapshot' ? { success: true, data: {} } : { success: true, data: { steering: [], followUp: [] } }
    } }
    const start = pushes.length
    await controller.stopForLoopGuard(hit, 'text')
    equal(sent, failure === 'missing-snapshot' ? 0 : 1, failure + ': no unsafe or duplicate abort')
    check(!controller.loopGuardStopping && !controller.loopGuardAbortSent, failure + ': manual intervention not permanently locked')
    check(logs(start).some(e => e.event === 'stop-failed') && !logs(start).some(e => e.event === 'settled'), failure + ': failure not reported as confirmed stop')
  }
  console.log(`stream-loop-rpc: ${checks} checks passed (actual pi, loopback model, no external credentials)`)
} finally {
  if (agent) { if (agent.getState()?.isAgentRunning) await agent.abort().catch(() => {}); await agent.stop().catch(() => {}) }
  server.closeAllConnections()
  await new Promise(done => server.close(done))
  await rm(compiled, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
  Object.assign(process.env, envBefore)
}
