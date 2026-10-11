/** Real bundled pi and AgentController queue operations, with a loopback-only model fixture. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-queue-rpc-'))
const pi = join(root, 'pi')
const data = join(root, 'data')
const sessions = join(root, 'sessions')
const compiledDir = await mkdtemp(resolve('node_modules/.inkstone-queue-rpc-'))
const envBefore = { ...process.env }
let agent, checks = 0, heldResponse, queue = { steering: [], followUp: [] }
const requests = []
const check = (condition, label) => { assert.ok(condition, label); checks++ }
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
const wait = async (condition, label) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { if (condition()) return; await new Promise(done => setTimeout(done, 25)) }
  throw new Error(`Timeout: ${label}`)
}
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    requests.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta, finish_reason }] })
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: requests.length === 1 ? 'HOLDING' : 'EXPLICIT-NEXT-TURN' }))}\n\n`)
    if (requests.length === 3) heldResponse = () => {
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
      res.end()
    }
    else if (requests.length > 1) {
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
      res.end()
    }
  })
})
try {
  for (const path of [pi, data, sessions]) await mkdir(path)
  Object.assign(process.env, { YAN_PI_DIR: pi, PI_CODING_AGENT_DIR: pi, YAN_DATA_DIR: data, YAN_SESSIONS_DIR: sessions })
  for (const key of Object.keys(process.env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDE_CODE_OAUTH_TOKEN$/.test(key)) delete process.env[key]
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture', defaultModel: 'model', compaction: { enabled: false } }))
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local', models: [{ id: 'model', name: 'model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } }))
  const outfile = join(compiledDir, 'agent.mjs')
  await build({ entryPoints: ['src/main/agent.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
  } }] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  agent = new AgentController({ cwd: root, piBin: join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js'), push: event => { if (event.ch === 'queue') queue = event.payload } })
  agent.maybeGenerateTitle = async () => null
  const started = await agent.start()
  check(started.ok, started.error ?? 'real pi starts')
  check((await agent.send('Hold initial turn')).ok, 'initial prompt accepted')
  await wait(() => requests.length === 1 && agent.getState()?.isStreaming, 'initial stream')
  for (const text of ['REMOVE-ME', 'PROMOTE-ME', 'DUPLICATE', 'DUPLICATE']) check((await agent.send(text)).ok, `follow-up accepted: ${text}`)
  await wait(() => queue.followUp.length === 4, 'four queued prompts')
  equal(queue.followUp.map(item => item.text), ['REMOVE-ME', 'PROMOTE-ME', 'DUPLICATE', 'DUPLICATE'], 'FIFO and duplicate text preserved')
  check(queue.followUp[2].id !== queue.followUp[3].id, 'duplicate text has separate item identities')
  const [remove, promote] = queue.followUp
  const [removed, promoted] = await Promise.all([agent.removeQueued(remove.id), agent.steerQueued(promote.id)])
  check(removed.ok && removed.text === 'REMOVE-ME', 'concurrent retract returns the original draft')
  check(promoted.ok, promoted.error ?? 'concurrent promotion succeeds')
  equal(agent.queueSnapshot(), { steering: ['PROMOTE-ME'], followUp: ['DUPLICATE', 'DUPLICATE'] }, 'serialized edits retain exact queue multiplicity')
  const duplicateId = queue.followUp[0].id
  const [retracted, reclaimed] = await Promise.all([agent.removeQueued(duplicateId), agent.abort()])
  check(retracted.ok && retracted.text === 'DUPLICATE', 'retract and stop serialize')
  equal(reclaimed, { steering: ['PROMOTE-ME'], followUp: ['DUPLICATE'] }, 'stop reclaims remaining steering and follow-up once')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] }, 'host queue empty after stop')
  await wait(() => !agent.getState()?.isAgentRunning && !agent.getState()?.isStreaming, 'stop finishes the real pi turn')
  check(requests.length === 1, 'stop does not silently run queued prompts')
  const stale = await agent.steerQueued(promote.id)
  check(!stale.ok, 'consumed or reclaimed item cannot be promoted again')
  check((await agent.send('Explicit next turn')).ok, 'next explicit prompt accepted')
  await wait(() => requests.length === 2 && !agent.getState()?.isAgentRunning, 'next turn completes')
  const userTexts = (await agent.getMessages()).filter(message => message.role === 'user').map(message => message.text)
  equal(userTexts, ['Hold initial turn', 'Explicit next turn'], 'retracted and stopped queue texts never appear as consumed user messages')
  check(JSON.stringify(await agent.getMessages()).includes('EXPLICIT-NEXT-TURN'), 'model output reaches persisted message projection')
  check((await agent.send('Hold for normal queue consumption')).ok, 'normal-consumption turn accepted')
  await wait(() => requests.length === 3 && agent.getState()?.isStreaming, 'second held stream')
  check((await agent.send('STEER-LIVE', undefined, 'steer')).ok, 'native streaming steering accepted')
  check((await agent.send('FOLLOW-LIVE')).ok, 'first follow-up accepted')
  check((await agent.send('FOLLOW-LIVE')).ok, 'identical second follow-up accepted')
  await wait(() => queue.steering.length === 1 && queue.followUp.length === 2, 'steering and two follow-ups pending')
  heldResponse()
  await wait(() => requests.length >= 4 && !agent.getState()?.isAgentRunning && queue.steering.length === 0 && queue.followUp.length === 0, 'all queued messages consumed')
  const consumed = (await agent.getMessages()).filter(message => message.role === 'user').map(message => message.text)
  equal(consumed.filter(text => text === 'STEER-LIVE').length, 1, 'steering consumed exactly once')
  equal(consumed.filter(text => text === 'FOLLOW-LIVE').length, 2, 'identical follow-ups consumed as two independent messages')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] }, 'consumption clears host queue without relying on a final queue_update')
  console.log(`queue-rpc-live: ${checks} checks passed (actual pi, loopback fixture, no external credentials)`)
} finally {
  await agent?.stop()
  server.closeAllConnections()
  if (server.listening) await new Promise(done => server.close(done))
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
  Object.assign(process.env, envBefore)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(compiledDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
