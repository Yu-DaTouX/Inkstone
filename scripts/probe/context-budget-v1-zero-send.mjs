/**
 * Verify the real bundled pi RPC path invokes the V1 guard before provider I/O.
 * Uses an isolated Pi directory, YAN data directory, session directory, and a
 * loopback-only OpenAI-compatible fixture. Run after `npm run build`.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpc } from '../../out/main/protocol.js'

const root = await mkdtemp(join(tmpdir(), 'yan-context-budget-v1-runtime-'))
const piDir = join(root, 'pi-agent')
const dataDir = join(root, 'yan-data')
const sessionsDir = join(root, 'sessions')
await Promise.all([
  mkdir(piDir, { recursive: true }),
  mkdir(dataDir, { recursive: true }),
  mkdir(sessionsDir, { recursive: true })
])

const state = { requests: 0, responses: new Set() }
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (part) => { raw += part })
  request.on('end', () => {
    state.requests++
    state.responses.add(response)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({
      id: 'context-budget-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'context-budget-v1-fixture',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture response' }, finish_reason: null }]
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: 'context-budget-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'context-budget-v1-fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })}\n\n`)
    response.end('data: [DONE]\n\n')
    response.on('close', () => state.responses.delete(response))
  })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Loopback fixture did not receive a TCP port')

const provider = 'yancontextbudgetfixture'
const model = 'context-budget-v1-fixture'
await writeFile(join(piDir, 'models.json'), JSON.stringify({
  providers: {
    [provider]: {
      name: 'Yan Context Budget Fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions',
      models: [{ id: model, name: 'Context Budget V1 Fixture', contextWindow: 32_768, maxTokens: 4_096 }]
    }
  }
}, null, 2), 'utf8')
await writeFile(join(piDir, 'auth.json'), JSON.stringify({
  [provider]: { type: 'api_key', key: 'loopback-fixture-only' }
}, null, 2), 'utf8')

const extensionPath = join(process.cwd(), 'resources', 'pi-extensions', 'context-budget-observer.js')
const piBin = join(process.cwd(), 'resources', 'pi-runtime', 'dist', 'bundle', 'cli.js')
const rpc = new PiRpc({
  cwd: process.cwd(),
  piBin,
  args: [
    '--no-extensions',
    '--no-skills',
    '--extension', extensionPath,
    '--model', `${provider}/${model}`,
    '--session-dir', sessionsDir
  ],
  env: {
    YAN_DATA_DIR: dataDir,
    PI_CODING_AGENT_DIR: piDir,
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT
  },
  inheritEnv: false
})
rpc.on('stderr', (line) => { if (process.env.YAN_CONTEXT_BUDGET_DEBUG === '1') process.stderr.write(`${line}\n`) })
const eventHistory = []
rpc.on('event', (event) => {
  eventHistory.push(event)
  if (process.env.YAN_CONTEXT_BUDGET_DEBUG === '1') process.stderr.write(`event ${JSON.stringify(event)}\n`)
})
rpc.on('exit', (code, signal) => {
  if (process.env.YAN_CONTEXT_BUDGET_DEBUG === '1') process.stderr.write(`pi exit ${code ?? signal ?? 'unknown'}\n`)
})

let assertions = 0
function check(condition, message) {
  assertions++
  if (!condition) throw new Error(`FAIL: ${message}`)
  process.stdout.write(`✓ ${message}\n`)
}

async function waitForEvent(predicate, timeoutMs = 20_000) {
  const existing = eventHistory.find(predicate)
  if (existing) return existing
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.off('event', onEvent)
      reject(new Error(`Timed out waiting for pi event; observed ${JSON.stringify(eventHistory.slice(-12))}`))
    }, timeoutMs)
    const onEvent = (event) => {
      if (!predicate(event)) return
      clearTimeout(timer)
      rpc.off('event', onEvent)
      resolve(event)
    }
    rpc.on('event', onEvent)
  })
}

try {
  rpc.spawn()
  const initialState = await rpc.command('get_state', {}, { timeoutMs: 20_000 })
  if (!initialState.success || typeof initialState.data?.sessionId !== 'string') {
    throw new Error(`pi did not create an isolated session: ${JSON.stringify(initialState)}`)
  }
  const sessionId = initialState.data.sessionId
  const sessionDir = join(dataDir, 'context-budget-v1', sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'policy.json'), JSON.stringify({
    version: 1,
    sessionId,
    activePhaseId: 'main',
    revision: 'fixture-policy-revision',
    updatedAt: Date.now(),
    phases: {
      main: {
        phaseId: 'main', mode: 'auto', selectedBudget: 200_000, autoMaxBudget: 700_000,
        materials: []
      }
    }
  }), 'utf8')

  const normalDone = waitForEvent((event) => event.type === 'agent_end')
  const normal = await rpc.command('prompt', { message: 'Reply with one short word.' }, { timeoutMs: 20_000 })
  const normalEnd = await normalDone
  check(normal.success === true && normalEnd.type === 'agent_end' && state.requests === 1, `正常请求确实到达本机 provider fixture (rpcSuccess=${normal.success}, end=${normalEnd.type}, requests=${state.requests})`)

  const large = await rpc.command('prompt', { message: 'x'.repeat(40_000) }, { timeoutMs: 20_000 })
  await waitForEvent((event) => event.type === 'agent_end' && eventHistory.filter((candidate) => candidate.type === 'agent_end').length >= 2)
  const snapshotPath = join(sessionDir, 'latest-request.json')
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  check(snapshot.check.decision === 'review', '实际 pi payload 到达 review 线并由 guard 判定')
  check(snapshot.check.reason === 'soft_review_line_reached', '阻断快照记录了 review 原因')
  check(snapshot.inputTokens >= snapshot.check.calculation.reviewLine, '阻断依据来自最终 payload 的估算量')
  check(state.requests === 1, `阻断请求没有到达 provider（计数仍为 ${state.requests}）`)
  process.stdout.write(`pi prompt response: ${JSON.stringify({ success: large.success, error: large.error ?? null })}\n`)
  process.stdout.write(`data: ${root}\n`)
  process.stdout.write(`PASS: ${assertions} runtime assertions\n`)
} finally {
  for (const response of state.responses) response.destroy()
  await new Promise((resolve) => server.close(resolve))
  await rpc.close()
}
