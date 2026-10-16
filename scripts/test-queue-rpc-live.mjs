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
let agent, checks = 0, heldResponse, holdNext = false, queue = { steering: [], followUp: [] }
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
    if (requests.length === 3 || holdNext) {
      holdNext = false
      heldResponse = () => {
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`)
        res.end()
      }
    } else if (requests.length > 1) {
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
  await writeFile(join(pi, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local', models: [{ id: 'model', name: 'model', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } }))
  const outfile = join(compiledDir, 'agent.mjs')
  await build({ entryPoints: ['src/main/agent.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'unused-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getLocale:()=> 'en',getPath:()=> ${JSON.stringify(root)}};export class BrowserWindow{};export const session={};`, loader: 'js' }))
  } }] })
  const { AgentController } = await import(pathToFileURL(outfile).href)
  const offline = new AgentController({ cwd: root, push: () => {} })
  const imageA = { data: 'YQ==', mimeType: 'image/png' }
  const imageB = { data: 'Yg==', mimeType: 'image/png' }
  offline.queueState = { steering: [], followUp: [{ id: 'same-1', text: 'same', images: [imageA] }, { id: 'same-2', text: 'same', images: [imageB] }] }
  offline.publishQueue([], ['same'])
  equal(offline.queueState.followUp.map(item => item.id), ['same-2'], 'shrinking native duplicate mirror retains later image identity')
  offline.consumeQueued('same', [imageA])
  equal(offline.queueState.followUp.map(item => item.id), ['same-2'], 'user event after native shrink does not consume second image')
  offline.publishQueue([], [])
  offline.consumeQueued('same', [imageB])
  equal(offline.queueRemoved, [], 'consumption acknowledgements are drained')
  offline.queueState = { steering: [], followUp: [{ id: 'equal-1', text: 'same', images: [imageA] }, { id: 'equal-2', text: 'same', images: [imageA] }] }
  offline.publishQueue([], ['same'])
  offline.consumeQueued('same', [imageA])
  equal(offline.queueState.followUp.map(item => item.id), ['equal-2'], 'even identical images are not double consumed')
  offline.resetQueue()
  let unblock
  const firstOperation = offline.queueRun(() => new Promise(resolve => { unblock = resolve }))
  await Promise.resolve()
  let lateRan = false
  const lateOperation = offline.queueRun(async () => { lateRan = true }).catch(error => error.message)
  offline.state = { sessionId: 'changed-session' }
  unblock()
  await firstOperation
  check((await lateOperation).includes('会话已切换') && !lateRan, 'operation waiting for gate cannot cross session boundary')
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
  const red = { data: Buffer.from('queue-red-image').toString('base64'), mimeType: 'image/png' }
  const blue = { data: Buffer.from('queue-blue-image').toString('base64'), mimeType: 'image/png' }
  const hold = async label => {
    const count = requests.length
    holdNext = true
    check((await agent.send(label)).ok, label)
    await wait(() => requests.length > count && agent.getState()?.isStreaming, label + ' streaming')
  }
  await hold('Hold image queue editing')
  check((await agent.send('SAME-IMAGE-TEXT', [red])).ok, 'red queued')
  check((await agent.send('SAME-IMAGE-TEXT', [blue])).ok, 'blue with identical text queued')
  check((await agent.send('', [red])).ok, 'image-only red queued')
  check((await agent.send('', [blue])).ok, 'image-only blue queued')
  equal(queue.followUp.map(item => item.images), [[red], [blue], [red], [blue]], 'queue identities retain each original image')
  const [redItem, blueItem, emptyRed, emptyBlue] = queue.followUp
  check((await agent.steerQueued(blueItem.id)).ok, 'promote image message')
  equal(queue.steering[0].images, [blue], 'promotion preserves target image')
  equal(queue.followUp.map(item => item.images), [[red], [red], [blue]], 'promotion preserves all other images')
  const removedImage = await agent.removeQueued(emptyRed.id)
  equal(removedImage.images, [red], 'image-only retract returns its image')
  equal(removedImage.text, '', 'image-only retract retains empty text')
  equal(queue.followUp.map(item => item.id), [redItem.id, emptyBlue.id], 'identical empty text keeps remaining identity')
  const imageSnapshot = agent.queueSnapshot()
  equal(imageSnapshot.items.steering[0].images, [blue], 'reload snapshot includes steering image')
  const originalCommand = agent.rpc.command.bind(agent.rpc)
  let failPromotion = true
  agent.rpc.command = async (command, payload) => {
    if (failPromotion && command === 'steer' && payload.message === 'SAME-IMAGE-TEXT' && payload.images?.[0]?.data === red.data) {
      failPromotion = false
      return { success: false, error: 'injected promotion failure' }
    }
    return originalCommand(command, payload)
  }
  const failedPromotion = await agent.steerQueued(redItem.id)
  check(!failedPromotion.ok && failedPromotion.error.includes('未消费内容已恢复'), 'failed promotion reports recovery')
  equal(agent.queueSnapshot(), imageSnapshot, 'partial refill failure restores all original images and identities')
  agent.rpc.command = originalCommand
  const stoppedImages = await agent.abort()
  equal(stoppedImages.items, imageSnapshot.items, 'stop reclaims original complete queue once')
  await wait(() => !agent.getState()?.isAgentRunning, 'image stop completes')
  check((await agent.restoreQueueSnapshot(imageSnapshot)).ok, 'idle reload restores image queue')
  equal(agent.queueSnapshot().items.followUp.map(item => item.images), [[red], [blue]], 'restored snapshot keeps empty image message')
  const restoredStop = await agent.abort()
  equal(restoredStop.items.followUp.map(item => item.images), [[red], [blue]], 'restored pi queue can reclaim images')

  await hold('Hold actual image consumption')
  const imageStart = requests.length
  check((await agent.send('DUPLICATE-PICTURES', [red], 'steer')).ok, 'image steer accepted')
  check((await agent.send('DUPLICATE-PICTURES', [blue], 'steer')).ok, 'second same-text image steer accepted')
  check((await agent.send('', [red])).ok, 'image-only follow-up accepted')
  check((await agent.send('', [blue])).ok, 'second image-only follow-up accepted')
  heldResponse()
  await wait(() => requests.length > imageStart && !agent.getState()?.isAgentRunning, 'images consumed through real pi')
  equal(agent.queueSnapshot(), { steering: [], followUp: [] }, 'same-text and image-only consumption leaves no phantom entries')
  const lastRequest = requests.at(-1)
  const duplicateInputs = lastRequest.messages.filter(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.text === 'DUPLICATE-PICTURES'))
  equal(duplicateInputs.map(message => message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url)),
    [[`data:${red.mimeType};base64,${red.data}`], [`data:${blue.mimeType};base64,${blue.data}`]], 'provider receives different images for identical text exactly once')
  const imageOnlyInputs = lastRequest.messages.filter(message => message.role === 'user' && Array.isArray(message.content) && message.content.every(part => part.type === 'image_url' || !part.text))
  equal(imageOnlyInputs.flatMap(message => message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url)),
    [`data:${red.mimeType};base64,${red.data}`, `data:${blue.mimeType};base64,${blue.data}`], 'provider receives both image-only inputs in order')
  await hold('Hold after consumed empty mirrors')
  check((await agent.send('', [blue])).ok, 'new empty-text image after earlier consumption')
  equal(queue.followUp.map(item => item.images), [[blue]], 'stale native empty mirrors do not resurrect consumed pictures')
  equal((await agent.abort()).items.followUp.map(item => item.images), [[blue]], 'only new image is reclaimed')
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
